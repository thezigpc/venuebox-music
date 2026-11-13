// The box's audio outputs (box 0.15.0, SDK 0.13.0). The box fetches the file from our own
// server (/box-audio/<file>, for the box only) and plays it on the output the venue set up.
// We never pair Bluetooth or touch sound hardware ourselves.

import { log } from "@bargames/gamekit/server";
import type { Audio } from "@bargames/sdk/server";
import type { LibraryTrack, OutputChoice } from "@music/shared";
import { SourceError } from "../sources/types.js";
import type { Output, OutputEvent, OutputPosition } from "./types.js";

/** The box's outputs as choices for the staff page (the venue's names). */
export async function boxOutputs(audio: Audio): Promise<OutputChoice[]> {
  if (!audio.onBox) return [];
  try {
    const list = await audio.outputs();
    return list.map((o) => ({
      id: `box:${o.id}`,
      name: o.default ? `${o.name} (venue default)` : o.name,
      kind: "box" as const,
      available: o.available,
      busy: o.busy,
      detail: o.detail,
      volume: o.volume,
    }));
  } catch (err) {
    log.warn("audio", "listing outputs failed", { err: String(err) });
    return [];
  }
}

export class BoxOutput implements Output {
  readonly id: string;
  readonly label: string;
  private session: { id: string; output: string; trackId: string } | null = null;
  private listeners: ((e: OutputEvent) => void)[] = [];
  private unwatch: (() => void) | null = null;

  /** `outputId` absent: the venue's default output. */
  constructor(
    private readonly audio: Audio,
    private readonly outputId: string | undefined,
    label: string,
    private readonly watchMs = 1000,
  ) {
    this.id = outputId ? `box:${outputId}` : "box";
    this.label = label;
  }

  async ready(): Promise<{ ok: boolean; message: string }> {
    if (!this.audio.onBox) return { ok: false, message: "Not on a Bar Games box." };
    try {
      const outs = await this.audio.outputs();
      const o = this.outputId ? outs.find((x) => x.id === this.outputId) : outs.find((x) => x.default);
      if (!o) return { ok: false, message: this.outputId ? "That speaker isn't set up on the box any more. Pick another." : "The box has no default speaker. Set one under Settings → Connected devices." };
      if (!o.available) return { ok: false, message: `${o.name} can't play right now${o.detail ? ` (${o.detail})` : ""}.` };
      return { ok: true, message: o.busy ? `${o.name} is in use by another app.` : `Playing on ${o.name}.` };
    } catch (err) {
      return { ok: false, message: `The box's speakers can't be listed: ${(err as Error).message}` };
    }
  }

  private ensureWatch(): void {
    if (this.unwatch) return;
    this.unwatch = this.audio.watch(
      (sessions) => {
        const s = this.session;
        if (!s) return;
        const mine = sessions.find((x) => x.id === s.id);
        if (!mine) return;
        if (mine.state === "ended") {
          this.session = null;
          this.emit({ type: "ended", trackId: s.trackId, ...(mine.message ? { message: mine.message } : {}) });
        } else if (mine.state === "error") {
          this.session = null;
          this.emit({ type: "error", trackId: s.trackId, message: mine.message || "The box couldn't play that song." });
        }
      },
      this.watchMs,
      (err) => log.warn("audio", "watch failed", { err: String(err) }),
    );
  }

  private emit(e: OutputEvent): void {
    for (const l of this.listeners) l(e);
  }

  async start(track: LibraryTrack, opts: { replace?: boolean } = {}): Promise<void> {
    this.ensureWatch();
    const old = this.session;
    try {
      const s = await this.audio.play({
        path: `/box-audio/${encodeURIComponent(track.file)}`,
        ...(this.outputId ? { output: this.outputId } : {}),
        title: track.title,
        artist: track.artist,
        album: track.album || undefined,
        durationMs: track.durationMs || undefined,
        ...(opts.replace ? { replace: true } : {}),
      });
      // Playing on the same output replaces our own previous session; forget it quietly.
      this.session = { id: s.id, output: s.output, trackId: track.id };
      if (old && old.id !== s.id) log.info("audio", "replaced own session", {});
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) throw new SourceError("busy", `${(err as Error).message || "Another app is playing on that speaker."} Staff can take it over from the staff page.`);
      if (status === 403) throw new SourceError("setup", "The box won't let this app play sound (bargames.json needs \"audio\": { \"play\": true }).");
      throw new SourceError("other", `The box couldn't play it: ${(err as Error).message}`);
    }
  }

  async pause(): Promise<void> {
    if (this.session) await this.audio.pause(this.session.id);
  }
  async resume(): Promise<void> {
    if (this.session) await this.audio.resume(this.session.id);
  }
  async stop(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) await this.audio.stop(s.id).catch(() => undefined);
  }

  async position(): Promise<OutputPosition | null> {
    const s = this.session;
    if (!s) return null;
    const sessions = await this.audio.sessions();
    const mine = sessions.find((x) => x.id === s.id);
    if (!mine) return null;
    if (mine.state === "ended" || mine.state === "error") return null;
    return { trackId: s.trackId, positionMs: mine.positionMs, playing: mine.state === "playing" || mine.state === "starting" };
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.session) throw new SourceError("other", "The volume can change only while a song plays here.");
    await this.audio.setVolume(this.session.output, Math.max(0, Math.min(100, Math.round(volume))));
  }

  onEvent(cb: (e: OutputEvent) => void): void {
    this.listeners.push(cb);
  }

  close(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.listeners = [];
  }
}
