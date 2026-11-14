// Where the files source's sound comes out. Two kinds behind one small interface:
//   - the box's audio outputs (jack, HDMI, Bluetooth, AirPlay TVs), through the SDK (0.13.0+);
//   - the speaker page (/speaker), a browser on a PC or tablet wired to the sound system.

import type { AudioEndReason } from "@bargames/sdk/server";
import type { LibraryTrack } from "@music/shared";

/**
 * Why a song stopped (box 0.15.4, SDK 0.13.1); absent from older boxes and the speaker page.
 *   finished: played to the end; stopped: staff or another app stopped it, or the box
 *   restarted; replaced: something else started on that output; disconnected: the speaker
 *   or TV went away; error: it couldn't play.
 */
export type EndReason = AudioEndReason;

export type OutputEvent =
  | { type: "ended"; trackId: string; message?: string; reason?: EndReason }
  | { type: "error"; trackId: string; message: string; reason?: EndReason };

export interface OutputPosition {
  trackId: string;
  positionMs: number;
  playing: boolean;
}

export interface Output {
  readonly id: string;
  readonly label: string;
  /** Can it play now? (A message for staff when not.) */
  ready(): Promise<{ ok: boolean; message: string }>;
  start(track: LibraryTrack, opts?: { replace?: boolean }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  position(): Promise<OutputPosition | null>;
  setVolume?(volume: number): Promise<void>;
  onEvent(cb: (e: OutputEvent) => void): void;
  /** Stop listening (the output is being replaced). */
  close(): void;
}
