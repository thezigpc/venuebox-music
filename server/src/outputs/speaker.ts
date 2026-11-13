// The speaker page (/speaker): a browser on a PC or tablet wired to the sound system. It
// plays what we send over socket.io and reports its progress back. Works with or without a
// box. Only staff can open it (admin session, or box staff); the newest open page plays and
// any older one stands by.

import { createHmac, randomBytes } from "node:crypto";
import type { Namespace, Socket } from "socket.io";
import { log } from "@bargames/gamekit/server";
import type { LibraryTrack } from "@music/shared";
import { SourceError } from "../sources/types.js";
import type { Output, OutputEvent, OutputPosition } from "./types.js";

/** Signs short-lived links to the audio files, so the page's <audio> can fetch them without a header. */
export class AudioLinks {
  private readonly key = randomBytes(32);
  constructor(private readonly now: () => number = Date.now) {}

  sign(file: string, ttlMs = 6 * 3600_000): string {
    const exp = this.now() + ttlMs;
    const sig = createHmac("sha256", this.key).update(`${file}\n${exp}`).digest("base64url");
    return `/speaker-audio/${encodeURIComponent(file)}?e=${exp}&s=${sig}`;
  }

  check(file: string, exp: string, sig: string): boolean {
    const e = Number(exp);
    if (!Number.isFinite(e) || e < this.now()) return false;
    const want = createHmac("sha256", this.key).update(`${file}\n${e}`).digest("base64url");
    return want.length === sig.length && want === sig;
  }
}

interface Current {
  track: LibraryTrack;
  positionMs: number;
  playing: boolean;
  at: number;
}

export class SpeakerOutput implements Output {
  readonly id = "speaker";
  readonly label = "Speaker page";
  private leader: Socket | null = null;
  private current: Current | null = null;
  private listeners: ((e: OutputEvent) => void)[] = [];
  private graceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ns: Namespace,
    private readonly links: AudioLinks,
    private readonly artUrl: (t: LibraryTrack) => string | undefined,
    private readonly now: () => number = Date.now,
    private readonly graceMs = 15_000,
  ) {
    ns.on("connection", (socket) => this.attach(socket));
  }

  get connected(): boolean {
    return !!this.leader?.connected;
  }

  private attach(socket: Socket): void {
    const old = this.leader;
    this.leader = socket;
    if (old && old.id !== socket.id) old.emit("standby", { message: "Another speaker page took over." });
    log.info("speaker", "speaker page connected", {});
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    socket.emit("hello", { ok: true });
    // A reload or a reconnect picks up where it was.
    if (this.current) this.send(this.current.track, this.current.positionMs, this.current.playing);

    socket.on("state", (m: { trackId?: string; positionMs?: number; playing?: boolean }) => {
      if (socket !== this.leader || !this.current || m?.trackId !== this.current.track.id) return;
      this.current.positionMs = Math.max(0, Number(m.positionMs) || 0);
      this.current.playing = !!m.playing;
      this.current.at = this.now();
    });
    socket.on("ended", (m: { trackId?: string }) => {
      if (socket !== this.leader || !this.current || m?.trackId !== this.current.track.id) return;
      const id = this.current.track.id;
      this.current = null;
      this.emit({ type: "ended", trackId: id });
    });
    socket.on("failed", (m: { trackId?: string; message?: string }) => {
      if (socket !== this.leader || !this.current || m?.trackId !== this.current.track.id) return;
      const id = this.current.track.id;
      this.current = null;
      this.emit({ type: "error", trackId: id, message: `The speaker page couldn't play it${m.message ? ` (${String(m.message).slice(0, 120)})` : ""}.` });
    });
    socket.on("disconnect", () => {
      if (socket !== this.leader) return;
      this.leader = null;
      log.info("speaker", "speaker page disconnected", {});
      if (!this.current) return;
      // Give a reload a moment before giving up on the song.
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.leader || !this.current) return;
        const id = this.current.track.id;
        this.current = null;
        this.emit({ type: "error", trackId: id, message: "The speaker page closed." });
      }, this.graceMs);
      this.graceTimer.unref?.();
    });
  }

  private send(track: LibraryTrack, startAtMs: number, playing: boolean): void {
    this.leader?.emit("load", {
      trackId: track.id,
      url: this.links.sign(track.file),
      title: track.title,
      artist: track.artist,
      art: this.artUrl(track),
      startAtMs,
      playing,
    });
  }

  private emit(e: OutputEvent): void {
    for (const l of this.listeners) l(e);
  }

  async ready(): Promise<{ ok: boolean; message: string }> {
    return this.connected ? { ok: true, message: "The speaker page is open." } : { ok: false, message: "Speaker page not open. Open /speaker on the computer wired to the sound system." };
  }

  async start(track: LibraryTrack): Promise<void> {
    if (!this.connected) throw new SourceError("no-device", "Speaker page not open. Open the speaker page on the computer wired to the sound system.");
    this.current = { track, positionMs: 0, playing: true, at: this.now() };
    this.send(track, 0, true);
  }

  async pause(): Promise<void> {
    if (this.current) this.current.playing = false;
    this.leader?.emit("pause");
  }
  async resume(): Promise<void> {
    if (this.current) this.current.playing = true;
    this.leader?.emit("resume");
  }
  async stop(): Promise<void> {
    this.current = null;
    this.leader?.emit("stop");
  }

  async position(): Promise<OutputPosition | null> {
    const c = this.current;
    if (!c) return null;
    const since = c.playing ? this.now() - c.at : 0;
    return { trackId: c.track.id, positionMs: Math.min(c.positionMs + since, c.track.durationMs || Infinity), playing: c.playing };
  }

  onEvent(cb: (e: OutputEvent) => void): void {
    this.listeners.push(cb);
  }

  /** The speaker output lives as long as the app; switching away just stops it. */
  close(): void {
    void this.stop();
  }
}
