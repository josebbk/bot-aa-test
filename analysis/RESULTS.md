# Bots in an A/A test: results

A controlled demonstration of how automated traffic and AI agents show up in a PostHog A/B test, using an **A/A experiment** (two identical variants, so the true difference is zero). All times are UTC. Data was pulled from PostHog on 1 Nov 2026, about 19:20.

## 1. Method

### Page
- A fictional landing page ("Lumen Desk Lamp") on GitHub Pages: a heading, two paragraphs, one "Request a quote" button and a footer. There are no forms, and the page is set to `noindex`.
- Clicking the button records an event and replaces the button with "Thanks, this is a demo page."
- Both variants render exactly the same page. The variant is only written to `<body data-variant>`.

### PostHog setup
- **Library:** posthog-js **1.444.0**, loaded with PostHog's official web snippet and `defaults: '2026-08-30'`. It's hosted in the EU.
- **Bot filtering:** left at PostHog's defaults. `opt_out_useragent_filter` was not set and nothing else related to bots was changed.
- **Pageviews:** captured manually (`capture_pageview: false`, then `$pageview`).
- **Traffic labels:** every event carries two super properties:
  - `traffic_group`, read from the URL parameter `?g=`;
  - `is_webdriver`, the browser's `navigator.webdriver` value.
- **Experiment:** "Bot A/A test" on flag **`bot-aa-test`**, variants `control` and `test` at **50/50**. It launched on **31 Oct 2026 at 19:49**.
  - **Exposure:** `getFeatureFlag('bot-aa-test')` inside `onFeatureFlags`, which emits `$feature_flag_called` and `$experiment_exposure`.
  - **Metrics:** `cta_clicked` (button click) and `engaged_10s` (fires once after 10 s of the page being visible).

### Dates
| What | When |
|---|---|
| Experiment launch | 31 Oct, 19:49 |
| QA checks by the author | 31 Oct, 19:49–20:11 |
| Human visits | 31 Oct 20:15 – 1 Nov 09:13 |
| bot-naive run | 1 Nov, 17:09–17:15 |
| bot-disguised run | 1 Nov, 18:15–18:17 |
| bot-stealth run | 1 Nov, 18:17–18:27 |
| bot-nojs run | 1 Nov, 19:05–19:06 |
| Claude in Chrome visits | 1 Nov, 19:08 and 19:14 |

### Traffic groups
The scripted bots used Playwright 1.64 with headless Chromium 156. Each visit opened a fresh browser context, so every visit was a new anonymous visitor. At most 3 visits ran at once, with short random pauses between them. All bots ran from one VPS, which PostHog geolocates to Germany.

| Group | Count | Behaviour | User agent | Automation signals visible to the page |
|---|---|---|---|---|
| bot-naive | 150 | Loads the page, waits 2–6 s, never clicks | Playwright default: `HeadlessChrome/156` on Linux | `navigator.webdriver = true`; browser brand "HeadlessChrome" |
| bot-disguised | 30 | Mouse movement and scrolling for 4–12 s; clicks on 30% of visits | Real-looking Chrome 157 on Windows; 1440×900; en-US | `navigator.webdriver = true`; browser brand still "HeadlessChrome" (changing the user agent does not change it) |
| bot-stealth | 150 | Same as bot-disguised | Same as bot-disguised | Hidden by a script injected into the page: `webdriver = false`, brands set to "Google Chrome 157". The `sec-ch-ua` request header still said HeadlessChrome |
| bot-nojs | 50 | `curl` GET requests; no JavaScript runs | `curl/8.5.0` | n/a |
| human | 12 visitors | People the author sent a link to, cooperative and unscripted | Their own browsers | none |
| qa | 6 visitors | The author's own setup checks | Author's Chrome | none |
| agent-claude-webfetch | manual test | Claude's web-fetch tool asked to visit `?g=agent-claude-webfetch` | the tool's own | n/a |
| agent-chatgpt | manual test | Free ChatGPT asked to visit `?g=agent-chatgpt` | the tool's own | n/a |
| agent-claude-chrome, agent-claude-chrome-2 | 1 visit each | Claude in Chrome (browser extension) asked to visit and use the page, in the author's own Chrome | Author's Chrome 156, Windows | `webdriver = false` |

Short diagnostic visits (`diag-*`) were also made while investigating. They are reported separately and left out of the comparisons.

## 2. Ground truth vs what PostHog received

"Ground truth" is the bot's own log of what it did. PostHog figures cover everything received for that group.

| Group | Visits (ground truth) | Visitors in PostHog | Events in PostHog | Exposures | Clicks: ground truth → PostHog |
|---|---|---|---|---|---|
| bot-naive | 150 | 0 | **0** | 0 | 0 → 0 |
| bot-disguised | 30 | 0 | **0** | 0 | 10 → **0** |
| bot-stealth | 150 | **136** | 685 | **136** | 56 → **49** |
| bot-nojs | 50 | 0 | **0** | 0 | 0 → 0 |
| agent-claude-webfetch | manual | 0 | **0** | 0 | – |
| agent-chatgpt | manual | 0 | **0** | 0 | – |
| agent-claude-chrome (+ -2) | 2 | 1 (author's own browser) | 10 | **0** (see §6) | 2 → 2 |
| human | – | 12 | 100 | 11 | – → 11 |
| qa | – | 6 | 33 | 6 | – → 0 |

The two visits with an altered `?g=` value (§8) sent 3 events each, with 1 exposure each.

- **Every bot that announced itself, by user agent, browser brand or the webdriver flag, was invisible in PostHog.**
- The stealth bots, which hid those signals, were counted as normal visitors. 136 of 150 arrived (§7).
- **Bots that don't run JavaScript** (curl, the web-fetch tool, free ChatGPT) **never reach PostHog at all.** This is because PostHog only records visits through code that runs in the browser.

## 3. How each bot tier was stopped, or not

### In the browser: posthog-js drops the events before sending them
In posthog-js 1.444.0, `capture()` checks `this._is_bot()` before sending anything, unless `opt_out_useragent_filter` is set. `_is_bot()` calls the library's bot test, `isLikelyBot`, which appears as `Ou` in the minified bundle. That test returns *bot* if any of these is true:
1. the user agent matches PostHog's bot list (e.g. "headless");
2. any `navigator.userAgentData.brands` entry matches that list (e.g. "HeadlessChrome");
3. `navigator.webdriver` is true.

When it says *bot*, the event is dropped with the message "Event … was not captured because the user agent looks like a bot". The same `_is_bot()` check also stops PostHog's web-experiment page changes.

- **bot-naive** failed all three tests.
- **bot-disguised** passed test 1 but failed tests 2 and 3. Changing the user agent alone was not enough.
- **bot-stealth** passed all three and was treated as a person.

### On the server: the flag answer was empty for a headless user agent
posthog-js does **not** block the feature-flag request itself. The function that sends `POST /flags/?v=2` has no bot check, so every Playwright visit asked for its flags. The answers differed by user agent:

| | Headless user agent (`HeadlessChrome/156`) | Realistic user agent (Chrome 157) |
|---|---|---|
| HTTP status | 200 | 200 |
| Error flag | `errorsWhileComputingFlags: false` | `errorsWhileComputingFlags: false` |
| Flags returned | **none**: `"flags": {}` | `bot-aa-test` = control/test ("Matched condition set 1") |
| Other | adds `sessionRecording: false` and a small `config` block | – |
| Page shows | `none` (all 150 naive visits) | a real variant (all 30 disguised visits) |

The browser-brand header (`sec-ch-ua`) said HeadlessChrome in both cases, so PostHog's server appears to decide on the `User-Agent` header. That is inferred from the two answers; PostHog's server code was not inspected.

**Consequence:** naive bots were never given a variant, while disguised bots were. Disguised bots still sent nothing, because the browser-side check dropped their events.

## 4. The experiment result, three ways

Exposed visitors and conversions per variant. In an A/A test both columns should match, apart from noise.

**(a) Humans only** (events tagged `human`)
| Variant | Exposed | Clicked | Click rate | Engaged 10 s | Engaged rate |
|---|---|---|---|---|---|
| control | 8 | 6 | 75.0% | 7 | 87.5% |
| test | 3 | 1 | 33.3% | 3 | 100% |

**(b) Humans + bot-stealth**
| Variant | Exposed | Clicked | Click rate | Engaged 10 s | Engaged rate |
|---|---|---|---|---|---|
| control | 75 | 28 | 37.3% | 34 | 45.3% |
| test | 72 | 28 | 38.9% | 32 | 44.4% |

**(c) Everything the experiment counts** (per person, any group, like PostHog's experiment page)
| Variant | Exposed | Clicked | Click rate | Engaged 10 s | Engaged rate |
|---|---|---|---|---|---|
| control | 81 | 29 | 35.8% | 38 | 46.9% |
| test | 75 | 28 | 37.3% | 35 | 46.7% |

- **Bots are 87% of the experiment's exposures:** 136 stealth bots out of 156.
- The human-only result is too small to mean anything: 11 people, randomly split 8:3.
- With bots added, the click rate converges on the bot script's built-in 30% click chance rather than on human behaviour. The result looks clean, but it describes the bot, not the visitors.
- Row (c) reproduces PostHog's own exposure totals exactly.

**PostHog's own sample-ratio check** (from its experiment exposure calculation):

| Variant | Exposures | Expected |
|---|---|---|
| control | 81 | 78 |
| test | 75 | 78 |

The check **passed (p = 0.63)**. PostHog's other health checks also passed: "Bias from an uneven split" and "Users exposed to multiple variants". **The sample-ratio check cannot catch these bots,** because they are bucketed 50/50 exactly like humans.

## 5. PostHog's after-the-fact bot labels

These come from PostHog's virtual properties `$virt_is_bot` ("Is bot") and `$virt_traffic_type`, which classify the user agent.

| Group | Is bot | Traffic type | Browser / OS / device | Countries (visitors) | is_webdriver |
|---|---|---|---|---|---|
| bot-stealth | false | Regular | Chrome / Windows / Desktop (all 136) | DE 136 | false |
| agent-claude-chrome (both) | false | Regular | Chrome 156 / Windows / Desktop | FI | false |
| human | false | Regular | 6 desktop (Chrome, Firefox on Windows), 6 mobile (Chrome, Samsung Internet on Android; Safari on iOS) | FI 3, US 2, FR 2, IR 2, DE 2, TR 1 | false |
| qa | false | Regular | Chrome / Windows / Desktop | FI | false |
| altered-link visits | false | Regular | Chrome / Windows / Desktop | US 1, DE 1 | false |
| diag-stealth | false | Regular | Chrome / Windows / Desktop | DE | false |

**PostHog labelled every recorded visitor "Regular" (not a bot), including all 136 stealth bots and both AI-agent visits.** The bots that would have been labelled as bots never reached PostHog to be labelled.

The only visible trace of the stealth bots is the pattern itself: 136 visitors in 10 minutes with an identical country, browser and screen.

## 6. AI agent tests

| Test | What PostHog recorded |
|---|---|
| Claude web fetch (`?g=agent-claude-webfetch`) | Nothing: 0 events. The tool fetches the page text without running JavaScript. |
| Free ChatGPT (`?g=agent-chatgpt`) | Nothing: 0 events. There were also no pageviews at all with `utm_source=chatgpt.com`, so no ChatGPT-referred visit arrived under any group. |
| Claude in Chrome, visit 1 (19:08) | `$pageview` → `engaged_10s` (11 s) → button click (`$autocapture`, `cta_clicked`) → `$web_vitals`. Variant `control`, `is_webdriver` false, Chrome 156 / Windows, labelled Regular. |
| Claude in Chrome, visit 2 (19:14) | Same sequence: `engaged_10s` at 14 s, then a click. Variant `control`, labelled Regular. |

Claude in Chrome runs inside the author's real browser, so PostHog sees it as the author. Both agent visits share their visitor ID and person with the author's earlier visits tagged `direct`, `qa` and `human`.

**The agent visits did not add experiment exposures.** That browser had already reported its `control` exposure during the author's QA visit, and posthog-js reports an exposure only once per browser for the same value. Exposure totals were unchanged by these visits.

**The agent's clicks do count in the experiment,** though. PostHog attributes metrics per person, and that person was exposed. The agent's 2 clicks are part of the 33 control clicks in §4(c), along with 2 earlier clicks the author made from the same browser under `human`. An agent working in a real user's browser is indistinguishable from that user: same ID, same device, same label, no automation flag.

## 7. The missing stealth visits

**Final count: 136 of 150 stealth visits reached PostHog. 14 never arrived.** This was re-checked about 53 minutes after the run. No late arrivals appeared, and the last stealth event was received at 18:33:53.

| | Logged | In PostHog | Missing |
|---|---|---|---|
| Visits / exposures | 150 | 136 | 14 (7 control, 7 test) |
| Clicks | 56 | 49 | 7 (all from the missing visits) |

What is known:
- Each missing visit is gone completely, with no pageview, exposure, click or anything else. No arrived visit is partial: none has a pageview without an exposure.
- Every logged click from a visit that arrived is in PostHog. Logged visits were matched to PostHog visitors by start time, variant and click.
- The missing visits are spread across the whole 10-minute run, not clustered in one outage.
- Each missing visit loaded its variant normally. Its browser sent 2–4 event requests to PostHog, and each got a response.
- Among visits that arrived, 125 arrived within 10 s. 11 were delayed: 3 by 10–60 s, 5 by 1–5 min, 3 by 5–7 min.

What is not known:
- **Whether PostHog accepted the missing visits' requests.** The bot recorded that a response came back, not its HTTP status.
- **PostHog's ingestion warnings for the run window.** The endpoint exists (`GET /api/projects/:id/ingestion_warnings_v2/`), but it needs the `ingestion_warning:read` scope. The read-only key used here was refused (HTTP 403).

The all-or-nothing loss, together with the delays seen for other visitors in the same burst, points to PostHog's ingestion side delaying and dropping some of this traffic: about 15 identical visitors a minute from one IP. This is an inference, not a confirmed cause.

## 8. The altered-link visits ("WyDAc")

Two visits arrived with a `traffic_group` that was never issued: `WyDAc` and `WyDAc-ayDMah-yHgphm`.

| | Visit 1 | Visit 2 |
|---|---|---|
| Time | 1 Nov 07:09 | 1 Nov 19:08 (7 s after the first Claude in Chrome visit) |
| Arrived from | Telegram Web (referrer `web.telegram.org`) | direct (no referrer) |
| Browser / OS | Chrome 155 / Windows 10, desktop | Chrome 153 / Windows 10, desktop |
| Country | US (browser timezone set to a different US region) | DE |
| Variant | control | control |
| Behaviour | pageview + exposure; no click; left within 10 s | pageview + exposure; no click; left within 10 s |
| PostHog label | Regular, `is_webdriver` false | Regular, `is_webdriver` false |

The most likely explanation is a person who received an altered link via Telegram, possibly on a VPN, which would explain the changing countries. The evidence is ambiguous: a link scanner or automated browser would look the same. Either way, both visits were counted as experiment exposures.

## 9. Limitations

- **The human group is small and cooperative.** 12 visitors who knew it was a test, so it is not representative traffic.
- **All bots ran from one VPS location (Germany) and one IP.** Real bot traffic is spread across many networks. This may also have affected the ingestion losses in §7.
- **Bot behaviour is synthetic:** fixed wait ranges, random mouse movement and scrolling.
- **The 30% click rate is scripted.** The "bot result" in §4 reflects that number, not any natural behaviour.
- **No paid ChatGPT agent test.** Only free ChatGPT was tried, and an agent that drives a real browser was tested only with Claude in Chrome.
- **The Claude in Chrome visits used the author's own browser profile,** so they merged with the author's QA and human visits.
- **Event requests were counted, not their HTTP status codes.** And ingestion warnings could not be read with the available key.
- **It is a single run of each tier, on one day, with one PostHog library version (1.444.0).** PostHog's bot lists and server behaviour may change.
