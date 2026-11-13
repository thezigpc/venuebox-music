// Test doubles: a fake music source, a fake Spotify (Web API + accounts), a fake box audio
// API, a tiny valid MP3, and an in-process app.

import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Audio } from "@bargames/sdk/server";
import type { Track } from "@music/shared";
import { makeBarGames } from "../src/bargames.js";
import { createApp, type AppOptions, type MusicApp } from "../src/app.js";
import type { MusicSource, SourceNowPlaying } from "../src/sources/types.js";

export const track = (id: string, extra: Partial<Track> = {}): Track => ({
  sourceId: id,
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  durationMs: 200_000,
  ...extra,
});

/** A source that plays like Spotify: one current song and a one-slot "next". Time is manual. */
export class FakeSource implements MusicSource {
  id = "spotify" as const;
  label = "Fake";
  can = { search: true, queueTrack: true, skip: true, pause: true, readQueue: false };
  pollMs = { playing: 1000, idle: 1000 };
  leadMs = 15_000;
  current: { track: Track; progressMs: number; playing: boolean } | null = null;
  upcoming: Track[] = [];
  played: string[] = [];
  calls: string[] = [];
  catalog: Track[] = [];
  failPlay: Error | null = null;

  async status() {
    return { state: "ok" as const, message: "ok" };
  }
  async search(q: string) {
    return this.catalog.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));
  }
  async play(t: Track) {
    if (this.failPlay) throw this.failPlay;
    this.calls.push(`play:${t.sourceId}`);
    if (this.current?.playing) this.upcoming.push(t);
    else this.startTrack(t);
  }
  private startTrack(t: Track) {
    this.current = { track: t, progressMs: 0, playing: true };
    this.played.push(t.sourceId);
  }
  async nowPlaying(): Promise<SourceNowPlaying | null> {
    return this.current ? { track: this.current.track, progressMs: this.current.progressMs, playing: this.current.playing } : null;
  }
  async skip() {
    this.calls.push("skip");
    this.end();
  }
  async pause() {
    if (this.current) this.current.playing = false;
  }
  async resume() {
    if (this.current) this.current.playing = true;
  }
  /** Moves time on: the current song progresses, and the next starts when it ends. */
  advance(ms: number) {
    if (!this.current?.playing) return;
    this.current.progressMs += ms;
    if (this.current.progressMs >= this.current.track.durationMs) this.end();
  }
  end() {
    const n = this.upcoming.shift();
    if (n) this.startTrack(n);
    else this.current = null;
  }
}

/** A fake box audio API: three outputs; sessions end when the test says so. */
export class FakeAudio {
  onBox = true;
  sessions: { id: string; output: string; owner: string; state: "starting" | "playing" | "paused" | "ended" | "error"; positionMs: number; title?: string; startedAt: string; message?: string; path: string }[] = [];
  watchers: ((s: unknown[]) => void)[] = [];
  busy = new Set<string>();
  fetched: { path: string; status: number }[] = [];
  volumes: [string, number][] = [];
  private n = 0;
  constructor(private readonly appUrl: () => string, private readonly token: string) {}

  api(): Audio {
    const self = this;
    return {
      onBox: true,
      outputs: async () => [
        { id: "box:0-0", name: "Bar amp", kind: "box" as const, available: true, default: true, volume: 60 },
        { id: "bt:11", name: "Patio speaker", kind: "bluetooth" as const, available: true, default: false, volume: 50, busy: this.busy.has("bt:11") },
      ],
      play: async (o) => {
        const output = o.output ?? "box:0-0";
        if (this.busy.has(output) && !o.replace) {
          const e = new Error("Another app (Karaoke) is playing on Patio speaker.") as Error & { status: number };
          e.status = 409;
          throw e;
        }
        // Like the real box: fetch the file from the app with the token.
        const res = await fetch(this.appUrl() + o.path, { headers: { authorization: `Bearer ${this.token}`, "x-bargames-audio": "1", range: "bytes=0-" } });
        this.fetched.push({ path: o.path, status: res.status });
        await res.arrayBuffer();
        for (const s of this.sessions) if (s.output === output && s.state !== "ended") s.state = "ended";
        const s = { id: `s${++this.n}`, output, owner: "app:music", state: (res.ok ? "playing" : "error") as "playing" | "error", positionMs: 0, title: o.title, startedAt: new Date().toISOString(), path: o.path, ...(res.ok ? {} : { message: "The app's audio file wasn't found." }) };
        this.sessions.push(s);
        if (!res.ok) queueMicrotask(() => this.notify());
        return { ...s };
      },
      sessions: async () => this.sessions.map((s) => ({ ...s })),
      pause: async (id) => this.set(id, "paused"),
      resume: async (id) => this.set(id, "playing"),
      stop: async (id) => this.set(id, "ended"),
      setVolume: async (output, volume) => {
        this.volumes.push([output, volume]);
        return { id: output, name: "x", kind: "box" as const, available: true, default: false, volume };
      },
      watch(cb) {
        self.watchers.push(cb as (s: unknown[]) => void);
        return () => (self.watchers = self.watchers.filter((w) => w !== cb));
      },
    } as Audio;
  }
  private set(id: string, state: "paused" | "playing" | "ended") {
    const s = this.sessions.find((x) => x.id === id)!;
    s.state = state;
    return { ...s };
  }
  notify() {
    for (const w of this.watchers) w(this.sessions.map((s) => ({ ...s })));
  }
  /** The song on `id` reached its end (or failed, with a message). */
  finish(id: string, message?: string) {
    const s = this.sessions.find((x) => x.id === id)!;
    s.state = "ended";
    if (message) s.message = message;
    this.notify();
  }
}

// ------------------------------------------------------------------ fake Spotify

export interface FakeSpotify {
  fetch: typeof fetch;
  log: string[];
  state: { playing: boolean; item: Track | null; progressMs: number; queue: string[]; activeDevice: boolean };
  tokens: { access: string[]; refresh: string[] };
  next429: boolean;
  failRefresh: boolean;
}

const spTrack = (t: Track) => ({
  uri: t.sourceId,
  name: t.title,
  duration_ms: t.durationMs,
  explicit: !!t.explicit,
  type: "track",
  artists: [{ name: t.artist }],
  album: { name: t.album ?? "Album", images: [{ url: "https://i.scdn.co/image/big", width: 640 }, { url: "https://i.scdn.co/image/mid", width: 300 }] },
});

export const CLIENT_ID = "0123456789abcdef0123456789abcdef";

export function fakeSpotify(catalog: Track[]): FakeSpotify {
  let n = 0;
  const sp: FakeSpotify = {
    log: [],
    state: { playing: false, item: null, progressMs: 0, queue: [], activeDevice: true },
    tokens: { access: [], refresh: [] },
    next429: false,
    failRefresh: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
      sp.log.push(`${method} ${url.pathname}${url.search}`);
      if (url.hostname === "accounts.test") {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (form.get("client_id") !== CLIENT_ID) return json(400, { error: "invalid_client" });
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "good-code-1234567890" || !form.get("code_verifier")) return json(400, { error: "invalid_grant" });
        } else if (form.get("grant_type") === "refresh_token") {
          if (sp.failRefresh || !sp.tokens.refresh.includes(form.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant" });
        }
        const access = `AT-secret-${++n}`;
        const refresh = `RT-secret-${n}`;
        sp.tokens.access.push(access);
        sp.tokens.refresh.push(refresh);
        return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600, scope: "user-read-playback-state user-modify-playback-state" });
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (!sp.tokens.access.some((a) => auth === `Bearer ${a}`)) return json(401, { error: { status: 401, message: "The access token expired" } });
      if (sp.next429) {
        sp.next429 = false;
        return json(429, null, { "retry-after": "1" });
      }
      const p = url.pathname.replace(/^\/v1/, "");
      if (p === "/me") return json(200, { id: "venueacct", display_name: "Venue Account" });
      if (p === "/search") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const limit = Number(url.searchParams.get("limit"));
        if (limit > 10) return json(400, { error: { status: 400, message: "Invalid limit" } });
        return json(200, { tracks: { items: catalog.filter((t) => t.title.toLowerCase().includes(q)).slice(0, limit).map(spTrack) } });
      }
      if (p === "/me/player" && method === "GET") {
        if (!sp.state.item) return new Response(null, { status: 204 });
        return json(200, { is_playing: sp.state.playing, progress_ms: sp.state.progressMs, item: spTrack(sp.state.item), device: { id: "dev1", name: "Bar PC" } });
      }
      if (p === "/me/player/devices") return json(200, { devices: [{ id: "dev1", name: "Bar PC", type: "Computer", is_active: sp.state.activeDevice, is_restricted: false, volume_percent: 70 }] });
      if (!sp.state.activeDevice && !url.searchParams.get("device_id")) return json(404, { error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" } });
      if (p === "/me/player/queue" && method === "POST") {
        sp.state.queue.push(url.searchParams.get("uri")!);
        return new Response(null, { status: 204 });
      }
      if (p === "/me/player/play" && method === "PUT") {
        const body = init?.body ? (JSON.parse(String(init.body)) as { uris?: string[] }) : {};
        if (body.uris?.[0]) {
          sp.state.item = catalog.find((t) => t.sourceId === body.uris![0]) ?? null;
          sp.state.progressMs = 0;
        }
        sp.state.playing = true;
        return new Response(null, { status: 204 });
      }
      if (p === "/me/player/pause") {
        sp.state.playing = false;
        return new Response(null, { status: 204 });
      }
      if (p === "/me/player/next") {
        const nextUri = sp.state.queue.shift();
        sp.state.item = nextUri ? (catalog.find((t) => t.sourceId === nextUri) ?? null) : null;
        sp.state.progressMs = 0;
        sp.state.playing = !!sp.state.item;
        return new Response(null, { status: 204 });
      }
      return json(404, { error: { status: 404, message: "no route" } });
    }) as typeof fetch,
  };
  return sp;
}

// ------------------------------------------------------------------ a tiny MP3

/** A real MPEG-1 Layer III file (silent frames) with ID3v2.3 title/artist/album tags. */
export function makeMp3(tags: { title?: string; artist?: string; album?: string } = {}, seconds = 3): Buffer {
  const frame = (id: string, text: string) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]);
    const h = Buffer.alloc(10);
    h.write(id, 0, "latin1");
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const frames = Buffer.concat([
    ...(tags.title ? [frame("TIT2", tags.title)] : []),
    ...(tags.artist ? [frame("TPE1", tags.artist)] : []),
    ...(tags.album ? [frame("TALB", tags.album)] : []),
  ]);
  const size = frames.length;
  const syncsafe = Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const id3 = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), syncsafe, frames]);
  // 128 kbps, 44.1 kHz, no padding, mono: 417-byte frames of 1152 samples (~26.1 ms).
  const header = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
  const one = Buffer.concat([header, Buffer.alloc(417 - 4)]);
  const count = Math.ceil((seconds * 44100) / 1152);
  return Buffer.concat([id3, ...Array.from({ length: count }, () => one)]);
}

// ------------------------------------------------------------------ the app in-process

export interface TestApp {
  url: string;
  music: MusicApp;
  token: string;
  dataDir: string;
  get(p: string, token?: string, headers?: Record<string, string>): Promise<Response>;
  send(method: string, p: string, body?: unknown, token?: string, headers?: Record<string, string>): Promise<Response>;
  /** An admin call that must succeed. */
  call<T = unknown>(method: string, p: string, body?: unknown): Promise<T>;
  stop(): Promise<void>;
}

export async function startApp(opts: Partial<AppOptions> & { coreUrl?: string; coreToken?: string } = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "music-test-"));
  const bg = opts.bg ?? makeBarGames({ defaultName: "Music Requests", coreUrl: opts.coreUrl, token: opts.coreToken });
  const music = await createApp({ dataDir, bg, adminPassword: "test-password-1", manualPlayer: true, ...opts });
  const server = http.createServer(music.app);
  music.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(url + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password-1" }) });
  const token = ((await login.json()) as { token: string }).token;
  const t: TestApp = {
    url,
    music,
    token,
    dataDir,
    get: (p, tok, headers = {}) => fetch(url + p, { headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers } }),
    send: (method, p, body, tok, headers = {}) =>
      fetch(url + p, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    async call<T>(method: string, p: string, body?: unknown) {
      const res = await t.send(method, `/api/admin${p}`, body ?? (method === "GET" || method === "DELETE" ? undefined : {}), token);
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      return json as T;
    },
    async stop() {
      await music.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return t;
}

export async function until(fn: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Captures console output (the kit's logger and the SDK write there) while `fn` runs. */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const grab = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  console.log = console.info = console.warn = console.error = console.debug = grab;
  try {
    const result = await fn();
    return { result, logs: lines.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}

/** Records every console line from now on (still printing it), until `restore()`. */
export function teeLogs(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
    console[k] = (...a: unknown[]) => {
      lines.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? `${x.message} ${x.stack}` : JSON.stringify(x))).join(" "));
      orig[k](...a);
    };
  }
  return { text: () => lines.join("\n"), restore: () => void Object.assign(console, orig) };
}
