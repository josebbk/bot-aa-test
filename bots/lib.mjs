// Shared helpers for the Playwright traffic scripts.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(ROOT, 'site');
const LOG_FILE = path.join(ROOT, 'logs', 'visits.csv');
const HEADER = 'timestamp,group,visit,user_agent,clicked,http_status,variant,target_url\n';
// In dry runs PostHog's library (array.js) is served from node_modules, so the page code
// still runs, but nothing at all goes out to PostHog.
const LOCAL_ARRAY_JS = path.join(ROOT, 'node_modules', 'posthog-js', 'dist', 'array.js');
const isPostHogHost = (hostname) => /(^|\.)posthog\.com$/i.test(hostname);

export const DEFAULT_URL = 'https://josebbk.github.io/bot-aa-test/';
export const MAX_CONCURRENCY = 3;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(rand(min, max + 1));

export function parseArgs(defaultCount) {
  const opts = { count: defaultCount, url: DEFAULT_URL, dryRun: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count') opts.count = Number(args[++i]);
    else if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else {
      console.error(`Unknown option: ${args[i]}\nUsage: [--count N] [--url URL] [--dry-run]`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.count) || opts.count < 1) {
    console.error('--count must be a positive integer');
    process.exit(1);
  }
  return opts;
}

export function withGroup(url, group) {
  const u = new URL(url);
  u.searchParams.set('g', group);
  return u.toString();
}

// Minimal static server for site/ (used by --dry-run).
export function serveSite() {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(SITE_DIR, path.normalize(p));
    if (!file.startsWith(SITE_DIR + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, 'localhost', () =>
      resolve({
        url: `http://localhost:${server.address().port}/`,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

function csv(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function appendRow(row) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, HEADER);
  const fields = [row.timestamp, row.group, row.visit, row.userAgent, row.clicked, row.status, row.variant, row.target];
  fs.appendFileSync(LOG_FILE, fields.map(csv).join(',') + '\n');
}

// Runs visits 1..count with at most `concurrency` in flight and a small random pause after each.
async function runPool(count, concurrency, fn) {
  let next = 1;
  const worker = async () => {
    while (next <= count) {
      const n = next++;
      await fn(n);
      await sleep(rand(500, 2500));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
}

/**
 * One fresh browser context per visit (new anonymous visitor).
 * `behave(page)` does the bot-specific waiting/scrolling and returns whether it clicked.
 */
export async function runBot({ group, defaultCount, contextOptions = {}, behave }) {
  const opts = parseArgs(defaultCount);
  const server = opts.dryRun ? await serveSite() : null;
  const target = withGroup(server ? server.url : opts.url, group);

  // Dry run, belt and braces: PostHog hostnames also fail DNS inside the browser.
  const browser = await chromium.launch({
    args: opts.dryRun ? ['--host-resolver-rules=MAP *.posthog.com ~NOTFOUND'] : [],
  });
  const blocked = { aborted: 0, servedLocally: 0 };

  console.log(`${group}: ${opts.count} visit(s) to ${target}${opts.dryRun ? '  [dry run: PostHog blocked]' : ''}`);
  try {
    await runPool(opts.count, MAX_CONCURRENCY, async (n) => {
      const context = await browser.newContext(contextOptions);
      if (opts.dryRun) {
        await context.route((url) => isPostHogHost(url.hostname), (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.endsWith('/static/array.js') && fs.existsSync(LOCAL_ARRAY_JS)) {
            blocked.servedLocally++;
            return route.fulfill({ path: LOCAL_ARRAY_JS, contentType: 'text/javascript' });
          }
          blocked.aborted++;
          return route.abort();
        });
      }

      const row = { timestamp: new Date().toISOString(), group, visit: n, userAgent: '', clicked: false, status: '', variant: '', target };
      try {
        const page = await context.newPage();
        const response = await page.goto(target, { waitUntil: 'load', timeout: 30000 });
        row.status = response ? response.status() : '';
        row.userAgent = await page.evaluate(() => navigator.userAgent);
        row.clicked = await behave(page);
        row.variant = await page.evaluate(() => document.body.dataset.variant ?? '');
        // Leave the page like a real visitor would, so PostHog flushes queued events on pagehide.
        await page.goto('about:blank');
        await sleep(500);
      } catch (err) {
        row.status = row.status || 'error';
        console.error(`  #${n} failed: ${err.message.split('\n')[0]}`);
      } finally {
        await context.close();
      }
      appendRow(row);
      console.log(`  #${n} status=${row.status} variant=${row.variant || '(empty)'} clicked=${row.clicked}`);
    });
  } finally {
    await browser.close();
    if (server) await server.close();
  }
  if (opts.dryRun) {
    console.log(`Dry run: ${blocked.aborted} PostHog request(s) aborted, array.js served locally ${blocked.servedLocally} time(s).`);
  }
  console.log(`Logged to ${path.relative(process.cwd(), LOG_FILE)}`);
}
