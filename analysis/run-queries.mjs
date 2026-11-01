// Runs the analysis queries against PostHog's query API (HogQL) and saves each result as CSV
// in analysis/results/. The personal API key is read from .env and never printed.
//
//   node analysis/run-queries.mjs                 run every named query, save CSVs
//   node analysis/run-queries.mjs q1_groups ...   run only the named queries
//   node analysis/run-queries.mjs --sql "SELECT …"  ad-hoc query, printed, not saved
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(ROOT, 'analysis', 'results');
const HOST = 'https://eu.posthog.com';
const PROJECT_ID = 329014;

function readKey() {
  const envFile = path.join(ROOT, '.env');
  const line = fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('POSTHOG_PERSONAL_API_KEY='));
  const key = line ? line.slice('POSTHOG_PERSONAL_API_KEY='.length).trim() : process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY not found in .env');
  return key;
}
const KEY = readKey();

// Sends any query object to the query endpoint and returns the raw JSON response.
async function rawQuery(queryObject, name, refresh = 'blocking') {
  const res = await fetch(`${HOST}/api/projects/${PROJECT_ID}/query/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query: queryObject, name, refresh }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.replaceAll(KEY, '***').slice(0, 800)}`);
  return JSON.parse(text);
}

export async function query(sql, name = 'bot_aa_adhoc') {
  const json = await rawQuery({ kind: 'HogQLQuery', query: sql }, name);
  return { columns: json.columns, rows: json.results };
}

function toCsv({ columns, rows }) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Named queries. {SINCE} is replaced by the experiment's start date (read from system.experiments).
// ---------------------------------------------------------------------------------------------
const EXPERIMENT_NAME = 'Bot A/A test';
const FLAG = 'bot-aa-test';

// One row per exposed visitor with the variant PostHog's experiment results use:
// $feature_flag_response on $experiment_exposure.
// perPerson = false: one row per (person, traffic group); clicks/engagement only from the same group.
// perPerson = true:  one row per person, counting their clicks/engagement from any visit, which is
//                    how PostHog's experiment page attributes metrics.
const exposedVisitors = (where = '1 = 1', { perPerson = false } = {}) => {
  const group = perPerson ? `'all' AS traffic_group` : 'properties.traffic_group AS traffic_group';
  const groupBy = perPerson ? 'person_id' : 'person_id, traffic_group';
  const on = perPerson ? 'exposed.person_id = acts.person_id' : 'exposed.person_id = acts.person_id AND exposed.traffic_group = acts.traffic_group';
  return `
  WITH exposed AS (
    SELECT person_id, ${group},
           argMin(properties.$feature_flag_response, timestamp) AS variant,
           count(DISTINCT properties.$feature_flag_response) AS variants_seen
    FROM events
    WHERE event = '$experiment_exposure' AND properties.$feature_flag = '${FLAG}' AND timestamp >= {SINCE}
    GROUP BY ${groupBy}
  ),
  acts AS (
    SELECT person_id, ${group},
           countIf(event = 'cta_clicked') AS clicks, countIf(event = 'engaged_10s') AS engaged
    FROM events
    WHERE event IN ('cta_clicked', 'engaged_10s') AND timestamp >= {SINCE}
    GROUP BY ${groupBy}
  )
  SELECT exposed.traffic_group AS traffic_group, exposed.person_id AS person_id, exposed.variant AS variant,
         exposed.variants_seen AS variants_seen, coalesce(acts.clicks, 0) AS clicks, coalesce(acts.engaged, 0) AS engaged
  FROM exposed
  LEFT JOIN acts ON ${on}
  WHERE ${where}`;
};

const experimentResult = (where, opts) => `
  SELECT variant,
         count(DISTINCT person_id) AS exposed_visitors,
         countIf(clicks > 0) AS visitors_who_clicked,
         sum(clicks) AS cta_clicks,
         round(100 * countIf(clicks > 0) / count(DISTINCT person_id), 1) AS click_rate_pct,
         countIf(engaged > 0) AS visitors_engaged_10s,
         round(100 * countIf(engaged > 0) / count(DISTINCT person_id), 1) AS engaged_rate_pct
  FROM (${exposedVisitors(where, opts)})
  GROUP BY variant ORDER BY variant`;

export const QUERIES = {
  q0_experiment: `SELECT name, start_date, end_date, id, feature_flag_id FROM system.experiments WHERE name = '${EXPERIMENT_NAME}'`,

  // 1. Per traffic group: unique visitors and event counts.
  q1_groups: `
    SELECT properties.traffic_group AS traffic_group,
           count(DISTINCT distinct_id) AS unique_visitors,
           countIf(event = '$pageview') AS pageview,
           countIf(event = '$feature_flag_called' AND properties.$feature_flag = '${FLAG}') AS feature_flag_called,
           countIf(event = '$experiment_exposure' AND properties.$feature_flag = '${FLAG}') AS experiment_exposure,
           countIf(event = 'cta_clicked') AS cta_clicked,
           countIf(event = 'engaged_10s') AS engaged_10s
    FROM events WHERE timestamp >= {SINCE}
    GROUP BY traffic_group ORDER BY unique_visitors DESC`,

  // 2. Per traffic group and variant: exposures and clicks.
  q2_group_variant: `
    SELECT traffic_group, variant,
           count() AS exposed_visitors,
           countIf(clicks > 0) AS visitors_who_clicked,
           sum(clicks) AS cta_clicks,
           countIf(variants_seen > 1) AS saw_both_variants
    FROM (${exposedVisitors()})
    GROUP BY traffic_group, variant ORDER BY traffic_group, variant`,

  // 3a. Visitors with a pageview but no exposure, per group.
  q3_pageview_without_exposure: `
    SELECT traffic_group, count() AS visitors_with_pageview, countIf(exposures = 0) AS pageview_but_no_exposure
    FROM (
      SELECT distinct_id, properties.traffic_group AS traffic_group,
             countIf(event = '$pageview') AS pageviews, countIf(event = '$experiment_exposure') AS exposures
      FROM events WHERE timestamp >= {SINCE} GROUP BY distinct_id, traffic_group
    )
    WHERE pageviews > 0 GROUP BY traffic_group ORDER BY traffic_group`,

  // 3b. Every bot-stealth visitor PostHog received (matched to logs/visits.csv after the query runs).
  q3_stealth_visitors: `
    SELECT distinct_id,
           minIf(timestamp, event = '$pageview') AS pageview_time,
           anyIf(properties.$feature_flag_response, event = '$experiment_exposure') AS variant,
           countIf(event = '$experiment_exposure') AS exposures,
           countIf(event = 'cta_clicked') AS cta_clicked,
           countIf(event = 'engaged_10s') AS engaged_10s,
           countIf(event = '$pageview') AS pageviews,
           count() AS events,
           max(dateDiff('second', timestamp, created_at)) AS max_ingestion_delay_s,
           min(created_at) AS first_ingested_at,
           max(created_at) AS last_ingested_at
    FROM events WHERE properties.traffic_group = 'bot-stealth'
    GROUP BY distinct_id ORDER BY pageview_time LIMIT 1000`,

  // 4. PostHog's own bot classification and device details, per group (pageviews).
  q4_bot_detection: `
    SELECT properties.traffic_group AS traffic_group,
           properties.$virt_is_bot AS is_bot,
           properties.$virt_traffic_type AS traffic_type,
           properties.$virt_traffic_category AS traffic_category,
           properties.$virt_bot_name AS bot_name,
           properties.$browser AS browser,
           properties.$os AS os,
           properties.$device_type AS device_type,
           properties.$geoip_country_code AS country,
           properties.is_webdriver AS is_webdriver,
           count() AS pageviews,
           count(DISTINCT distinct_id) AS visitors
    FROM events WHERE event = '$pageview' AND timestamp >= {SINCE}
    GROUP BY traffic_group, is_bot, traffic_type, traffic_category, bot_name, browser, os, device_type, country, is_webdriver
    ORDER BY traffic_group, pageviews DESC`,

  // 5. Every event from the unknown traffic group "WyDAc" (all time).
  q5_wydac: `
    SELECT timestamp, event, distinct_id,
           properties.$browser AS browser, properties.$browser_version AS browser_version,
           properties.$os AS os, properties.$os_version AS os_version, properties.$device_type AS device_type,
           properties.$geoip_country_name AS country, properties.$geoip_city_name AS city,
           properties.$timezone AS timezone, properties.$browser_language AS language,
           properties.$referrer AS referrer, properties.$current_url AS url,
           properties.$screen_width AS screen_w, properties.$screen_height AS screen_h,
           properties.$viewport_width AS viewport_w, properties.$viewport_height AS viewport_h,
           properties.is_webdriver AS is_webdriver, properties.$feature_flag_response AS variant,
           properties.$virt_is_bot AS is_bot, properties.$virt_traffic_type AS traffic_type,
           properties.$raw_user_agent AS user_agent
    FROM events WHERE properties.traffic_group LIKE 'WyDAc%' ORDER BY timestamp`,

  // 6. Experiment result three ways. (c) counts per person, like the experiment page.
  q6a_human_only: experimentResult(`exposed.traffic_group = 'human'`),
  q6b_human_and_stealth: experimentResult(`exposed.traffic_group IN ('human', 'bot-stealth')`),
  q6c_everything: experimentResult('1 = 1', { perPerson: true }),

  // 7. Late arrivals: bot-stealth visitors by their slowest event's ingestion delay.
  q7_stealth_late_arrivals: `
    SELECT multiIf(d < 10, '1: under 10 s', d < 60, '2: 10-60 s', d < 300, '3: 1-5 min', d < 3600, '4: 5-60 min', '5: over 1 h') AS slowest_event_delay,
           count() AS visitors, max(last_arrival) AS latest_arrival
    FROM (SELECT distinct_id, max(dateDiff('second', timestamp, created_at)) AS d, max(created_at) AS last_arrival
          FROM events WHERE properties.traffic_group = 'bot-stealth' GROUP BY distinct_id)
    GROUP BY slowest_event_delay ORDER BY slowest_event_delay`,

  // 8. Groups that should have sent nothing (all time).
  q8_should_be_empty: `
    SELECT countIf(properties.traffic_group = 'bot-nojs') AS bot_nojs,
           countIf(properties.traffic_group = 'agent-claude-webfetch') AS agent_claude_webfetch,
           countIf(properties.traffic_group = 'agent-chatgpt') AS agent_chatgpt,
           countIf(properties.traffic_group = 'bot-naive') AS bot_naive,
           countIf(properties.traffic_group = 'bot-disguised') AS bot_disguised
    FROM events WHERE timestamp >= '2026-10-31'`,

  // 9a. Every event from the Claude-in-Chrome agent visits.
  q9a_agent_chrome_events: `
    SELECT timestamp, properties.traffic_group AS traffic_group, event, distinct_id, properties.$session_id AS session_id,
           coalesce(properties.$feature_flag_response, properties.\`$feature/bot-aa-test\`) AS variant,
           properties.is_webdriver AS is_webdriver, properties.$browser AS browser, properties.$browser_version AS browser_version,
           properties.$os AS os, properties.$device_type AS device_type, properties.$geoip_country_code AS country,
           properties.$virt_is_bot AS is_bot, properties.$virt_traffic_type AS traffic_type, properties.$referrer AS referrer
    FROM events WHERE properties.traffic_group LIKE 'agent-claude-chrome%' ORDER BY timestamp`,

  // 9b. Every traffic group seen on the visitor IDs (and persons) the agent visits used.
  q9b_agent_shared_ids: `
    SELECT distinct_id, properties.traffic_group AS traffic_group, count() AS events,
           countIf(event = '$experiment_exposure') AS exposures, countIf(event = 'cta_clicked') AS clicks,
           min(timestamp) AS first_event, max(timestamp) AS last_event
    FROM events
    WHERE person_id IN (SELECT person_id FROM events WHERE properties.traffic_group LIKE 'agent-claude-chrome%')
    GROUP BY distinct_id, traffic_group ORDER BY first_event`,

  // 10. Pageviews that came with utm_source=chatgpt.com (all time).
  q10_utm_chatgpt: `
    SELECT timestamp, properties.traffic_group AS traffic_group, properties.$current_url AS url, properties.utm_source AS utm_source
    FROM events
    WHERE event = '$pageview' AND timestamp >= '2026-10-31'
      AND (properties.$current_url LIKE '%utm_source=chatgpt.com%' OR properties.utm_source = 'chatgpt.com')
    ORDER BY timestamp`,

  // 12. Every event PostHog ingested after the previous pull started (created_at = ingestion time).
  q12_new_since_previous_pull: `
    SELECT timestamp AS event_time_browser, created_at AS ingested_at,
           dateDiff('second', timestamp, created_at) AS ingestion_delay_s,
           event, properties.traffic_group AS traffic_group,
           coalesce(properties.$feature_flag_response, properties.\`$feature/bot-aa-test\`) AS variant,
           distinct_id, properties.$session_id AS session_id
    FROM events WHERE created_at > {PREV_PULL}
    ORDER BY ingested_at, event_time_browser LIMIT 5000`,
};

// The pull RESULTS.md was first written from (start of that run, from the result files' times).
const PREVIOUS_PULL = '2026-11-01T19:20:41Z';
const sqlTime = (iso) => `toDateTime('${iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '')}', 'UTC')`;

// PostHog's own experiment exposure calculation (exposure totals and sample-ratio check).
const EXPERIMENT_EXPOSURE_QUERY = (experimentId, flagId, start) => ({
  kind: 'ExperimentExposureQuery',
  experiment_id: experimentId,
  experiment_name: EXPERIMENT_NAME,
  feature_flag: { key: FLAG, id: flagId, filters: { multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] } } },
  start_date: start,
  end_date: null,
});

// Matches each bot-stealth visit in logs/visits.csv to a PostHog visitor: same variant, same
// clicked yes/no, pageview within 15 s after the logged visit start (nearest first).
function matchStealthVisits({ columns, rows }) {
  const ph = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))).map((p) => ({ ...p, t: Date.parse(p.pageview_time), used: false }));
  const parse = (line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].map((m) => m[1].replace(/^"|"$/g, '').replace(/""/g, '"'));
  const [header, ...lines] = fs.readFileSync(path.join(ROOT, 'logs', 'visits.csv'), 'utf8').trim().split('\n');
  const cols = parse(header);
  const visits = lines.map(parse).map((f) => Object.fromEntries(cols.map((c, i) => [c, f[i]])))
    .filter((v) => v.group === 'bot-stealth' && !/localhost/.test(v.target_url))
    .map((v) => ({ ...v, t: Date.parse(v.timestamp) })).sort((a, b) => a.t - b.t);
  const out = [['visit', 'logged_start', 'logged_variant', 'logged_clicked', 'logged_event_requests', 'found_in_posthog',
    'arrived_after_previous_pull', 'posthog_distinct_id', 'posthog_pageview_time', 'posthog_pageviews', 'posthog_exposures',
    'posthog_engaged_10s', 'posthog_cta_clicked', 'posthog_first_ingested_at', 'posthog_last_ingested_at', 'posthog_max_ingestion_delay_s']];
  // Pass 1: same variant and click, pageview within 3 s of the logged start (normally ~0.5 s).
  // Pass 2: same, within 15 s. Pass 3: same variant, click not required, within 15 s, so a visit that
  // arrived without its click is reported as "yes, click missing" instead of as missing.
  const passes = [
    { ms: 3000, needClick: true, label: 'yes' },
    { ms: 15000, needClick: true, label: 'yes' },
    { ms: 15000, needClick: false, label: 'yes, click missing' },
  ];
  const matchOf = new Map();
  for (const pass of passes) {
    for (const v of visits) {
      if (matchOf.has(v)) continue;
      const clicked = v.clicked === 'true';
      const m = ph.filter((p) => !p.used && p.variant === v.variant && (!pass.needClick || (p.cta_clicked > 0) === clicked)
        && p.t >= v.t && p.t <= v.t + pass.ms).sort((a, b) => a.t - b.t)[0];
      if (m) { m.used = true; matchOf.set(v, { m, label: pass.label }); }
    }
  }
  for (const v of visits) {
    const { m, label } = matchOf.get(v) ?? {};
    const late = m ? (Date.parse(m.first_ingested_at) > Date.parse(PREVIOUS_PULL) ? 'yes' : 'no') : '';
    out.push([v.visit, v.timestamp, v.variant, v.clicked, v.posthog_events_sent, label ?? 'no', late,
      m?.distinct_id ?? '', m?.pageview_time ?? '', m?.pageviews ?? '', m?.exposures ?? '', m?.engaged_10s ?? '', m?.cta_clicked ?? '',
      m?.first_ingested_at ?? '', m?.last_ingested_at ?? '', m?.max_ingestion_delay_s ?? '']);
  }
  const missing = out.slice(1).filter((r) => r[5] === 'no');
  const late = out.slice(1).filter((r) => r[6] === 'yes');
  const noClick = out.slice(1).filter((r) => r[5] === 'yes, click missing');
  return {
    table: { columns: out[0], rows: out.slice(1) },
    note: `matched ${visits.length - missing.length} of ${visits.length} logged visits (${late.length} first ingested after the previous pull, ` +
      `${noClick.length} arrived without their logged click); ` +
      `${missing.length} not in PostHog (${missing.filter((r) => r[3] === 'true').length} of them clicked); ` +
      `unmatched PostHog visitors: ${ph.filter((p) => !p.used).length}`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--sql') {
    const r = await query(args[1]);
    console.log(r.columns.join(' | '));
    for (const row of r.rows) console.log(row.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v)).join(' | '));
    console.log(`(${r.rows.length} rows)`);
    return;
  }
  // --cutoff ISO: count only events PostHog had ingested by then (created_at). Default: now.
  let cutoff = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const ci = args.indexOf('--cutoff');
  if (ci >= 0) { cutoff = args[ci + 1]; args.splice(ci, 2); }
  const names = args.length ? args : Object.keys(QUERIES);
  const outDir = path.join(RESULTS_DIR, `pull-${cutoff.replaceAll(':', '-')}`);
  const rel = (f) => path.relative(ROOT, path.join(outDir, f));
  fs.mkdirSync(outDir, { recursive: true });
  const exp = await query(QUERIES.q0_experiment, 'bot_aa_q0_experiment');
  if (!exp.rows.length) throw new Error(`Experiment "${EXPERIMENT_NAME}" not found`);
  const since = sqlTime(exp.rows[0][exp.columns.indexOf('start_date')]);
  console.log(`Experiment start: ${exp.rows[0][1]} | cutoff (ingested by): ${cutoff} | previous pull: ${PREVIOUS_PULL}`);
  fs.writeFileSync(path.join(outDir, 'pull_info.csv'), toCsv({
    columns: ['cutoff_ingested_by_utc', 'previous_pull_utc', 'experiment_start_utc', 'run_started_utc'],
    rows: [[cutoff, PREVIOUS_PULL, exp.rows[0][1], new Date().toISOString()]],
  }));
  for (const name of names) {
    if (!QUERIES[name]) throw new Error(`Unknown query: ${name}`);
    const sql = QUERIES[name]
      .replace(/FROM events(\s+)WHERE /g, 'FROM events$1WHERE created_at <= {CUTOFF} AND ')
      .replaceAll('{SINCE}', since).replaceAll('{CUTOFF}', sqlTime(cutoff)).replaceAll('{PREV_PULL}', sqlTime(PREVIOUS_PULL));
    const r = await query(sql, `bot_aa_${name}`);
    fs.writeFileSync(path.join(outDir, `${name}.csv`), toCsv(r));
    console.log(`${name}: ${r.rows.length} rows -> ${rel(`${name}.csv`)}`);
    if (name === 'q3_stealth_visitors') {
      const { table, note } = matchStealthVisits(r);
      fs.writeFileSync(path.join(outDir, 'q3_visit_matching.csv'), toCsv(table));
      console.log(`q3_visit_matching: ${note} -> ${rel('q3_visit_matching.csv')}`);
    }
  }

  // 11. PostHog's own exposure totals and sample-ratio check (only on a full run). This is PostHog's
  // live calculation: it cannot be limited to the ingestion cutoff, so its own refresh time is recorded.
  if (!args.length) {
    const col = (c) => exp.rows[0][exp.columns.indexOf(c)];
    const r = await rawQuery(EXPERIMENT_EXPOSURE_QUERY(col('id'), col('feature_flag_id'), col('start_date')), 'bot_aa_q11_experiment_exposure', 'force_blocking'); // skip PostHog's 24 h result cache
    const srm = r.sample_ratio_mismatch ?? {};
    const srmCheck = (r.health_checks ?? []).find((h) => h.key === 'srm');
    const rows = Object.entries(r.total_exposures ?? {}).sort().map(([variant, n]) =>
      [variant, n, srm.expected?.[variant] ?? '', srm.p_value ?? '', srmCheck?.status ?? '', r.last_refresh ?? '', r.is_cached ?? '']);
    fs.writeFileSync(path.join(outDir, 'q11_experiment_exposure.csv'),
      toCsv({ columns: ['variant', 'posthog_exposures', 'srm_expected', 'srm_p_value', 'srm_check_status', 'posthog_calculated_at', 'served_from_cache'], rows }));
    console.log(`q11_experiment_exposure: ${rows.length} rows -> ${rel('q11_experiment_exposure.csv')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
