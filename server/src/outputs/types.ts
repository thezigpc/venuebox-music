// Where the files source's sound comes out. Two kinds behind one small interface:
//   - the box's audio outputs (jack, HDMI, Bluetooth, AirPlay TVs), through SDK 0.13.0;
//   - the speaker page (/speaker), a browser on a PC or tablet wired to the sound system.

import type { LibraryTrack } from "@music/shared";

export type OutputEvent = { type: "ended"; trackId: string; message?: string } | { type: "error"; trackId: string; message: string };

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
