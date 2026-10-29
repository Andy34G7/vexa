import { Page } from "playwright";
import { log } from "../_host";

// neu-meet patch: Vexa 0.12 only decides "alone" from silence (10 minutes of no remote audio), so a bot left
// behind in a call that's still open records an empty room for 10 minutes. This counts the people instead:
// once someone else has been in the call, and then for EVERYONE_LEFT_MS only the bot's own tile is on the
// page and nobody is heard, everyone has left. A wrong leave can't be undone (the meeting counts as served),
// so anything unclear is "don't know", and the silence rule stays as the backstop.
// ponytail: reads Meet's tiles; if Meet stops rendering them the check never fires (fails safe).
export const EVERYONE_LEFT_MS = 2 * 60 * 1000;

/** "unknown: <why>" is never alone. */
export type MeetPresence = "alone" | "others" | `unknown: ${string}`;

/** Runs in the Meet page (self-contained: Playwright sends its source). "alone" when the bot's own tile is
 *  on the page and no other participant tile is. Unknown: the bot's tile not found, or anything about
 *  breakout rooms on the page (the main room empties while people are in their rooms). */
export function meetPresence(botName: string): MeetPresence {
  if (/breakout/i.test(document.body?.innerText || "")) return "unknown: breakout rooms";
  // the bot's tile: Meet's self marker if any (a signed-out guest has none, seen live), else the tile named as
  // the bot (its name in span.notranslate, as gmeet-speakers reads names). Two bots of the same name: the
  // other one's tile may be taken for ours, then ours counts as someone else, so neither leaves early.
  const tiles = Array.from(document.querySelectorAll("[data-participant-id]"));
  const named = tiles.find((el) => !!botName && el.querySelector("span.notranslate")?.textContent?.trim() === botName);
  const self = (document.querySelector("[data-self-name]")?.closest("[data-participant-id]") || named)
    ?.getAttribute("data-participant-id");
  if (!self) return "unknown: the bot's own tile isn't found";
  // Meet gives the "Backgrounds and effects" preview its own participant id, its label leading with the
  // effects icon (admission.ts). The bot's own tile holds an effects button too, so it's known by its id,
  // and only other tiles are filtered (seen live: an unanchored filter dropped the bot's own tile).
  const effects = /^(visual_effects|backgrounds and effects)/i;
  let others = 0;
  tiles.forEach((el) => {
    const id = el.getAttribute("data-participant-id");
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
    if (id && id !== self && !effects.test(label)) others++;
  });
  return others ? "others" : "alone";
}

/** Runs in the Meet page: what the participant tiles hold, for the log while the check can't tell (names
 *  shortened; ids cut to their tail). */
export function meetTilesDebug(): string {
  const tiles = Array.from(document.querySelectorAll("[data-participant-id]")).slice(0, 12).map((el) => ({
    id: (el.getAttribute("data-participant-id") || "").slice(-10),
    aria: (el.getAttribute("aria-label") || "").slice(0, 60),
    names: Array.from(el.querySelectorAll("span.notranslate")).map((s) => (s.textContent || "").trim().slice(0, 30)).slice(0, 3),
    marked: !!el.querySelector("[data-self-name]"),
    nested: el.querySelectorAll("[data-participant-id]").length,
    text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
  }));
  const labels = Array.from(document.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label") || "")
    .filter((l) => /people|participant|everyone|only one|you're the/i.test(l)).slice(0, 8).map((l) => l.slice(0, 60));
  const selfNames = Array.from(document.querySelectorAll("[data-self-name]"))
    .map((e) => (e.getAttribute("data-self-name") || "").slice(0, 30)).slice(0, 3);
  return JSON.stringify({ tiles, labels, selfNames });
}

export function startGoogleEveryoneLeftMonitor(
  page: Page,
  onEveryoneLeft: () => void | Promise<void>,
  opts: { aloneMs?: number; pollMs?: number; lastHeardAt?: () => number | undefined; botName?: string } = {},
): () => void {
  const aloneMs = opts.aloneMs ?? EVERYONE_LEFT_MS;
  let seenOther = false;  // a bot that's early, before anyone joins, isn't "left alone" (Vexa's own rule covers that)
  let since: number | null = null;
  let busy = false;
  let done = false;
  let last: MeetPresence | null = null;  // logged on change
  let dumpedAt = 0;
  const timer = setInterval(async () => {
    if (done || busy) return;
    busy = true;
    let state: MeetPresence = "unknown: page error";
    try { state = await page.evaluate(meetPresence, opts.botName ?? ""); } catch { /* page closing: don't know */ }
    busy = false;
    if (done) return;
    if (state !== last) log(`everyone-left: ${state}${seenOther ? "" : " (nobody else seen yet)"}`);
    last = state;
    if (state.startsWith("unknown") && Date.now() - dumpedAt > 60_000) {  // ponytail: diagnostic, drop once the DOM is known
      dumpedAt = Date.now();
      try { log(`everyone-left tiles: ${await page.evaluate(meetTilesDebug)}`); } catch { /* page closing */ }
    }
    if (state === "others") seenOther = true;
    if (state !== "alone" || !seenOther) { since = null; return; }
    const now = Date.now();
    since ??= now;
    if (now - since < aloneMs) return;
    if (opts.lastHeardAt) {  // nobody heard for the window either; no audio reading at all (capture down) is "don't know"
      const heard = opts.lastHeardAt();
      if (heard === undefined || now - heard < aloneMs) return;
    }
    done = true;
    clearInterval(timer);
    log(`🚪 Only the bot has been in the Google Meet for ${Math.round((now - since) / 1000)}s, leaving`);
    try { await onEveryoneLeft(); } catch {}
  }, opts.pollMs ?? 5000);
  return () => { done = true; clearInterval(timer); };
}
