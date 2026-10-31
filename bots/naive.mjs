// bot-naive: headless Chromium, Playwright's default "HeadlessChrome" user agent, never clicks.
import { runBot, sleep, rand } from './lib.mjs';

await runBot({
  group: 'bot-naive',
  defaultCount: 150,
  contextOptions: {}, // Playwright defaults, including the HeadlessChrome user agent
  behave: async () => {
    await sleep(rand(2000, 6000));
    return false;
  },
});
