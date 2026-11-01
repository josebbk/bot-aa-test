// bot-disguised: headless Chromium posing as desktop Chrome (user agent, viewport, locale only;
// the automation flag navigator.webdriver is left as is). Scrolls and moves the mouse,
// clicks "Request a quote" on 30% of visits.
import { runBot, REALISTIC_CONTEXT, browseLikeAVisitor } from './lib.mjs';

await runBot({
  group: 'bot-disguised',
  defaultCount: 30,
  contextOptions: REALISTIC_CONTEXT,
  behave: (page) => browseLikeAVisitor(page, 0.3),
});
