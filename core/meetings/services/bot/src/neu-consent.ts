/**
 * neu-meet patch: Neu Notetaker's consent notice and logo tile (Google Meet only).
 *
 * - Consent: once admitted, the bot posts VEXA_CONSENT_MESSAGE in the Meet chat. Vexa 0.12 has no
 *   chat-send API for Meet (the gateway's chat POST is a "signed gap"), so the bot types it itself.
 * - Logo: a Meet guest can't have a profile photo, so the bot's camera shows a still frame instead
 *   (VEXA_BOT_LOGO_FILE, a .y4m that Chromium's fake capture device loops).
 * Both are set in the image (Dockerfile ENV); an empty value turns that part off (a rebuild: bot containers
 * don't get extra env at run time). With the logo on, the fake device also replaces the PulseAudio
 * virtual_mic, so Vexa's voice-agent "speak" can't be heard on Meet; Neu doesn't use it.
 */
import { existsSync } from 'node:fs';
import type { Page } from '@vexa/remote-browser';
import type { Invocation } from './config.js';

// :visible, so a hidden or off-screen button with "chat" in its label is never the one picked
const CHAT_BUTTON = 'button[aria-label*="Chat with everyone" i]:visible, button[aria-label*="chat" i]:visible';
const CHAT_BOX = 'textarea[aria-label*="Send a message" i]';
// the fake device also brings a fake mic; it plays this, so even an unmuted mic sends nothing
const SILENCE = '/app/silence.wav';

export function consentMessage(inv: Invocation, env: NodeJS.ProcessEnv = process.env): string {
  return inv.platform === 'google_meet' ? (env.VEXA_CONSENT_MESSAGE ?? '').trim() : '';
}

/** Chromium flags for the logo tile; none when it's off or a file is missing (a fake mic without
 *  the silence file would beep). Appended after the join args, so they win over its /dev/null camera. */
export function logoBrowserArgs(inv: Invocation, env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync): string[] {
  const file = env.VEXA_BOT_LOGO_FILE;
  if (inv.platform !== 'google_meet' || !file || !exists(file) || !exists(SILENCE)) return [];
  return ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${file}`,
    `--use-file-for-fake-audio-capture=${SILENCE}`];
}

/** Posts one chat message as the bot, a few tries. Never throws: the call goes on without it.
 *  Whatever happens, the chat panel ends as it was found (closed), since the video recording shows
 *  the bot's screen: a panel left open would shrink the grid for the whole call. */
export async function postMeetChat(page: Page, text: string, tries = 3): Promise<boolean> {
  await page.waitForTimeout(3_000).catch(() => {}); // let the meeting view settle after admission
  const button = () => page.locator(CHAT_BUTTON).first();
  const box = () => page.locator(CHAT_BOX).first();
  const panelOpen = async () => (await button().getAttribute('aria-pressed', { timeout: 5_000 }).catch(() => null)) === 'true'
    || await box().isVisible().catch(() => false);
  const wasOpen = await panelOpen();
  let posted = false;
  for (let i = 1; i <= tries && !posted; i++) {
    try {
      await page.mouse.move(400 + i, 300); // Meet hides its toolbar while the pointer is idle
      if (!(await panelOpen())) await button().click({ timeout: 10_000 });
      await box().fill(text, { timeout: 10_000 }); // a host who turned chat off leaves it disabled: times out
      await box().press('Enter');
      // sent: Meet empties the box; still full means Enter didn't send
      // a string, since it runs in the page and the bot is compiled without DOM types
      await page.waitForFunction(`!document.querySelector(${JSON.stringify(CHAT_BOX)})?.value`, undefined, { timeout: 5_000 });
      posted = true;
      console.log('[bot] consent notice posted in the meeting chat');
    } catch (e) {
      console.error(`[bot] consent notice: try ${i}/${tries} failed: ${String(e)}`);
      if (i < tries) await page.waitForTimeout(5_000).catch(() => {});
    }
  }
  if (!wasOpen && await panelOpen()) {
    await button().click({ timeout: 5_000 })
      .catch((e) => console.error(`[bot] consent notice: couldn't close the chat panel: ${String(e)}`));
  }
  await page.mouse.move(960, 540).catch(() => {}); // off the toolbar, so it and its tooltip hide again
  return posted;
}

/** Every 15 s for the whole call, closes the two Meet tips the camera brings up on the bot's screen, which is
 *  what the video records: "Others may see your video differently" and "Camera might be blocked" (the dark
 *  logo frame looks covered to Meet). Only those: a Close elsewhere can mean "no" (a recording consent notice,
 *  a breakout-room move). Returns a stop function. Never throws. */
/** Runs in the Meet page: the bot's camera button, read (and with click, pressed) through the DOM. Meet hides
 *  the toolbar while the pointer is idle, so it's never "visible" mid-call, and a DOM click moves no pointer
 *  (no toolbar or tooltip on the recording). Locked: the host has blocked video. */
export function meetCamera(click: boolean): 'on' | 'off' | 'locked' | 'none' {
  const b = document.querySelector('button[aria-label*="Turn on camera"], button[aria-label*="Turn off camera"]') as HTMLButtonElement | null;
  if (!b) return 'none';
  if (/turn off camera/i.test(b.getAttribute('aria-label') || '')) return 'on';
  if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'locked';
  if (click) b.click();
  return 'off';
}

/** At most this many times a call the bot turns its camera back on (someone who keeps turning it off wins),
 *  and it gives up after this many tries in a row that didn't take (a broken fake camera). */
const CAMERA_TURN_ONS = 3;

export function dismissMeetPopups(page: Page, everyMs = 15_000, keepCameraOn = false, settleMs = 2_000): () => void {
  let stopped = false;  // a sweep under way when the bot leaves clicks nothing more
  let camera = '';      // last camera state seen, logged on change (how Meet behaves, e.g. on a host's video lock)
  let turnedOn = 0;
  let failed = 0;
  const sweep = async () => {
    // the logo tile: Meet turns the bot's camera off when the host blocks video, and doesn't turn it back on
    // when video is allowed again, so the tile fell back to a letter avatar. A locked button is left alone.
    if (keepCameraOn && turnedOn < CAMERA_TURN_ONS && failed < CAMERA_TURN_ONS) {
      const now = await page.evaluate(meetCamera, false);
      if (now !== camera) console.log(`[bot] camera: ${now}`);
      camera = now;
      if (now === 'off' && !stopped) {
        await page.evaluate(meetCamera, true);
        await page.waitForTimeout(settleMs);
        camera = await page.evaluate(meetCamera, false);
        if (camera === 'on') console.log(`[bot] turned its camera (the logo) back on (${++turnedOn}/${CAMERA_TURN_ONS})`);
        else if (++failed === CAMERA_TURN_ONS) console.log(`[bot] camera: ${failed} tries didn't turn it on; leaving it ${camera}`);
        if (camera === 'on') failed = 0;
      }
    }
    if (stopped) return;
    const tips = page.locator('[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"]')
      .filter({ hasText: /see your video differently|camera might be blocked/i });
    // visible ones only, each on its own: one that can't be clicked mustn't block the rest every sweep
    const buttons = await tips.getByRole('button', { name: /^(got it|dismiss|close)$/i }).filter({ visible: true }).all();
    for (const b of buttons.slice(0, 5)) {
      if (stopped) return;
      await b.click({ timeout: 2_000 }).then(() => console.log('[bot] closed a Meet camera tip')).catch(() => {});
    }
  };
  const timer = setInterval(() => { sweep().catch(() => {}); }, everyMs);
  return () => { stopped = true; clearInterval(timer); };
}
