// Drives the queue: asks the source what's playing, notices when a handed song starts or the
// current one ends, and hands the next song over one at a time, shortly before the current
// song ends (or at once when nothing plays). The same logic for every source.

import { log } from "@bargames/gamekit/server";
import type { NowPlaying, QueueItem, SourceId } from "@music/shared";
import type { RequestQueue } from "./queue.js";
import { SourceError, type MusicSource, type SourceNowPlaying } from "./sources/types.js";

export interface PlayerEvents {
  nowPlaying(np: { title: string; artist: string; guestName: string; requested: boolean }): void;
  finished(item: QueueItem | null, np: { title: string; artist: string; album?: string; guestName: string; requested: boolean; source: SourceId }, outcome: "played" | "skipped"): void;
}

interface Opts {
  queue: RequestQueue;
  source: () => MusicSource | null;
  events: PlayerEvents;
  now?: () => number;
  /** Tests: no timers; they call tick() themselves. */
  manual?: boolean;
}

/** A handed song that hasn't started this long after it was due is given up on. */
const START_GRACE_MS = 90_000;

export class Player {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  private retryAt = 0;
  /** What the source last said. */
  last: SourceNowPlaying | null = null;
  lastAt = 0;
  /** The source's own song (not a request) we last saw, for history. */
  private background: { sourceId: string; title: string; artist: string; album?: string } | null = null;
  /** When each handed song should have started by. */
  private dueBy = new Map<string, number>();
  /** Staff paused here: don't start the next song on our own. */
  pausedByStaff = false;
  /** The current song is being skipped by staff (history says "skipped"). */
  private skipping: string | null = null;
  problem = "";
  /** What kind of failure `problem` is ("busy": another app has the speaker). */
  problemKind = "";
  private failed = false;
  /** The song we last saw end (it may linger, stopped, on the player). */
  private ended: string | null = null;
  private watched: MusicSource | null = null;

  constructor(private readonly o: Opts) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.schedule(500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Something changed (a request approved, the source switched): look again now. */
  poke(): void {
    if (this.o.manual) return;
    this.schedule(50);
  }

  private schedule(ms: number): void {
    if (this.stopped || this.o.manual) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    await this.tick();
    const src = this.o.source();
    if (!src) return this.schedule(5000);
    const wait = Math.max(this.retryAt - this.now(), this.last?.playing ? src.pollMs.playing : src.pollMs.idle);
    this.schedule(wait);
  }

  /** Reacts to the source changing on its own. */
  private watch(src: MusicSource): void {
    if (this.watched === src) return;
    this.watched = src;
    src.onChange?.(() => this.poke());
  }

  /** One pass. Never throws; failures land in `problem`. */
  async tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        this.failed = false;
        await this.pass();
        if (!this.failed) {
          this.problem = "";
          this.problemKind = "";
        }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private fail(err: unknown, what: string): void {
    this.failed = true;
    this.problemKind = err instanceof SourceError ? err.kind : "other";
    if (err instanceof SourceError) {
      this.problem = err.message;
      if (err.retryAfterMs) this.retryAt = this.now() + err.retryAfterMs;
    } else {
      this.problem = `${what} failed. It will try again.`;
      log.warn("player", `${what} failed`, { err: String(err) });
    }
  }

  private async pass(): Promise<void> {
    const src = this.o.source();
    const q = this.o.queue;
    if (!src) {
      this.last = null;
      return;
    }
    this.watch(src);
    if (this.now() < this.retryAt) {
      this.failed = true;
      return;
    }

    let np: SourceNowPlaying | null;
    try {
      np = await src.nowPlaying();
    } catch (err) {
      return this.fail(err, "Reading what's playing");
    }
    this.last = np;
    this.lastAt = this.now();
    const curId = np?.track?.sourceId ?? null;

    // 1. Did one of our handed songs start?
    const handed = q.handed();
    const started = curId ? handed.find((i) => i.track.sourceId === curId) : undefined;
    const playing = q.playing();
    if (started) {
      if (playing && playing.id !== started.id) this.end(playing, src);
      this.endBackground(src);
      // Handed songs before it never started: the source dropped them.
      for (const h of handed) {
        if (h === started) break;
        q.finish(h.id, "failed");
        this.dueBy.delete(h.id);
      }
      q.markPlaying(started.id);
      this.dueBy.delete(started.id);
      this.o.events.nowPlaying({ title: started.track.title, artist: started.track.artist, guestName: started.guestName, requested: !started.byStaff });
    } else if (playing && (playing.track.sourceId !== curId || this.endedInPlace(np!, playing))) {
      this.end(playing, src);
    }
    if (curId !== this.ended) this.ended = null;

    // 2. The source's own music (a playlist running on Spotify): history and "no repeats".
    if (np?.track && !q.playing() && curId && this.background?.sourceId !== curId && !(curId === this.ended && !np.playing)) {
      this.endBackground(src);
      this.background = { sourceId: curId, title: np.track.title, artist: np.track.artist, album: np.track.album };
      q.notePlay(curId);
      this.o.events.nowPlaying({ title: np.track.title, artist: np.track.artist, guestName: "", requested: false });
    } else if (!np?.track) {
      this.endBackground(src);
    }

    // The source is holding the queue (speaker stopped, taken or gone): hand nothing over;
    // songs already handed go back to the queue. Staff carry on with resume().
    const hold = src.hold?.();
    if (hold) {
      for (const h of q.handed()) {
        q.unhand(h.id);
        this.dueBy.delete(h.id);
      }
      this.failed = true;
      this.problem = hold.message;
      this.problemKind = hold.reason === "replaced" ? "busy" : "held";
      return;
    }

    // 3. A handed song that never started: give up on it so the queue keeps moving.
    for (const h of q.handed()) {
      const due = this.dueBy.get(h.id) ?? (h.handedAt ?? this.now()) + START_GRACE_MS + 10 * 60_000;
      if (this.now() > due) {
        q.finish(h.id, "failed");
        this.dueBy.delete(h.id);
        this.failed = true;
        this.problem = `"${h.track.title}" was sent to ${src.label} but never started, so it was dropped.`;
      }
    }

    // 4. Hand the next song over.
    if (q.handed().length) return;
    const next = q.next();
    if (!next) return;
    const nowItem = q.playing();
    const remaining = np?.track && np.progressMs !== undefined ? np.track.durationMs - np.progressMs : 0;
    const idle =
      !np ||
      !np.track ||
      (!np.playing && !this.pausedByStaff && (remaining < 3000 || (nowItem === null && this.background === null)));
    const soon = !!np?.playing && remaining <= src.leadMs;
    if (!idle && !soon) return;
    try {
      await src.play(next.track);
    } catch (err) {
      if (err instanceof SourceError && err.kind === "gone") q.finish(next.id, "failed");
      return this.fail(err, `Sending "${next.track.title}" to ${src.label}`);
    }
    q.markHanded(next.id);
    this.dueBy.set(next.id, this.now() + (idle ? 0 : Math.max(0, remaining)) + START_GRACE_MS);
    if (idle) this.pausedByStaff = false;
    // Started at once? The next pass sees it; look again soon.
    this.again = true;
  }

  /** Some players stop on the last song instead of clearing it (Spotify at the end of its queue). */
  private endedInPlace(np: SourceNowPlaying, item: QueueItem): boolean {
    if (np.playing || this.pausedByStaff) return false;
    const pos = np.progressMs ?? 0;
    return pos >= item.track.durationMs - 3000 || (pos === 0 && this.now() - (item.startedAt ?? 0) > 10_000);
  }

  private end(item: QueueItem, src: MusicSource): void {
    const outcome = this.skipping === item.id ? "skipped" : "played";
    if (this.skipping === item.id) this.skipping = null;
    this.ended = item.track.sourceId;
    this.o.queue.finish(item.id, outcome);
    this.o.events.finished(item, { title: item.track.title, artist: item.track.artist, album: item.track.album, guestName: item.guestName, requested: !item.byStaff, source: src.id }, outcome);
  }

  private endBackground(src: MusicSource): void {
    if (!this.background) return;
    const b = this.background;
    this.background = null;
    this.o.events.finished(null, { title: b.title, artist: b.artist, album: b.album, guestName: "", requested: false, source: src.id }, "played");
  }

  /** What's playing, for the pages (null when nothing is). */
  nowPlaying(): (NowPlaying & { itemId: string | null }) | null {
    const np = this.last;
    if (!np?.track) return null;
    const item = this.o.queue.playing();
    const mine = item && item.track.sourceId === np.track.sourceId ? item : null;
    return {
      title: np.track.title,
      artist: np.track.artist,
      album: np.track.album,
      art: np.track.art,
      durationMs: np.track.durationMs,
      progressMs: np.progressMs ?? 0,
      playing: np.playing,
      guestName: mine?.guestName ?? "",
      requested: !!mine && !mine.byStaff,
      at: this.lastAt,
      itemId: mine?.id ?? null,
    };
  }

  /** Staff: skip. The next song is handed over first, so the request plays next (not the source's own pick). */
  async skip(): Promise<void> {
    const src = this.need();
    if (!src.skip) throw new SourceError("other", `${src.label} can't skip from here.`);
    const q = this.o.queue;
    const next = q.next();
    if (next && !q.handed().length && this.last?.track) {
      await src.play(next.track);
      q.markHanded(next.id);
      this.dueBy.set(next.id, this.now() + START_GRACE_MS);
    }
    const cur = q.playing();
    if (cur) this.skipping = cur.id;
    await src.skip();
    this.pausedByStaff = false;
    await this.tick();
  }

  async pause(): Promise<void> {
    const src = this.need();
    if (!src.pause) throw new SourceError("other", `${src.label} can't pause from here.`);
    await src.pause();
    this.pausedByStaff = true;
    await this.tick();
  }

  async resume(): Promise<void> {
    const src = this.need();
    if (src.hold?.()) {
      // Carry on after a hold: the next song starts.
      src.release?.();
      this.pausedByStaff = false;
      return this.tick();
    }
    if (!src.resume) throw new SourceError("other", `${src.label} can't resume from here.`);
    await src.resume();
    this.pausedByStaff = false;
    await this.tick();
  }

  /** The source changed: forget what the old one was doing. Handed songs go back to the queue. */
  reset(): void {
    for (const h of this.o.queue.handed()) this.o.queue.unhand(h.id);
    const p = this.o.queue.playing();
    if (p) this.o.queue.finish(p.id, "played");
    this.last = null;
    this.background = null;
    this.dueBy.clear();
    this.pausedByStaff = false;
    this.problem = "";
    this.retryAt = 0;
    this.watched = null;
    this.poke();
  }

  private need(): MusicSource {
    const src = this.o.source();
    if (!src) throw new SourceError("setup", "Pick a music source in the admin first.");
    return src;
  }
}

