// The request rules: one pure function, so the server and the tests agree on every case.

import type { QueueItem, RuleBlock, Rules, Track } from "./types.js";

/** Lower case, no accents, punctuation as spaces, single spaces. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `needle` appears in `hay` as whole words ("ac dc" in "ac dc live", not "acdc"). */
export function containsWords(hay: string, needle: string): boolean {
  const h = ` ${normalize(hay)} `;
  const n = normalize(needle);
  return n.length > 0 && h.includes(` ${n} `);
}

export interface RuleContext {
  rules: Rules;
  guestId: string;
  now: number;
  /** Songs still waiting or playing (pending, queued, handed, playing). */
  active: QueueItem[];
  /** Every request in the last day: who and when (the rate rule). */
  requests: { guestId: string; at: number; sourceId: string }[];
  /** Songs that played recently (the repeat rule). */
  plays: { sourceId: string; at: number }[];
  /** Staff add songs past the guest rules (only the source's own limits apply). */
  staff?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minutesLeft = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** null when the request may go ahead; otherwise which rule stopped it, in plain words. */
export function checkRequest(track: Track, ctx: RuleContext): RuleBlock | null {
  const r = ctx.rules;
  const staff = !!ctx.staff;

  if (!staff && !r.requestsOpen) return { rule: "closed", message: "Requests are turned off right now." };

  const waiting = ctx.active.filter((i) => i.status === "pending" || i.status === "queued");
  if (!staff && r.maxQueue > 0 && waiting.length >= r.maxQueue) {
    return { rule: "full", message: "The queue is full right now. Try again after a few songs have played." };
  }

  if (!staff) {
    if (r.blockExplicit && track.explicit) return { rule: "explicit", message: "Explicit songs can't be requested here." };
    if (r.blockedArtists.some((a) => containsWords(track.artist, a))) {
      return { rule: "artist", message: "Songs by that artist can't be requested here." };
    }
    const words = `${track.title} ${track.artist} ${track.album ?? ""}`;
    if (r.blockedWords.some((w) => containsWords(words, w))) {
      return { rule: "word", message: "That song has a word in it that's blocked here." };
    }
    if (r.maxSongMinutes > 0 && track.durationMs > r.maxSongMinutes * 60_000) {
      return { rule: "length", message: `That song is longer than ${plural(r.maxSongMinutes, "minute")}, the longest allowed here.` };
    }
  }

  // Already waiting: never twice in the queue, staff included.
  if (ctx.active.some((i) => i.track.sourceId === track.sourceId)) {
    return { rule: "repeat", message: "That song is already in the queue." };
  }
  if (!staff && r.noRepeatMinutes > 0) {
    const windowMs = r.noRepeatMinutes * 60_000;
    const last = Math.max(
      0,
      ...ctx.plays.filter((p) => p.sourceId === track.sourceId).map((p) => p.at),
      ...ctx.requests.filter((p) => p.sourceId === track.sourceId).map((p) => p.at),
    );
    if (last && ctx.now - last < windowMs) {
      return {
        rule: "repeat",
        message: `That song was played or requested in the last ${plural(r.noRepeatMinutes, "minute")}. Try again in ${plural(minutesLeft(last + windowMs - ctx.now), "minute")}.`,
      };
    }
  }

  if (!staff) {
    const mine = waiting.filter((i) => i.guestId === ctx.guestId);
    if (r.maxPendingPerGuest > 0 && mine.length >= r.maxPendingPerGuest) {
      return {
        rule: "pending",
        message: `You already have ${plural(mine.length, "song")} waiting. You can request another once one plays.`,
      };
    }
    if (r.perGuestCount > 0 && r.perGuestMinutes > 0) {
      const windowMs = r.perGuestMinutes * 60_000;
      const recent = ctx.requests.filter((q) => q.guestId === ctx.guestId && ctx.now - q.at < windowMs).sort((a, b) => a.at - b.at);
      if (recent.length >= r.perGuestCount) {
        const freeAt = recent[recent.length - r.perGuestCount]!.at + windowMs;
        return {
          rule: "rate",
          message: `You can request ${plural(r.perGuestCount, "song")} every ${plural(r.perGuestMinutes, "minute")}. Try again in ${plural(minutesLeft(freeAt - ctx.now), "minute")}.`,
        };
      }
    }
  }
  return null;
}

/** The rules in plain words, for the guest page. */
export function describeRules(r: Rules): string[] {
  const out: string[] = [];
  if (r.perGuestCount > 0 && r.perGuestMinutes > 0) out.push(`Up to ${plural(r.perGuestCount, "request")} every ${plural(r.perGuestMinutes, "minute")}.`);
  if (r.maxPendingPerGuest > 0) out.push(`Up to ${plural(r.maxPendingPerGuest, "song")} waiting at a time.`);
  if (r.noRepeatMinutes > 0) out.push(`No repeats within ${plural(r.noRepeatMinutes, "minute")}.`);
  if (r.blockExplicit) out.push("No explicit songs.");
  if (r.maxSongMinutes > 0) out.push(`Songs up to ${plural(r.maxSongMinutes, "minute")} long.`);
  if (r.approval === "staff") out.push("Staff approve each request.");
  return out;
}

/** Checks and cleans a rules patch from the admin; throws with a plain message. */
export function cleanRules(base: Rules, patch: Record<string, unknown>): Rules {
  const out: Rules = { ...base, blockedArtists: [...base.blockedArtists], blockedWords: [...base.blockedWords] };
  const int = (key: keyof Rules, min: number, max: number, label: string) => {
    if (patch[key] === undefined) return;
    const v = Number(patch[key]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    (out as unknown as Record<string, unknown>)[key] = v;
  };
  int("perGuestCount", 0, 50, "Requests per guest");
  int("perGuestMinutes", 0, 600, "The request window");
  int("maxPendingPerGuest", 0, 50, "Songs waiting per guest");
  int("noRepeatMinutes", 0, 1440, "No repeats within");
  int("maxSongMinutes", 0, 120, "The longest song");
  int("maxQueue", 0, 500, "The longest queue");
  if (patch.requestsOpen !== undefined) out.requestsOpen = !!patch.requestsOpen;
  if (patch.blockExplicit !== undefined) out.blockExplicit = !!patch.blockExplicit;
  if (patch.approval !== undefined) {
    if (patch.approval !== "staff" && patch.approval !== "auto") throw new Error("Approval must be staff or auto.");
    out.approval = patch.approval;
  }
  const list = (key: "blockedArtists" | "blockedWords") => {
    const v = patch[key];
    if (v === undefined) return;
    const arr = Array.isArray(v) ? v : String(v).split(/[\n,]/);
    out[key] = [...new Set(arr.map((x) => String(x).trim()).filter((x) => x && normalize(x)))].slice(0, 500).map((x) => x.slice(0, 80));
  };
  list("blockedArtists");
  list("blockedWords");
  return out;
}
