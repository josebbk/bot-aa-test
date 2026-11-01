// Shared helpers for the Playwright traffic scripts.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(ROOT, 'site');
const LOG_FILE = path.join(ROOT, 'logs', 'visits.csv');
const HEADER = 'timestamp,group,visit,user_agent,clicked,http_status,variant,target_url,posthog_events_sent\n';
// In dry runs PostHog's library (array.js) is served from node_modules, so the page code
// still runs, but nothing at all goes out to PostHog.
const LOCAL_ARRAY_JS = path.join(ROOT, 'node_modules', 'posthog-js', 'dist', 'array.js');
const isPostHogHost = (hostname) => /(^|\.)posthog\.com$/i.test(hostname);
// posthog-js event capture endpoint (not /flags, /s/ session recordings, or script downloads).
const isCaptureRequest = (url) => isPostHogHost(url.hostname) && /^\/(e|i\/v0\/e|batch|capture)\/?$/.test(url.pathname);

export const DEFAULT_URL = 'https://josebbk.github.io/bot-aa-test/';
export const MAX_CONCURRENCY = 3;

// Current stable Chrome on Windows (reduced UA format), checked 2026-10-31.
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
export const REALISTIC_CONTEXT = { userAgent: CHROME_UA, viewport: { width: 1440, height: 900 }, locale: 'en-US' };

// Hides the signals posthog-js's bot check (isLikelyBot) reads in the browser:
// navigator.webdriver, and navigator.userAgentData brands when they say "HeadlessChrome".
// Changing the user agent alone does not change those brands.
export const HIDE_AUTOMATION_SCRIPT = `(() => {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  const real = navigator.userAgentData;
  if (real && real.brands.some((b) => /headless/i.test(b.brand))) {
    const brands = [
      { brand: 'Google Chrome', version: '157' },
      { brand: 'Chromium', version: '157' },
      { brand: 'Not:A-Brand', version: '24' },
    ];
    const low = { brands, mobile: false, platform: 'Windows' };
    const high = {
      ...low, architecture: 'x86', bitness: '64', model: '', platformVersion: '15.0.0',
      uaFullVersion: '157.0.8103.27', wow64: false,
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === 'Not:A-Brand' ? '24.0.0.0' : '157.0.8103.27' })),
    };
    const fake = {
      ...low,
      getHighEntropyValues: async (hints) => Object.fromEntries(Object.entries(high).filter(([k]) => k in low || hints.includes(k))),
      toJSON: () => low,
    };
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => fake, configurable: true });
  }
})();`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(rand(min, max + 1));

// Scrolls and moves the mouse for 4-12 s; clicks "Request a quote" with the given probability.
// Returns whether it clicked.
export async function browseLikeAVisitor(page, clickProbability) {
  const duration = rand(4000, 12000);
  const end = Date.now() + duration;
  const willClick = Math.random() < clickProbability;
  const clickAt = Date.now() + rand(1500, duration - 500);
  const button = page.getByRole('button', { name: 'Request a quote' });
  let clicked = false;

  while (Date.now() < end) {
    if (Math.random() < 0.5) {
      await page.mouse.move(randInt(40, 1400), randInt(40, 860), { steps: randInt(5, 25) });
    } else {
      await page.mouse.wheel(0, randInt(-250, 400));
    }
    if (willClick && !clicked && Date.now() >= clickAt) {
      await button.click();
      clicked = true;
    }
    await sleep(Math.max(0, Math.min(rand(300, 1200), end - Date.now())));
  }
  if (willClick && !clicked) {
    await button.click();
    clicked = true;
  }
  return clicked;
}

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
  const fields = [row.timestamp, row.group, row.visit, row.userAgent, row.clicked, row.status, row.variant, row.target, row.eventsSent];
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
 * Opens a fresh browser context (new anonymous visitor), optionally with an init script, and
 * starts counting the event requests that actually reach PostHog. Used by runBot and by one-off checks.
 */
export async function newVisitor(browser, { contextOptions = {}, initScript, dryRun = false, blocked } = {}) {
  const context = await browser.newContext(contextOptions);
  if (initScript) await context.addInitScript({ content: initScript });
  if (dryRun) {
    await context.route((url) => isPostHogHost(url.hostname), (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/static/array.js') && fs.existsSync(LOCAL_ARRAY_JS)) {
        if (blocked) blocked.servedLocally++;
        return route.fulfill({ path: LOCAL_ARRAY_JS, contentType: 'text/javascript' });
      }
      if (blocked) blocked.aborted++;
      return route.abort();
    });
  }
  const counter = { eventsSent: 0 };
  // requestfinished = the request got a response (aborted/failed requests are not counted).
  context.on('requestfinished', (req) => {
    if (isCaptureRequest(new URL(req.url()))) counter.eventsSent++;
  });
  return { context, counter };
}

export async function launchBrowser(dryRun) {
  // Dry run, belt and braces: PostHog hostnames also fail DNS inside the browser.
  return chromium.launch({ args: dryRun ? ['--host-resolver-rules=MAP *.posthog.com ~NOTFOUND'] : [] });
}

/**
 * One fresh browser context per visit (new anonymous visitor).
 * `behave(page)` does the bot-specific waiting/scrolling and returns whether it clicked.
 */
export async function runBot({ group, defaultCount, contextOptions = {}, initScript, behave }) {
  const opts = parseArgs(defaultCount);
  const server = opts.dryRun ? await serveSite() : null;
  const target = withGroup(server ? server.url : opts.url, group);
  const browser = await launchBrowser(opts.dryRun);
  const blocked = { aborted: 0, servedLocally: 0 };

  console.log(`${group}: ${opts.count} visit(s) to ${target}${opts.dryRun ? '  [dry run: PostHog blocked]' : ''}`);
  try {
    await runPool(opts.count, MAX_CONCURRENCY, async (n) => {
      const { context, counter } = await newVisitor(browser, { contextOptions, initScript, dryRun: opts.dryRun, blocked });
      const row = { timestamp: new Date().toISOString(), group, visit: n, userAgent: '', clicked: false, status: '', variant: '', target, eventsSent: '' };
      try {
        const page = await context.newPage();
        const response = await page.goto(target, { waitUntil: 'load', timeout: 30000 });
        row.status = response ? response.status() : '';
        row.userAgent = await page.evaluate(() => navigator.userAgent);
        row.clicked = await behave(page);
        // Give the flag up to 10 s to arrive before recording what the page shows.
        await page.waitForFunction(() => document.body.dataset.variant !== undefined, null, { timeout: 10000 }).catch(() => {});
        row.variant = await page.evaluate(() => document.body.dataset.variant ?? '');
        // Leave the page like a real visitor would, so PostHog flushes queued events on pagehide.
        await page.goto('about:blank');
        await sleep(1000);
      } catch (err) {
        row.status = row.status || 'error';
        console.error(`  #${n} failed: ${err.message.split('\n')[0]}`);
      } finally {
        row.eventsSent = counter.eventsSent;
        await context.close();
      }
      appendRow(row);
      console.log(`  #${n} status=${row.status} variant=${row.variant || '(empty)'} clicked=${row.clicked} posthog_events_sent=${row.eventsSent}`);
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
