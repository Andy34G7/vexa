/**
 * neu-meet patch: leaving when everyone else has left the Google Meet. The real page function runs against
 * a fabricated DOM; no browser. Run: npx tsx src/googlemeet/everyone-left.test.ts
 */

import { meetPresence, meetTilesDebug, startGoogleEveryoneLeftMonitor } from './everyone-left';

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tile = { id: string; label?: string; name?: string; self?: boolean };
/** A Meet page with these participant tiles (name: the span.notranslate text; self: the data-self-name marker,
 *  which a signed-out guest bot doesn't get). */
function setPage(tiles: Tile[], text = '') {
  const els = tiles.map((t) => ({
    getAttribute: (a: string) => (a === 'data-participant-id' ? t.id : a === 'aria-label' ? t.label ?? 'Someone' : null),
    textContent: t.label ?? 'Someone',
    querySelector: (sel: string) => (sel === 'span.notranslate' && t.name ? { textContent: ` ${t.name} ` } : null),
    // as live: several name spans, the name not in the first
    querySelectorAll: (sel: string) => (sel === 'span.notranslate' ? [{ textContent: '' }, ...(t.name ? [{ textContent: ` ${t.name} ` }] : []), { textContent: '' }] : []),
  }));
  const selfIdx = tiles.findIndex((t) => t.self);
  (globalThis as any).document = {
    body: { innerText: text },
    querySelectorAll: (sel: string) => (sel === '[data-participant-id]' ? els : []),
    querySelector: (sel: string) => (sel === '[data-self-name]' && selfIdx >= 0
      ? { closest: (c: string) => (c === '[data-participant-id]' ? els[selfIdx] : null) } : null),
  };
}
const NAME = 'Neu Notetaker';
const BOT: Tile = { id: 'b', label: NAME, name: NAME };  // as live: named, not marked
const presence = () => meetPresence(NAME);
const ANA: Tile = { id: 'a', label: 'Ana' };
const EFFECTS: Tile = { id: 'fx', label: 'visual_effects Backgrounds and effects' };

setPage([BOT, ANA]); check('page: someone else -> others', presence() === 'others');
setPage([BOT]); check('page: only the bot -> alone', presence() === 'alone');
setPage([BOT, EFFECTS]); check('page: the effects preview is not a person', presence() === 'alone');
setPage([BOT, { ...BOT, name: undefined }]); check('page: a nested duplicate of the bot tile is still alone', presence() === 'alone');
setPage([{ ...BOT, label: 'visual_effects frame_person more_vert Neu Notetaker' }]);
check('page: the bot tile holding an effects button is still the bot (seen live)', presence() === 'alone');
setPage([BOT, { id: 'fx2', label: 'Apply visual effects' }]); check('page: an unrecognised effects label counts as someone (never leaves)', presence() === 'others');
setPage([]); check('page: no tiles -> unknown', presence().startsWith('unknown'));
setPage([{ ...BOT, name: undefined }, ANA]); check('page: bot tile not found -> unknown', presence().startsWith('unknown'));
setPage([{ id: 'b', label: 'x', self: true }]); check("page: Meet's self marker works too", presence() === 'alone');
setPage([BOT]); check('page: no bot name given -> unknown', meetPresence('').startsWith('unknown'));
setPage([BOT, { id: 'b2', name: NAME }]); check('page: two tiles with the bot name -> unknown (never leaves early)', presence().startsWith('unknown'));
setPage([BOT], 'Breakout rooms are open'); check('page: breakout rooms -> unknown', presence().startsWith('unknown'));
setPage([BOT, { id: 'a', label: 'Ana Real', name: 'Ana Real' }]);
const dump = meetTilesDebug(NAME);
check("tile log: no participant's name, only which tile is the bot's", !dump.includes('Ana')
  && JSON.parse(dump).tiles.map((t: { named: boolean }) => t.named).join() === 'true,false');
const doc = (globalThis as any).document, tilesOf = doc.querySelectorAll;
doc.querySelectorAll = (sel: string) => (sel === '[aria-label]'
  ? ['Chat with everyone', 'Show everyone (3)', 'Mute Ana Real for everyone', 'Мария: people'].map((l) => ({ getAttribute: () => l }))
  : tilesOf(sel));
const labelled = JSON.parse(meetTilesDebug(NAME));
check("tile log: Meet's control labels kept, a label with a name only counted",
  labelled.labels.join('|') === 'Chat with everyone|Show everyone (3)' && labelled.otherLabels === 2);

/** The monitor over a page whose presence the test sets; heardAt is the last remote audio. */
async function run(states: string[], stepMs: number, heardAt?: () => number | undefined) {
  let cur = states[0];
  const page: any = { evaluate: async () => { if (cur === 'error') throw new Error('closed'); return cur; } };
  let fired = false;
  const stop = startGoogleEveryoneLeftMonitor(page, () => { fired = true; }, { aloneMs: 100, pollMs: 10, lastHeardAt: heardAt });
  for (const s of states) { cur = s; await sleep(stepMs); }
  stop();
  return fired;
}

(async () => {
  check('someone else stays: no leave', !(await run(['others'], 250)));
  check('others, then only the bot for the window: leaves', await run(['others', 'alone'], 200));
  check('only the bot from the start (nobody joined yet): no leave', !(await run(['alone'], 300)));
  check('unknown after others: no leave', !(await run(['others', 'unknown: x'], 200)));
  check('page errors: no leave', !(await run(['others', 'error'], 200)));
  check('someone rejoins mid-window: no leave', !(await run(['others', 'alone', 'others', 'alone'], 60)));
  check('heard someone within the window: no leave', !(await run(['others', 'alone'], 150, () => Date.now() - 20)));
  check('no audio reading (capture down): no leave', !(await run(['others', 'alone'], 200, () => undefined)));
  check('heard long ago: leaves', await run(['others', 'alone'], 200, () => Date.now() - 10_000));
  check('stopped before the window ends: no leave', !(await run(['others', 'alone'], 30)));
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (m: string) => { lines.push(String(m)); };
  await run(['alone', 'others'], 30);
  console.log = origLog;
  check('log: "nobody else seen yet" only before someone was seen', lines.some((l) => l.includes('alone (nobody else seen yet)'))
    && lines.some((l) => l.includes('everyone-left: others')) && !lines.some((l) => l.includes('others (nobody else seen yet)')));
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ngooglemeet everyone-left: all checks passed');
})();
