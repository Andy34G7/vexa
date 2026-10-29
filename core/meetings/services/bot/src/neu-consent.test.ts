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
  const camera = { off: true };
  const tipsPage = {
    locator: (sel: string) => (sel.includes('Turn on camera')
      ? { filter: () => ({ count: async () => (camera.off ? 1 : 0), first: () => ({ click: async () => { clicks.push('camera'); camera.off = false; } }) }) }
      : { filter: () => ({ getByRole: () => ({ filter: () => ({ all: async () => [btn('stuck', true), btn('got it')] }) }) }) }),
  } as unknown as Page;
  const stop = dismissMeetPopups(tipsPage, 20);
  await new Promise((r) => setTimeout(r, 70));
  stop();
  const n = clicks.length;
  await new Promise((r) => setTimeout(r, 60));
  check("tips: a stuck button doesn't block the next one", n >= 2 && clicks.every((c) => c === 'got it'), JSON.stringify(clicks));
  check('tips: no clicks after stop', clicks.length === n, `${n} -> ${clicks.length}`);
  check('camera: left alone unless the logo is on', !clicks.includes('camera'));
  clicks.length = 0;
  const stopCam = dismissMeetPopups(tipsPage, 20, true);
  await new Promise((r) => setTimeout(r, 70));
  stopCam();
  check('camera: turned back on once when found off', clicks.filter((c) => c === 'camera').length === 1, JSON.stringify(clicks));

  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nneu-consent: all checks passed');
})();
