// Music files the venue uploads (MP3, M4A). Stored in DATA_DIR/music, tags read with
// music-metadata (pure JS). Search is local. Playback goes to an Output: the box's speakers
// (box 0.15.0), or the speaker page. The source keeps one song playing and at most one
// waiting ("next"), like any other source; the app's queue holds the rest.

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseFile } from "music-metadata";
import { log } from "@bargames/gamekit/server";
import { normalize, type LibraryTrack, type SourceStatus, type Track } from "@music/shared";
import type { Store } from "../store.js";
import type { Output, OutputEvent } from "../outputs/types.js";
import { SourceError, type MusicSource, type SourceNowPlaying } from "./types.js";

const EXT = new Map([
  [".mp3", "mp3"],
  [".m4a", "m4a"],
  [".mp4", "m4a"],
  [".aac", "m4a"],
]);

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The uploaded songs. */
export class Library {
  readonly dir: string;
  readonly artDir: string;

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = path.join(dataDir, "music");
    this.artDir = path.join(this.dir, "art");
  }

  async init(): Promise<void> {
    await mkdir(this.artDir, { recursive: true });
  }

  all(): LibraryTrack[] {
    return this.store.library;
  }
  find(id: string): LibraryTrack | null {
    return this.store.library.find((t) => t.id === id) ?? null;
  }
  bytes(): number {
    return this.store.library.reduce((n, t) => n + t.size, 0);
  }

  /** Streams an upload to disk, reads its tags, adds it. */
  async add(body: Readable, originalName: string, maxBytes: number): Promise<LibraryTrack> {
    const ext = EXT.get(path.extname(originalName).toLowerCase());
    if (!ext) throw new LibraryError("Only MP3 and M4A files can be uploaded.");
    const id = randomBytes(8).toString("hex");
    const file = `${id}.${ext}`;
    const tmp = path.join(this.dir, `.incoming-${id}`);
    let size = 0;
    try {
      await pipeline(
        body,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            size += chunk.length;
            if (size > maxBytes) throw new LibraryError(`That file is bigger than ${Math.round(maxBytes / 1e6)} MB.`, 413);
            yield chunk;
          }
        },
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (size === 0) throw new LibraryError("That file is empty.");
      let meta;
      try {
        meta = await parseFile(tmp, { duration: true });
      } catch {
        throw new LibraryError("That file isn't an audio file this app can read.");
      }
      const container = String(meta.format.container ?? "").toLowerCase();
      const codec = String(meta.format.codec ?? "").toLowerCase();
      const okFormat = ext === "mp3" ? /mpeg|mp3/.test(container + codec) : /mp4|m4a|aac|isom|alac/.test(container + codec);
      if (!okFormat || !meta.format.duration) throw new LibraryError("That file isn't an MP3 or M4A song this app can read.");
      await rename(tmp, path.join(this.dir, file));
      const c = meta.common;
      const base = path.basename(originalName, path.extname(originalName));
      const pic = c.picture?.[0];
      let hasArt = false;
      if (pic && pic.data.length < 5_000_000 && /^image\/(jpeg|jpg|png|webp)$/i.test(pic.format)) {
        await writeFile(path.join(this.artDir, id), pic.data, { mode: 0o600 });
        await writeFile(path.join(this.artDir, `${id}.type`), pic.format.toLowerCase().replace("image/jpg", "image/jpeg"), { mode: 0o600 });
        hasArt = true;
      }
      const guess = base.split(" - ");
      const track: LibraryTrack = {
        id,
        file,
        title: (c.title || (guess.length > 1 ? guess.slice(1).join(" - ") : base)).slice(0, 200),
        artist: (c.artist || (c.artists ?? []).join(", ") || (guess.length > 1 ? guess[0]! : "Unknown artist")).slice(0, 200),
        album: (c.album ?? "").slice(0, 200),
        durationMs: Math.round(meta.format.duration * 1000),
        hasArt,
        explicit: false,
        addedAt: this.now(),
        size,
      };
      this.store.library.push(track);
      await this.store.saveLibrary();
      log.info("library", "added", { id, sizeKb: Math.round(size / 1024) });
      return track;
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async update(id: string, patch: { title?: unknown; artist?: unknown; album?: unknown; explicit?: unknown }): Promise<LibraryTrack> {
    const t = this.find(id);
    if (!t) throw new LibraryError("That song isn't in the library.", 404);
    const text = (v: unknown, label: string) => {
      const s = String(v ?? "").trim();
      if (!s) throw new LibraryError(`${label} can't be empty.`);
      return s.slice(0, 200);
    };
    if (patch.title !== undefined) t.title = text(patch.title, "The title");
    if (patch.artist !== undefined) t.artist = text(patch.artist, "The artist");
    if (patch.album !== undefined) t.album = String(patch.album ?? "").trim().slice(0, 200);
    if (patch.explicit !== undefined) t.explicit = !!patch.explicit;
    await this.store.saveLibrary();
    return t;
  }

  async remove(id: string): Promise<void> {
    const t = this.find(id);
    if (!t) throw new LibraryError("That song isn't in the library.", 404);
    this.store.library = this.store.library.filter((x) => x !== t);
    await this.store.saveLibrary();
    await rm(path.join(this.dir, t.file), { force: true });
    await rm(path.join(this.artDir, t.id), { force: true });
    await rm(path.join(this.artDir, `${t.id}.type`), { force: true });
  }

  /** Every query word must appear in the title, artist or album. Title matches first. */
  search(q: string, limit: number): LibraryTrack[] {
    const words = normalize(q).split(" ").filter(Boolean);
    if (!words.length) return [];
    const scored: { t: LibraryTrack; score: number }[] = [];
    for (const t of this.store.library) {
      const title = normalize(t.title);
      const titleWords = title.split(" ");
      const all = [...titleWords, ...normalize(t.artist).split(" "), ...normalize(t.album).split(" ")];
      // Every query word starts a word of the title, artist or album ("beat" finds "Beatles").
      if (!words.every((w) => all.some((x) => x.startsWith(w)))) continue;
      const score = (words.every((w) => titleWords.some((x) => x.startsWith(w))) ? 2 : 0) + (title.startsWith(words[0]!) ? 1 : 0);
      scored.push({ t, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title))
      .slice(0, limit)
      .map((x) => x.t);
  }

  async exists(t: LibraryTrack): Promise<boolean> {
    return stat(path.join(this.dir, t.file)).then(
      () => true,
      () => false,
    );
  }
}

export const FILE_PREFIX = "file:";

export class FilesSource implements MusicSource {
  readonly id = "files" as const;
  readonly label = "Music files";
  readonly can = { search: true, queueTrack: true, skip: true, pause: true, readQueue: false };
  readonly pollMs = { playing: 2000, idle: 5000 };
  readonly leadMs = 10_000;
  private current: { track: Track; lib: LibraryTrack; output: Output } | null = null;
  private next: Track | null = null;
  private listeners: (() => void)[] = [];
  private wired = new WeakSet<Output>();
  /** Staff chose to take over a busy box output for the next start. */
  replaceOnce = false;
  problem = "";

  constructor(
    private readonly library: Library,
    private readonly output: () => Output,
    private readonly artUrl: (t: LibraryTrack) => string | undefined,
  ) {}

  toTrack(t: LibraryTrack): Track {
    return { sourceId: `${FILE_PREFIX}${t.id}`, title: t.title, artist: t.artist, album: t.album || undefined, art: this.artUrl(t), durationMs: t.durationMs, explicit: t.explicit };
  }

  private lib(track: Track): LibraryTrack {
    const id = track.sourceId.startsWith(FILE_PREFIX) ? track.sourceId.slice(FILE_PREFIX.length) : "";
    const t = this.library.find(id);
    if (!t) throw new SourceError("gone", `"${track.title}" isn't in the library any more, so it was dropped from the queue.`);
    return t;
  }

  private wire(out: Output): void {
    if (this.wired.has(out)) return;
    this.wired.add(out);
    out.onEvent((e) => void this.onOutput(out, e));
  }

  private async onOutput(out: Output, e: OutputEvent): Promise<void> {
    const cur = this.current;
    if (!cur || cur.output !== out || cur.lib.id !== e.trackId) return;
    this.current = null;
    if (e.type === "error") {
      this.problem = e.message;
      this.next = null;
      log.warn("files", "playback failed", { reason: e.message });
    } else {
      // An early end says why ("Replaced by something else on Bar amp."); the next start
      // then fails in plain words if the speaker is still taken.
      if (e.message) log.info("files", "song ended early", { reason: e.message });
      await this.startNext();
    }
    this.changed();
  }

  private async startNext(): Promise<void> {
    const n = this.next;
    this.next = null;
    if (!n) return;
    try {
      await this.startNow(n);
    } catch (err) {
      this.problem = (err as Error).message;
    }
  }

  private async startNow(track: Track): Promise<void> {
    const lib = this.lib(track);
    const out = this.output();
    this.wire(out);
    const replace = this.replaceOnce;
    await out.start(lib, { replace });
    this.replaceOnce = false;
    this.problem = "";
    this.current = { track, lib, output: out };
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  async status(): Promise<SourceStatus> {
    if (!this.library.all().length) return { state: "setup", message: "The library is empty. Upload MP3 or M4A files in the admin." };
    const r = await this.output().ready();
    if (this.problem) return { state: "error", message: this.problem };
    return { state: r.ok ? "ok" : "warn", message: r.message };
  }

  async search(q: string, limit: number): Promise<Track[]> {
    return this.library.search(q, limit).map((t) => this.toTrack(t));
  }

  async get(sourceId: string): Promise<Track | null> {
    const t = sourceId.startsWith(FILE_PREFIX) ? this.library.find(sourceId.slice(FILE_PREFIX.length)) : null;
    return t ? this.toTrack(t) : null;
  }

  async play(track: Track): Promise<void> {
    this.lib(track);
    if (this.current) {
      this.next = track;
      return;
    }
    await this.startNow(track);
  }

  async nowPlaying(): Promise<SourceNowPlaying | null> {
    const cur = this.current;
    if (!cur) return null;
    const pos = await cur.output.position().catch(() => null);
    if (!pos || pos.trackId !== cur.lib.id) return { track: cur.track, progressMs: 0, playing: true };
    return { track: cur.track, progressMs: pos.positionMs, playing: pos.playing };
  }

  async skip(): Promise<void> {
    const cur = this.current;
    this.current = null;
    if (cur) await cur.output.stop();
    await this.startNext();
    this.changed();
  }

  async pause(): Promise<void> {
    if (!this.current) throw new SourceError("other", "Nothing is playing.");
    await this.current.output.pause();
  }

  async resume(): Promise<void> {
    if (!this.current) throw new SourceError("other", "Nothing is paused.");
    await this.current.output.resume();
  }

  async setVolume(volume: number): Promise<void> {
    const out = this.current?.output;
    if (!out?.setVolume) throw new SourceError("other", "The volume can change here only while a song plays on a box speaker.");
    await out.setVolume(volume);
  }

  /** The output changed: stop what's playing on the old one. */
  async stopAll(): Promise<void> {
    const cur = this.current;
    this.current = null;
    this.next = null;
    if (cur) await cur.output.stop().catch(() => undefined);
    this.changed();
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }
}
