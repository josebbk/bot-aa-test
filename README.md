# bot-aa-test

A small controlled demo of how bots and AI agents show up in an A/B test. The landing page for a fictional product ("Lumen Desk Lamp") runs a PostHog **A/A experiment**: both variants are identical, so any difference between them is noise. Several kinds of automated traffic, plus real people, are sent to the page so we can compare what PostHog counts, blocks and labels for each.

Live page: https://josebbk.github.io/bot-aa-test/

## Folder structure

```
site/index.html     the landing page (PostHog snippet, A/A flag `bot-aa-test`, events)
site/style.css      plain styling
bots/lib.mjs        shared Playwright runner: fresh context per visit, max 3 at once, CSV logging, --dry-run
bots/naive.mjs      group bot-naive: headless Chromium, default "HeadlessChrome" UA, never clicks
bots/disguised.mjs  group bot-disguised: headless Chromium posing as desktop Chrome 157, scrolls/moves mouse, clicks 30%
bots/nojs.sh        group bot-nojs: curl GET requests, no JavaScript
bots/serve.mjs      serves site/ on localhost (used by nojs.sh --dry-run)
bots/summary.mjs    ground-truth counts per group from logs/visits.csv
logs/visits.csv     one row per bot visit (created on first run, not committed)
.github/workflows/pages.yml  deploys site/ to GitHub Pages
```

## What the page sends to PostHog

- `$pageview` (captured manually), with super properties `traffic_group` (from `?g=`, default `direct`) and `is_webdriver` (`navigator.webdriver`) on every event.
- `$feature_flag_called` for `bot-aa-test` (the experiment exposure). The variant is stored on `<body data-variant="...">` (`none` if the flag didn't load).
- `cta_clicked` when "Request a quote" is clicked.
- `engaged_10s` once the page has been visible for 10 seconds.

PostHog's default settings are kept, including its default bot filtering.

## Setup (once)

```bash
npm install
npx playwright install chromium   # add --with-deps if system libraries are missing
```

## Running the traffic (live)

Run from this folder. Every visit is a new anonymous visitor, with at most 3 running at the same time.

```bash
node bots/naive.mjs                  # 150 visits, group bot-naive
node bots/disguised.mjs              # 150 visits, group bot-disguised
bash bots/nojs.sh                    # 50 requests, group bot-nojs
node bots/summary.mjs                # ground-truth counts per group
```

Options for every script: `--count N`, `--url URL` (default `https://josebbk.github.io/bot-aa-test/`), `--dry-run`.

`--dry-run` serves `site/` on `http://localhost:<port>` instead of the live URL. In the Playwright scripts every request to `*.posthog.com` is aborted (PostHog's library file is loaded from `node_modules` so the page code still runs), so a dry run never sends data to PostHog. Dry-run rows go to the same CSV; `summary.mjs` leaves them out unless you add `--include-dry-run`.

```bash
node bots/naive.mjs --dry-run --count 2
```

## Links for people and agents

| Who | Link |
| --- | --- |
| Humans (share this one) | https://josebbk.github.io/bot-aa-test/?g=human |
| QA (your own setup checks) | https://josebbk.github.io/bot-aa-test/?g=qa |
| AI agents | `https://josebbk.github.io/bot-aa-test/?g=agent-<name>`, e.g. `?g=agent-claude-browser`, `?g=agent-chatgpt` |

Visits without `?g=` are tagged `direct`.

## CSV columns (`logs/visits.csv`)

`timestamp, group, visit, user_agent, clicked, http_status, variant, target_url`. `variant` is what the bot saw on the page (`control`, `test`, `none`), and is empty for curl.
