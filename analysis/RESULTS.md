# Bots in an A/A test: results

A controlled demonstration of how automated traffic and AI agents show up in a PostHog A/B test, using an **A/A experiment** (two identical variants, so the true difference is zero). All times are UTC. **Data cutoff: everything PostHog had ingested by 1 Nov 2026, 20:21:12** (from PostHog's ingestion time, `created_at`). An earlier pull at 19:20:41 the same day is kept as history in §7.

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
| bot-stealth | 150 | **150** | 758 | **150** | 56 → **55** |
| bot-nojs | 50 | 0 | **0** | 0 | 0 → 0 |
| agent-claude-webfetch | manual | 0 | **0** | 0 | – |
| agent-chatgpt | manual | 0 | **0** | 0 | – |
| agent-claude-chrome (+ -2) | 2 | 1 (author's own browser) | 10 | **0** (see §6) | 2 → 2 |
| human | – | 12 | 100 | 11 | – → 11 |
| qa | – | 6 | 33 | 6 | – → 0 |

The two visits with an altered `?g=` value (§8) sent 3 events each, with 1 exposure each.

- **Every bot that announced itself, by user agent, browser brand or the webdriver flag, was invisible in PostHog.**
- The stealth bots, which hid those signals, were counted as normal visitors. All 150 arrived, 14 of them about 75 minutes late, and one arrived without its click (§7).
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
| control | 82 | 31 | 37.8% | 37 | 45.1% |
| test | 79 | 31 | 39.2% | 35 | 44.3% |

**(c) Everything the experiment counts** (per person, any group, like PostHog's experiment page)
| Variant | Exposed | Clicked | Click rate | Engaged 10 s | Engaged rate |
|---|---|---|---|---|---|
| control | 88 | 32 | 36.4% | 41 | 46.6% |
| test | 82 | 31 | 37.8% | 38 | 46.3% |

- **Bots are 88% of the experiment's exposures:** 150 stealth bots out of 170.
- The human-only result is too small to mean anything: 11 people, randomly split 8:3.
- With bots added, the click rate converges on the bot script's built-in 30% click chance rather than on human behaviour. The result looks clean, but it describes the bot, not the visitors.
- Row (c) matches PostHog's experiment page exactly: 88 / 82 exposures, 32 / 31 clickers, 41 / 38 engaged.
- **The experiment's numbers changed after the fact.** At the 19:20:41 pull, (c) was 81 / 75 exposed and 29 / 28 clicked. The 14 late stealth visits (§7) added 7 exposures and 3 clickers to each variant.

**PostHog's own sample-ratio check** (from its experiment exposure calculation, recalculated at 20:23:06):

| Variant | Exposures | Expected |
|---|---|---|
| control | 88 | 85 |
| test | 82 | 85 |

The check **passed (p = 0.645)**. At the earlier pull it was 81 / 75, also passed (p = 0.63). PostHog's other health checks also passed: "Bias from an uneven split" and "Users exposed to multiple variants". **The sample-ratio check cannot catch these bots,** because they are bucketed 50/50 exactly like humans.

## 5. PostHog's after-the-fact bot labels

These come from PostHog's virtual properties `$virt_is_bot` ("Is bot") and `$virt_traffic_type`, which classify the user agent.

| Group | Is bot | Traffic type | Browser / OS / device | Countries (visitors) | is_webdriver |
|---|---|---|---|---|---|
| bot-stealth | false | Regular | Chrome / Windows / Desktop (all 150) | DE 150 | false |
| agent-claude-chrome (both) | false | Regular | Chrome 156 / Windows / Desktop | FI | false |
| human | false | Regular | 6 desktop (Chrome, Firefox on Windows), 6 mobile (Chrome, Samsung Internet on Android; Safari on iOS) | FI 3, US 2, FR 2, IR 2, DE 2, TR 1 | false |
| qa | false | Regular | Chrome / Windows / Desktop | FI | false |
| altered-link visits | false | Regular | Chrome / Windows / Desktop | US 1, DE 1 | false |
| diag-stealth | false | Regular | Chrome / Windows / Desktop | DE | false |

**PostHog labelled every recorded visitor "Regular" (not a bot), including all 150 stealth bots and both AI-agent visits.** The bots that would have been labelled as bots never reached PostHog to be labelled.

The only visible trace of the stealth bots is the pattern itself: 150 visitors in 10 minutes with an identical country, browser and screen.

## 6. AI agent tests

| Test | What PostHog recorded |
|---|---|
| Claude web fetch (`?g=agent-claude-webfetch`) | Nothing: 0 events. The tool fetches the page text without running JavaScript. |
| Free ChatGPT (`?g=agent-chatgpt`) | Nothing: 0 events. There were also no pageviews at all with `utm_source=chatgpt.com`, so no ChatGPT-referred visit arrived under any group. |
| Claude in Chrome, visit 1 (19:08) | `$pageview` → `engaged_10s` (11 s) → button click (`$autocapture`, `cta_clicked`) → `$web_vitals`. Variant `control`, `is_webdriver` false, Chrome 156 / Windows, labelled Regular. |
| Claude in Chrome, visit 2 (19:14) | Same sequence: `engaged_10s` at 14 s, then a click. Variant `control`, labelled Regular. |

Claude in Chrome runs inside the author's real browser, so PostHog sees it as the author. Both agent visits share their visitor ID and person with the author's earlier visits tagged `direct`, `qa` and `human`.

**The agent visits did not add experiment exposures.** That browser had already reported its `control` exposure during the author's QA visit, and posthog-js reports an exposure only once per browser for the same value. Exposure totals were unchanged by these visits.

**The agent's clicks do count in the experiment,** though. PostHog attributes metrics per person, and that person was exposed. The agent's 2 clicks are part of the 36 control clicks behind §4(c), along with 2 earlier clicks the author made from the same browser under `human`. An agent working in a real user's browser is indistinguishable from that user: same ID, same device, same label, no automation flag.

## 7. Delayed stealth visits, and one lost click

### History: the 19:20:41 pull
At the first pull, 53 minutes after the stealth run ended, **136 of 150 stealth visits were in PostHog and 14 were missing**. The last stealth event received by then had arrived at 18:33:53. The first version of this report treated the 14 as lost.

### Final: the 20:21:12 cutoff
**All 150 stealth visits reached PostHog. 14 of them arrived about 75 minutes late, and one arrived without its click.**

| | Logged | In PostHog at 19:20:41 | In PostHog at 20:21:12 |
|---|---|---|---|
| Visits / exposures | 150 (74 control, 76 test) | 136 | **150** (74 control, 76 test) |
| Clicks | 56 | 49 | **55** |

When each stealth visit's events reached PostHog (measured on its slowest event):

| Delay after the browser recorded it | Visits |
|---|---|
| Under 10 s | 125 |
| 10–60 s | 3 |
| 1–5 min | 5 |
| 5–7 min | 3 |
| **74–81 min** | **14** |

What is known:
- **The 14 late visits were delayed, not lost.** PostHog ingested them between 19:38:56 and 19:40:53, about 74–81 minutes after they happened and 18 minutes after the first pull. Before that, they were not visible to any query.
- **Each late visit arrived complete and all at once.**
  - Every one has its pageview, flag call and exposure.
  - All 6 of their logged clicks are there.
  - 6 have `engaged_10s`, and 13 of 14 have `$web_vitals`.
  - Each visit's events were ingested within 1–4 seconds of each other.
- **Where they fell:** they happened throughout the run (18:18–18:26), split 7 control and 7 test. Yet all of them were released together in one two-minute window.
- **One on-time visit is missing its click.** Visit 49 (control, logged as clicked) reached PostHog at 18:20:50 with only its pageview, flag call and exposure. Its click, engagement and web-vitals events never arrived, still absent at the cutoff about two hours later. This is the 56th click.
- **Matching is now unambiguous.** Each logged visit has a PostHog visitor whose pageview came 0.4–0.7 s after the logged start, with the same variant and the same click outcome (except visit 49).
- **A correction to the first version.** That version said every logged click from an arrived visit was in PostHog. It was wrong: looser matching had paired visit 49 with a neighbouring visitor.
- **The experiment results changed after the fact (§4).** The late visits added 7 exposures and 3 clickers to each variant.

What is not known:
- **Why 14 visits were held back for about 75 minutes and then released together,** and why one visit lost its later events. Their browsers sent 2–4 event requests each and got responses, but the bot recorded only that a response came back, not its HTTP status.
- **PostHog's ingestion warnings for the run window.** The endpoint exists (`GET /api/projects/:id/ingestion_warnings_v2/`), but it needs the `ingestion_warning:read` scope. The read-only key used here was refused (HTTP 403).
- **Whether other on-time visits lost events.** 9 on-time visits (visit 49 among them) arrived with only a pageview, flag call and exposure. That fits short visits, but the bot logged neither visit length nor engagement, so only a missing click (visit 49) can be checked against the log.

The pattern suggests PostHog's ingestion put part of this burst (about 15 identical visitors a minute from one IP) on a slower path and processed it later. This is an inference, not a confirmed cause.

**Practical consequence:** an experiment read within an hour or so of a traffic burst can undercount, and its numbers can still move afterwards.

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
- **All bots ran from one VPS location (Germany) and one IP.** Real bot traffic is spread across many networks. This may also have affected the ingestion delays in §7.
- **Bot behaviour is synthetic:** fixed wait ranges, random mouse movement and scrolling.
- **The 30% click rate is scripted.** The "bot result" in §4 reflects that number, not any natural behaviour.
- **No paid ChatGPT agent test.** Only free ChatGPT was tried, and an agent that drives a real browser was tested only with Claude in Chrome.
- **The Claude in Chrome visits used the author's own browser profile,** so they merged with the author's QA and human visits.
- **Event requests were counted, not their HTTP status codes.** And ingestion warnings could not be read with the available key.
- **The bot log does not record visit length or engagement,** so missing `engaged_10s` or web-vitals events cannot be checked against ground truth; only clicks can.
- **It is a single run of each tier, on one day, with one PostHog library version (1.444.0).** PostHog's bot lists and server behaviour may change.
