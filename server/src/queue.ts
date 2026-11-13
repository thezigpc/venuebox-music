// The request queue. The app owns it, not the music service: songs wait here (staff can
// approve, reorder and remove them) and go to the source one at a time, shortly before the
// current song ends. Pure state plus a change callback; the player (player.ts) drives it.

import { randomBytes } from "node:crypto";
import { checkRequest, type QueueItem, type RuleBlock, type Rules, type Track } from "@music/shared";
import type { StoredQueue } from "./store.js";

const DAY = 24 * 3600_000;
const ACTIVE = new Set(["pending", "queued", "handed", "playing"]);

export class QueueError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export type RequestResult = { ok: true; item: QueueItem } | { ok: false; block: RuleBlock };

export class RequestQueue {
  constructor(
    private readonly data: StoredQueue,
    private readonly rules: () => Rules,
    private readonly now: () => number = Date.now,
    private readonly changed: () => void = () => undefined,
  ) {
    this.prune();
  }

  /** Pending, queued, handed and playing items, in order. */
  get active(): QueueItem[] {
    return this.data.items.filter((i) => ACTIVE.has(i.status));
  }
  pending = () => this.data.items.filter((i) => i.status === "pending");
  /** Approved and waiting, in play order. */
  queued = () => this.data.items.filter((i) => i.status === "queued");
  handed = () => this.data.items.filter((i) => i.status === "handed");
  playing = () => this.data.items.find((i) => i.status === "playing") ?? null;
  find = (id: string) => this.data.items.find((i) => i.id === id) ?? null;
  get plays() {
    return this.data.plays;
  }

  /** Checks the rules and adds the request (pending, or queued when approval is automatic). */
  request(track: Track, guest: { id: string; name: string }, opts: { staff?: boolean } = {}): RequestResult {
    const now = this.now();
    const rules = this.rules();
    const block = checkRequest(track, {
      rules,
      guestId: guest.id,
      now,
      active: this.active,
      requests: this.data.requests,
      plays: this.data.plays,
      staff: opts.staff,
    });
    if (block) return { ok: false, block };
    const item: QueueItem = {
      id: randomBytes(6).toString("hex"),
      track,
      guestId: guest.id,
      guestName: guest.name,
      requestedAt: now,
      status: opts.staff || rules.approval === "auto" ? "queued" : "pending",
      ...(opts.staff ? { byStaff: true } : {}),
    };
    this.data.items.push(item);
    if (!opts.staff) this.data.requests.push({ guestId: guest.id, at: now, sourceId: track.sourceId });
    this.prune();
    this.changed();
    return { ok: true, item };
  }

  private need(id: string, ...states: QueueItem["status"][]): QueueItem {
    const item = this.find(id);
    if (!item) throw new QueueError("That song isn't in the queue any more.", 404);
    if (!states.includes(item.status)) {
      throw new QueueError(item.status === "handed" || item.status === "playing" ? "That song has already gone to the music player, so it can't change now." : "That song has moved on already.");
    }
    return item;
  }

  approve(id: string): QueueItem {
    const item = this.need(id, "pending");
    item.status = "queued";
    // Approved songs go to the end of the queue, in approval order.
    this.data.items.splice(this.data.items.indexOf(item), 1);
    this.data.items.push(item);
    this.changed();
    return item;
  }

  reject(id: string): QueueItem {
    const item = this.need(id, "pending");
    item.status = "rejected";
    item.endedAt = this.now();
    this.changed();
    return item;
  }

  remove(id: string): QueueItem {
    const item = this.need(id, "pending", "queued");
    item.status = "removed";
    item.endedAt = this.now();
    this.changed();
    return item;
  }

  /** Moves a queued song to position `to` (0 = next) among the queued songs. */
  move(id: string, to: number): void {
    const item = this.need(id, "queued");
    const queued = this.queued().filter((i) => i !== item);
    const at = Math.max(0, Math.min(queued.length, Math.floor(to)));
    queued.splice(at, 0, item);
    // Keep everything else where it was; rewrite the queued ones in their new order.
    const others = this.data.items.filter((i) => i.status !== "queued");
    this.data.items = [...others, ...queued];
    this.changed();
  }

  /** The next song to hand over. */
  next(): QueueItem | null {
    return this.queued()[0] ?? null;
  }

  markHanded(id: string): void {
    const item = this.need(id, "queued");
    item.status = "handed";
    item.handedAt = this.now();
    this.changed();
  }

  /** The source refused it: back to the front of the queue (it stays for staff to retry or remove). */
  unhand(id: string): void {
    const item = this.find(id);
    if (item?.status === "handed") {
      item.status = "queued";
      delete item.handedAt;
      this.data.items.splice(this.data.items.indexOf(item), 1);
      const others = this.data.items.filter((i) => i.status !== "queued");
      this.data.items = [...others, item, ...this.queued()];
      this.changed();
    }
  }

  markPlaying(id: string): void {
    const item = this.need(id, "handed", "queued");
    item.status = "playing";
    item.startedAt = this.now();
    this.data.plays.push({ sourceId: item.track.sourceId, at: item.startedAt });
    this.changed();
  }

  finish(id: string, outcome: "played" | "skipped" | "failed"): QueueItem | null {
    const item = this.find(id);
    if (!item || !ACTIVE.has(item.status)) return null;
    item.status = outcome;
    item.endedAt = this.now();
    this.prune();
    this.changed();
    return item;
  }

  /** A song the source chose itself (a playlist on Spotify) also counts for "no repeats". */
  notePlay(sourceId: string): void {
    this.data.plays.push({ sourceId, at: this.now() });
    this.changed();
  }

  /** The guest's requests: waiting ones and the last day's finished ones. */
  forGuest(guestId: string): QueueItem[] {
    return this.data.items.filter((i) => i.guestId === guestId && !i.byStaff);
  }

  /** Drops finished items after a day, and the request and play logs after a day. */
  private prune(): void {
    const cutoff = this.now() - DAY;
    this.data.items = this.data.items.filter((i) => ACTIVE.has(i.status) || (i.endedAt ?? i.requestedAt) > cutoff);
    if (this.data.items.length > 1000) {
      const keep = new Set(this.data.items.filter((i) => ACTIVE.has(i.status)));
      const done = this.data.items.filter((i) => !keep.has(i)).slice(-500);
      this.data.items = this.data.items.filter((i) => keep.has(i) || done.includes(i));
    }
    this.data.requests = this.data.requests.filter((r) => r.at > cutoff);
    this.data.plays = this.data.plays.filter((r) => r.at > cutoff).slice(-2000);
  }
}
