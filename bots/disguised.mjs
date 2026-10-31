// bot-disguised: headless Chromium posing as desktop Chrome, scrolls and moves the mouse,
// clicks "Request a quote" on 30% of visits.
import { runBot, sleep, rand, randInt } from './lib.mjs';

// Current stable Chrome on Windows (reduced UA format), checked 2026-10-31.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

await runBot({
  group: 'bot-disguised',
  defaultCount: 150,
  contextOptions: {
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  },
  behave: async (page) => {
    const duration = rand(4000, 12000);
    const end = Date.now() + duration;
    const willClick = Math.random() < 0.3;
    const clickAt = Date.now() + rand(1500, duration - 500);
    let clicked = false;

    while (Date.now() < end) {
      if (Math.random() < 0.5) {
        await page.mouse.move(randInt(40, 1400), randInt(40, 860), { steps: randInt(5, 25) });
      } else {
        await page.mouse.wheel(0, randInt(-250, 400));
      }
      if (willClick && !clicked && Date.now() >= clickAt) {
        await page.getByRole('button', { name: 'Request a quote' }).click();
        clicked = true;
      }
      await sleep(Math.max(0, Math.min(rand(300, 1200), end - Date.now())));
    }
    if (willClick && !clicked) {
      await page.getByRole('button', { name: 'Request a quote' }).click();
      clicked = true;
    }
    return clicked;
  },
});
