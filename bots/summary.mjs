// Prints ground-truth counts per group from logs/visits.csv.
// Dry-run rows (target on localhost) are left out unless you pass --include-dry-run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'visits.csv');
const includeDry = process.argv.includes('--include-dry-run');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

if (!fs.existsSync(LOG_FILE)) {
  console.log('No visits logged yet (logs/visits.csv not found).');
  process.exit(0);
}

const [header, ...data] = parseCsv(fs.readFileSync(LOG_FILE, 'utf8'));
let records = data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
const dryCount = records.filter((r) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(r.target_url)).length;
if (!includeDry) records = records.filter((r) => !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(r.target_url));

const variants = [...new Set(records.map((r) => r.variant || '(empty)'))].sort();
const groups = new Map();
for (const r of records) {
  const g = groups.get(r.group) ?? { visits: 0, ok: 0, clicks: 0, variants: {}, measured: 0, eventRequests: 0, visitsWithEvents: 0 };
  g.visits++;
  if (/^2\d\d$/.test(r.http_status)) g.ok++;
  if (r.clicked === 'true') g.clicks++;
  // posthog_events_sent is empty for rows logged before the column existed (not measured).
  if (r.posthog_events_sent !== undefined && r.posthog_events_sent !== '') {
    const sent = Number(r.posthog_events_sent);
    g.measured++;
    g.eventRequests += sent;
    if (sent > 0) g.visitsWithEvents++;
  }
  const v = r.variant || '(empty)';
  g.variants[v] = (g.variants[v] ?? 0) + 1;
  groups.set(r.group, g);
}

const table = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, g]) => ({
  group,
  visits: g.visits,
  'http 2xx': g.ok,
  clicks: g.clicks,
  'click rate': g.visits ? `${((g.clicks / g.visits) * 100).toFixed(1)}%` : '-',
  ...Object.fromEntries(variants.map((v) => [`variant: ${v}`, g.variants[v] ?? 0])),
  'posthog event requests': g.measured ? g.eventRequests : 'not measured',
  'visits sending events': g.measured ? `${g.visitsWithEvents} of ${g.measured}` : 'not measured',
}));

console.log(`Ground truth from ${path.relative(process.cwd(), LOG_FILE)}${includeDry ? ' (including dry runs)' : ''}`);
if (table.length) console.table(table);
else console.log('No live visits logged yet.');
if (!includeDry && dryCount) console.log(`(${dryCount} dry-run row(s) excluded; add --include-dry-run to see them)`);
console.log('posthog event requests = requests to PostHog\'s capture endpoint that got a response (one request can carry several events).');
console.log('"not measured" = rows logged before the posthog_events_sent column was added.');
