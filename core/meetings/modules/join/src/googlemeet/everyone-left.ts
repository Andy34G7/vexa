import { Page } from "playwright";
import { log } from "../_host";

// neu-meet patch: Vexa 0.12 only decides "alone" from silence (10 minutes of no remote audio), so a bot left
// behind in a call that's still open records an empty room for 10 minutes. This counts the people instead:
// once someone else has been in the call, and then for EVERYONE_LEFT_MS only the bot's own tile is on the
// page and nobody is heard, everyone has left. A wrong leave can't be undone (the meeting counts as served),
// so anything unclear is "don't know", and the silence rule stays as the backstop.
// ponytail: reads Meet's tiles; if Meet stops rendering them the check never fires (fails safe).
export const EVERYONE_LEFT_MS = 60 * 1000;

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
  // any of its name spans (seen live: the tile holds three, the bot's name in the second)
  const namedAll = tiles.filter((el) => !!botName && Array.from(el.querySelectorAll("span.notranslate"))
    .some((s) => s.textContent?.trim() === botName));
  // two tiles named as the bot (someone with its name, or a second bot): can't tell which is ours
  if (namedAll.length > 1 && !document.querySelector("[data-self-name]")) return "unknown: more than one tile has the bot's name";
  const named = namedAll[0];
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

/** Runs in the Meet page: the shape of the participant tiles, for the log while the check can't tell (ids cut to
 *  their tail). No tile names or text, which are participants' names: only whether a tile holds the bot's name. */
export function meetTilesDebug(botName: string): string {
  const tiles = Array.from(document.querySelectorAll("[data-participant-id]")).slice(0, 12).map((el) => {
    const spans = Array.from(el.querySelectorAll("span.notranslate"));
    return {
      id: (el.getAttribute("data-participant-id") || "").slice(-10),
      named: !!botName && spans.some((s) => s.textContent?.trim() === botName),
      spans: spans.length,
      marked: !!el.querySelector("[data-self-name]"),
      nested: el.querySelectorAll("[data-participant-id]").length,
    };
  });
  // Meet's own control labels (e.g. "Chat with everyone"), for a future People-count check. Only labels made of these
  // words and digits are logged; any other, which may hold a participant's name (e.g. a host's "Mute X for everyone"),
  // is only counted
  const words = new Set(["show", "everyone", "people", "participant", "participants", "chat", "with", "you're", "the",
    "only", "one", "here", "meeting"]);
  const found = Array.from(document.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label") || "")
    .filter((l) => /people|participant|everyone|only one|you're the/i.test(l));
  const labels = found.filter((l) => l.toLowerCase().replace(/’/g, "'").split(/[\s\d(),.:]+/).every((w) => !w || words.has(w)));
  return JSON.stringify({ tiles, labels: labels.slice(0, 8).map((l) => l.slice(0, 60)), otherLabels: found.length - labels.length });
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
    if (state === "others") seenOther = true;  // before the log line, which would call this one "nobody else seen yet"
    if (state !== last) log(`everyone-left: ${state}${seenOther ? "" : " (nobody else seen yet)"}`);
    last = state;
    if (state.startsWith("unknown") && Date.now() - dumpedAt > 60_000) {  // ponytail: diagnostic, drop once the DOM is known
      dumpedAt = Date.now();
      try { log(`everyone-left tiles: ${await page.evaluate(meetTilesDebug, opts.botName ?? "")}`); } catch { /* page closing */ }
    }
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
