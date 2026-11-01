// bot-stealth: same as bot-disguised, but also hides the signals posthog-js's bot check uses
// (navigator.webdriver and the "HeadlessChrome" brand in navigator.userAgentData).
import { runBot, REALISTIC_CONTEXT, HIDE_AUTOMATION_SCRIPT, browseLikeAVisitor } from './lib.mjs';

await runBot({
  group: 'bot-stealth',
  defaultCount: 150,
  contextOptions: REALISTIC_CONTEXT,
  initScript: HIDE_AUTOMATION_SCRIPT,
  behave: (page) => browseLikeAVisitor(page, 0.3),
});
