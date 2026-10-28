/**
 * neu-meet patch: the Google Meet removal check. Leaving meet.google.com ends the call (Meet sends a signed-out
 * guest to Google's product page when the call ends), and only exact end-of-call texts count: no substring
 * matches a chat message could trip, no generic alert catch-alls (as for Teams, Vexa-ai/vexa#600).
 * Fabricated page, no browser. Run: npx tsx src/googlemeet/removal.test.ts
 */

import { checkForGoogleRemoval } from './removal';
import { googleRemovalIndicators } from './selectors';

function mockPage(url: string, visible: string[] = []): any {
  return {
    url: () => url,
    locator: (sel: string) => ({ first: () => ({ isVisible: async () => visible.includes(sel) }) }),
  };
}

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed++;
};

(async () => {
  check('in the call: not removed', !(await checkForGoogleRemoval(mockPage('https://meet.google.com/abc-defg-hij?hl=en'))));
  check('sent to the product page: removed',
    await checkForGoogleRemoval(mockPage('https://workspace.google.com/products/meet/?hl=en')));
  check('about:blank (no host): not removed', !(await checkForGoogleRemoval(mockPage('about:blank'))));
  check('"Call ended" screen: removed',
    await checkForGoogleRemoval(mockPage('https://meet.google.com/abc-defg-hij', ['text="Call ended"'])));
  check('only exact texts, no substring text= forms',
    googleRemovalIndicators.every((s) => !s.startsWith('text=') || s.startsWith('text="')));
  check('no generic alert catch-alls', !googleRemovalIndicators.some((s) => s.includes('role="alert')));
  check('a network blip ("Reconnecting") is not the end', !googleRemovalIndicators.some((s) => /reconnecting/i.test(s)));
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ngooglemeet removal: all checks passed');
})();
