/**
 * neu-meet patch: the consent-notice and logo-tile switches (env → behaviour), and the chat flow against a
 * fake Meet page. No browser.
 * Run: npx tsx src/neu-consent.test.ts
 */
import type { Invocation } from './config.js';
import type { Page } from '@vexa/remote-browser';
import { consentMessage, dismissMeetPopups, logoBrowserArgs, postMeetChat } from './neu-consent.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const meet = { platform: 'google_meet' } as Invocation;
const teams = { platform: 'teams' } as Invocation;
const all = () => true;

check('consent: message from env, trimmed', consentMessage(meet, { VEXA_CONSENT_MESSAGE: ' Recording. ' }) === 'Recording.');
check('consent: empty or unset = off', consentMessage(meet, { VEXA_CONSENT_MESSAGE: '  ' }) === '' && consentMessage(meet, {}) === '');
check('consent: Google Meet only', consentMessage(teams, { VEXA_CONSENT_MESSAGE: 'x' }) === '');

const args = logoBrowserArgs(meet, { VEXA_BOT_LOGO_FILE: '/app/neu-logo.y4m' }, all);
check('logo: fake camera plays the frame', args.includes('--use-file-for-fake-video-capture=/app/neu-logo.y4m'), args.join(' '));
check('logo: fake device on, mic plays silence', args.includes('--use-fake-device-for-media-stream')
  && args.some((a) => a.startsWith('--use-file-for-fake-audio-capture=')), args.join(' '));
check('logo: unset = off', logoBrowserArgs(meet, {}, all).length === 0);
check('logo: Google Meet only', logoBrowserArgs(teams, { VEXA_BOT_LOGO_FILE: '/x.y4m' }, all).length === 0);
check('logo: a missing file = off (no beeping fake mic)',
  logoBrowserArgs(meet, { VEXA_BOT_LOGO_FILE: '/x.y4m' }, (p) => p === '/x.y4m').length === 0);


/** Just enough of a Meet page: a chat button that toggles the panel, and a box that sends on Enter. */
function fakeMeet({ chat = 'on' as 'on' | 'off' | 'missing' } = {}) {
  const st = { open: false, value: '', sent: [] as string[], clicks: 0 };
  const fail = (what: string) => Promise.reject(new Error(`timeout: ${what}`));
  const page = {
    waitForTimeout: async () => {},
    mouse: { move: async () => {} },
    waitForFunction: async () => (st.value ? fail('box still full') : undefined),
    locator: (sel: string) => ({
      first: () => sel.includes('textarea') ? {
        isVisible: async () => st.open && chat !== 'missing',
        fill: async (t: string) => (st.open && chat === 'on' ? void (st.value = t) : fail('fill')),
        press: async () => { st.sent.push(st.value); st.value = ''; },
      } : {
        getAttribute: async () => String(st.open),
        click: async () => { st.clicks++; st.open = !st.open; },
      },
    }),
  } as unknown as Page;
  return { page, st };
}

void (async () => {
  let m = fakeMeet();
  check('chat: posts once, panel closed after', await postMeetChat(m.page, 'hi') && m.st.sent.length === 1 && !m.st.open,
    JSON.stringify(m.st));
  for (const chat of ['off', 'missing'] as const) {
    m = fakeMeet({ chat });
    const ok = await postMeetChat(m.page, 'hi');
    check(`chat ${chat}: gives up, nothing sent, panel closed`, !ok && !m.st.sent.length && !m.st.open, JSON.stringify(m.st));
  }
  m = fakeMeet();
  m.st.open = true; // the panel was already open: leave it that way
  await postMeetChat(m.page, 'hi');
  check('chat: an already-open panel stays open', m.st.open && m.st.sent.length === 1, JSON.stringify(m.st));

  // camera tips: a button that can't be clicked doesn't block the others; stopping ends the sweeps
  const clicks: string[] = [];
  const btn = (name: string, stuck = false) => ({ click: async () => (stuck ? Promise.reject(new Error('covered')) : void clicks.push(name)) });
  const tipsPage = {
    locator: () => ({ filter: () => ({ getByRole: () => ({ filter: () => ({ all: async () => [btn('stuck', true), btn('got it')] }) }) }) }),
    evaluate: async () => { clicks.push('camera?'); return 'on'; },
  } as unknown as Page;
  const stop = dismissMeetPopups(tipsPage, 20);
  await new Promise((r) => setTimeout(r, 70));
  stop();
  const n = clicks.length;
  await new Promise((r) => setTimeout(r, 60));
  check("tips: a stuck button doesn't block the next one", n >= 2 && clicks.every((c) => c === 'got it'), JSON.stringify(clicks));
  check('tips: no clicks after stop', clicks.length === n, `${n} -> ${clicks.length}`);
  check('camera: not even read unless the logo is on', !clicks.includes('camera?'));

  // the camera: a page whose button the test drives; evaluate(meetCamera, click) answers like the real one
  // takes: a press turns it on; slow: it shows "on" only from the read after next (past the settle)
  const cam = (start: string, takes = true, slow = false) => {
    const st = { state: start, presses: 0, takes, pending: 0 };
    const page = {
      locator: () => ({ filter: () => ({ getByRole: () => ({ filter: () => ({ all: async () => [] }) }) }) }),
      evaluate: async (_fn: unknown, click: boolean) => {
        if (st.pending && --st.pending === 0) st.state = 'on';
        if (click && st.state === 'off') { st.presses++; if (st.takes) slow ? (st.pending = 2) : (st.state = 'on'); }
        return st.state;
      },
      waitForTimeout: async () => {},
    } as unknown as Page;
    return { st, page };
  };
  const run = async (c: ReturnType<typeof cam>, ms: number, during?: () => void, retryMs?: number) => {
    const stopCam = dismissMeetPopups(c.page, 10, true, 0, retryMs);
    await new Promise((r) => setTimeout(r, ms / 2)); during?.(); await new Promise((r) => setTimeout(r, ms / 2));
    stopCam();
  };
  let c = cam('off');
  await run(c, 80);
  check('camera: found off, turned back on once', c.st.presses === 1 && c.st.state === 'on', JSON.stringify(c.st));
  c = cam('locked');
  await run(c, 80);
  check('camera: blocked by the host, left alone', c.st.presses === 0, JSON.stringify(c.st));
  c = cam('off', false);
  await run(c, 150);
  check("camera: a click that doesn't take is tried 3 times, then left", c.st.presses === 3, JSON.stringify(c.st));
  c = cam('off');
  const offAgain = setInterval(() => { c.st.state = 'off'; }, 15);
  await run(c, 300);
  clearInterval(offAgain);
  check('camera: someone who keeps turning it off wins after 3', c.st.presses === 3, JSON.stringify(c.st));
  c = cam('off', true, true);
  await run(c, 120);
  check('camera: a turn-on slower than the settle still counts, no extra presses', c.st.presses === 1 && c.st.state === 'on', JSON.stringify(c.st));
  c = cam('off', false);
  await run(c, 200, () => { c.st.state = 'locked'; setTimeout(() => { c.st.state = 'off'; c.st.takes = true; }, 30); });
  check('camera: failures, then a host lock and unlock: turned on again', c.st.state === 'on', JSON.stringify(c.st));
  c = cam('off', false);
  await run(c, 240, () => { c.st.takes = true; }, 40);
  // 3 quick presses, then one per 40 ms (every 10 ms would be ~12)
  check('camera: after 3 failed presses it keeps trying, slowly', c.st.state === 'on' && c.st.presses >= 4 && c.st.presses <= 7, JSON.stringify(c.st));
  c = cam('on');
  await run(c, 40);
  const before = c.st.presses;
  c.st.state = 'off';
  await new Promise((r) => setTimeout(r, 40));
  check('camera: nothing pressed after stop', c.st.presses === before, JSON.stringify(c.st));

  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nneu-consent: all checks passed');
})();
