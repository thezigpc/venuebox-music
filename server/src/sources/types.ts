// The one interface every music service sits behind. The app owns requests, rules and the
// queue; a source only searches, plays one song (now, or right after the current one) and
// says what's playing. `can` tells the pages what to hide.

import type { SourceCan, SourceId, SourceStatus, Track } from "@music/shared";

export interface SourceNowPlaying {
  track?: Track;
  progressMs?: number;
  playing: boolean;
}

export interface SourceHold {
  reason: "stopped" | "replaced" | "disconnected";
  /** For staff, in plain words. */
  message: string;
}

export interface MusicSource {
  id: SourceId;
  label: string;
  can: SourceCan;
  status(): Promise<SourceStatus>;
  search(q: string, limit: number): Promise<Track[]>;
  /** Start now when nothing plays, or queue right after the current song. */
  play(track: Track): Promise<void>;
  nowPlaying(): Promise<SourceNowPlaying | null>;
  skip?(): Promise<void>;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  /** Optional: one track by id (sources that can look one up cheaply). */
  get?(sourceId: string): Promise<Track | null>;
  /** Optional: called when playback changes on its own (a song ended), so the app reacts at once. */
  onChange?(cb: () => void): void;
  /**
   * Optional: the source is holding the queue (the speaker was stopped, taken by another
   * app or went away). The app hands nothing over until staff carry on (`release`).
   */
  hold?(): SourceHold | null;
  release?(): void;
  /** How often to ask nowPlaying(), playing and idle. */
  pollMs: { playing: number; idle: number };
  /** Hand the next song over this long before the current one ends. */
  leadMs: number;
}

/** "gone": that song can't be played at all (deleted from the library): drop it, don't retry. */
export type SourceErrorKind = "gone" | "setup" | "auth" | "no-device" | "rate" | "busy" | "premium" | "network" | "other";

/** A source failure, in plain words for staff. `retryAfterMs` on 429s. */
export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    readonly retryAfterMs = 0,
    readonly status = 409,
  ) {
    super(message);
  }
}
