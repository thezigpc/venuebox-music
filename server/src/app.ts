// The HTTP app: guest pages' API, the staff and admin API, the audio routes, the speaker
// socket and the built client. Built by a function so tests run it in-process with their
// own data dir, a fake Spotify and a fake box.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server as IoServer } from "socket.io";
import type { Audio, BarGames } from "@bargames/sdk/server";
import { adminRouter, createAdminAuth, createJsonStore, log, serveSpa, type AdminAuth } from "@bargames/gamekit/server";
import {
  cleanRules,
  DEFAULT_NAME,
  describeRules,
  normalize,
  type AdminState,
  type GuestState,
  type HistoryEntry,
  type HostState,
  type NowPlaying,
  type OutputChoice,
  type PublicItem,
  type PublicState,
  type QueueItem,
  type SourceId,
  type SourceStatus,
  type Track,
} from "@music/shared";
import { venueName } from "./bargames.js";
import { BoxOutput, boxOutputs } from "./outputs/box.js";
import { AudioLinks, SpeakerOutput } from "./outputs/speaker.js";
import type { Output } from "./outputs/types.js";
import { Player } from "./player.js";
import { QueueError, RequestQueue } from "./queue.js";
import { FilesSource, Library, LibraryError } from "./sources/files.js";
import { Spotify, type SpotifyUrls } from "./sources/spotify.js";
import { SourceError, type MusicSource } from "./sources/types.js";
import { Store } from "./store.js";

export interface AppOptions {
  dataDir: string;
  bg: BarGames;
  adminPassword?: string;
  gameName?: string;
  clientDist?: string;
  /** Path prefix for index.html (default: BG_BASE_PATH / BASE_PATH env). */
  basePath?: string;
  /** Standalone public address, for the TV's QR code. */
  publicUrl?: string;
  maxUploadBytes?: number;
  /** Outgoing HTTP to Spotify; tests pass a fake. */
  fetch?: typeof fetch;
  spotifyUrls?: Partial<SpotifyUrls>;
  /** The box's audio API (default: bg.audio); tests pass a fake. */
  audio?: Audio;
  now?: () => number;
  /** Tests: no player timers (they call player.tick()). */
  manualPlayer?: boolean;
  speakerGraceMs?: number;
}

export interface MusicApp {
  app: express.Express;
  io: IoServer;
  store: Store;
  auth: AdminAuth;
  queue: RequestQueue;
  player: Player;
  spotify: Spotify;
  files: FilesSource;
  library: Library;
  speaker: SpeakerOutput;
  /** Socket.io on the HTTP server (the speaker page). */
  attach(server: HttpServer): void;
  close(): Promise<void>;
}

const safe =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    void fn(req, res).catch(next);

const GUEST_COOKIE = "music_guest";
const GUEST_RE = /^[a-f0-9]{24}$/;
const FILE_RE = /^[a-f0-9]{16}\.(mp3|m4a)$/;
const ART_RE = /^[a-f0-9]{16}$/;

function readCookie(req: Request, name: string): string {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export async function createApp(o: AppOptions): Promise<MusicApp> {
  const now = o.now ?? Date.now;
  const bg = o.bg;
  const audio = o.audio ?? bg.audio;
  const basePath = (o.basePath ?? bg.basePath ?? "").replace(/\/+$/, "");
  const maxUpload = o.maxUploadBytes ?? 60e6;
  const store = new Store(o.dataDir);
  await store.init();

  // ---------------------------------------------------------------- name
  const fallbackName = () => store.settings.name || o.gameName || DEFAULT_NAME;
  let cachedName = fallbackName();
  const refreshName = async () => {
    cachedName = (await venueName(bg)) ?? fallbackName();
    return cachedName;
  };
  void refreshName();

  // ---------------------------------------------------------------- sources and outputs
  const spotify = new Spotify(store, o.fetch ?? fetch, now, o.spotifyUrls);
  const library = new Library(store, o.dataDir, now);
  await library.init();
  const artUrl = (t: { id: string; hasArt: boolean }) => (t.hasArt ? `art/${t.id}` : undefined);

  const io = new IoServer({ path: "/socket.io", serveClient: false, cors: { origin: false } });
  const links = new AudioLinks(now);
  const speakerNs = io.of("/speaker");
  const auth = createAdminAuth({
    store: createJsonStore(o.dataDir),
    envPassword: o.adminPassword ?? "",
    saltFormat: "bytes",
    failsAllowed: bg.connected ? undefined : Number.POSITIVE_INFINITY,
    venuePassword: (pw, ip) => bg.checkVenuePassword(pw, ip),
    onBox: bg.connected,
  });
  await auth.init();
  speakerNs.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if ((typeof token === "string" && auth.isValidSession(token)) || bg.isStaff(socket.request)) return next();
    next(new Error("Sign in as staff to open the speaker page."));
  });
  const speaker = new SpeakerOutput(speakerNs, links, artUrl, now, o.speakerGraceMs);

  const boxCache = new Map<string, BoxOutput>();
  function currentOutput(): Output {
    const sel = store.settings.output;
    if (sel === "speaker" || !audio.onBox) return speaker;
    const id = sel.startsWith("box:") ? sel.slice(4) : "";
    let out = boxCache.get(id);
    if (!out) {
      out = new BoxOutput(audio, id || undefined, id ? "Box speaker" : "The box's default speaker");
      boxCache.set(id, out);
    }
    return out;
  }

  const files = new FilesSource(library, currentOutput, artUrl);
  const sources: Record<SourceId, MusicSource> = { spotify, files };
  const source = (): MusicSource | null => (store.settings.source ? sources[store.settings.source] : null);

  // ---------------------------------------------------------------- queue and player
  const queue = new RequestQueue(store.queue, () => store.rules, now, () => store.later("queue", 500));
  const event = (type: `x-music-${string}`, data: Record<string, unknown>) => bg.emit({ type, data });

  const player = new Player({
    queue,
    source,
    now,
    manual: o.manualPlayer,
    events: {
      nowPlaying: (np) => event("x-music-now-playing", np),
      finished: (_item, np, outcome) => {
        const entry: HistoryEntry = { at: now(), title: np.title, artist: np.artist, album: np.album, source: np.source, guestName: np.guestName, requested: np.requested, outcome };
        store.history.unshift(entry);
        if (store.history.length > 500) store.history.length = 500;
        store.later("history", 2000);
        if (outcome === "skipped") event("x-music-skipped", { title: np.title, artist: np.artist });
      },
    },
  });
  player.start();

  // Track lookup for requests: never trust what the browser says about a song (its length
  // or explicit flag decide rules), so a request names a song the server has seen.
  const seen = new Map<string, { track: Track; at: number }>();
  const remember = (tracks: Track[]) => {
    for (const t of tracks) seen.set(t.sourceId, { track: t, at: now() });
    if (seen.size > 5000) for (const k of [...seen.keys()].slice(0, 1000)) seen.delete(k);
  };
  async function lookup(sourceId: string): Promise<Track | null> {
    const src = source();
    if (!src) return null;
    const fromSource = src.get ? await src.get(sourceId) : null;
    if (fromSource) return fromSource;
    const s = seen.get(sourceId);
    return s && now() - s.at < 6 * 3600_000 ? s.track : null;
  }

  // Search: a short cache (Spotify rate limits) and a per-guest cap.
  const searchCache = new Map<string, { at: number; tracks: Track[] }>();
  async function search(q: string): Promise<Track[]> {
    const src = source();
    if (!src) throw new SourceError("setup", "Music isn't set up yet.");
    const key = `${src.id}\n${normalize(q)}`;
    const hit = searchCache.get(key);
    if (hit && now() - hit.at < 10 * 60_000 && src.id === "spotify") return hit.tracks;
    const tracks = await src.search(q, 10);
    remember(tracks);
    if (src.id === "spotify") {
      searchCache.set(key, { at: now(), tracks });
      if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value!);
    }
    return tracks;
  }
  const searchTimes = new Map<string, number[]>();
  function searchAllowed(guest: string): boolean {
    const t = now();
    const list = (searchTimes.get(guest) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= 20) return false;
    list.push(t);
    searchTimes.set(guest, list);
    if (searchTimes.size > 5000) searchTimes.clear();
    return true;
  }

  // ---------------------------------------------------------------- views
  let guestUrlCache: { at: number; url: string | null } = { at: 0, url: null };
  async function guestUrl(): Promise<string | null> {
    if (now() - guestUrlCache.at < 60_000) return guestUrlCache.url;
    let url: string | null = null;
    if (bg.connected) url = (await bg.publicUrl("/").catch(() => undefined)) ?? null;
    else if (o.publicUrl) url = `${o.publicUrl}${basePath}/`;
    guestUrlCache = { at: now(), url };
    return url;
  }

  const publicItem = (i: QueueItem): PublicItem => ({
    id: i.id,
    title: i.track.title,
    artist: i.track.artist,
    art: i.track.art,
    durationMs: i.track.durationMs,
    guestName: i.guestName,
    locked: i.status === "handed",
  });
  const hideGuest = (i: QueueItem): QueueItem => ({ ...i, guestId: "" });
  const upNext = () => [...queue.handed(), ...queue.queued()];

  async function sourceStatus(): Promise<SourceStatus> {
    const src = source();
    if (!src) return { state: "setup", message: "Pick a music source in the admin." };
    try {
      return await src.status();
    } catch (err) {
      return { state: "error", message: (err as Error).message };
    }
  }

  async function outputChoices(): Promise<OutputChoice[]> {
    const out: OutputChoice[] = [];
    if (audio.onBox) {
      out.push({ id: "", name: "The venue's default speaker", kind: "box", available: true });
      out.push(...(await boxOutputs(audio)));
    }
    out.push({ id: "speaker", name: "Speaker page (a browser wired to the sound system)", kind: "speaker", available: speaker.connected, detail: speaker.connected ? "open" : "not open" });
    return out;
  }

  // ---------------------------------------------------------------- HTTP
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(bg.middleware());
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, source: store.settings.source, queued: queue.queued().length });
  });

  app.get(
    "/api/config",
    safe(async (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.json({ gameName: await refreshName() });
    }),
  );

  // The box fetches the files it plays from here, and only the box may (bg.fromBox checks
  // the game token). Range requests work (express.static).
  app.use(
    "/box-audio",
    (req, res, next) => (bg.fromBox(req) ? next() : void res.status(403).end()),
    express.static(library.dir, { index: false, dotfiles: "ignore", fallthrough: false, maxAge: 0 }),
  );

  // The speaker page's <audio> fetches signed links (no header needed, they expire).
  app.get("/speaker-audio/:file", (req, res) => {
    const file = String(req.params.file);
    if (!FILE_RE.test(file) || !links.check(file, String(req.query.e ?? ""), String(req.query.s ?? ""))) return void res.status(403).end();
    res.sendFile(file, { root: library.dir, dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.get(
    "/art/:id",
    safe(async (req, res) => {
      const id = String(req.params.id);
      if (!ART_RE.test(id)) return void res.status(404).end();
      const type = await readFile(path.join(library.artDir, `${id}.type`), "utf8").catch(() => "");
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return void res.status(404).end();
      res.type(type).set("Cache-Control", "public, max-age=86400");
      res.sendFile(id, { root: library.artDir }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    }),
  );

  /** The guest's id: one device = one cookie. */
  function guest(req: Request, res: Response): string {
    const have = readCookie(req, GUEST_COOKIE);
    if (GUEST_RE.test(have)) return have;
    const id = randomBytes(12).toString("hex");
    const secure = req.secure || (bg.connected ? req.headers["x-forwarded-proto"] === "https" : false);
    res.cookie(GUEST_COOKIE, id, { httpOnly: true, sameSite: "lax", path: basePath || "/", maxAge: 365 * 24 * 3600_000, secure });
    return id;
  }

  app.get(
    "/api/now",
    safe(async (_req, res) => {
      res.set("Cache-Control", "no-cache");
      const src = source();
      const np = player.nowPlaying();
      let nowPlaying: NowPlaying | null = null;
      if (np) {
        const { itemId: _, ...rest } = np;
        nowPlaying = rest;
      }
      const body: PublicState = {
        name: cachedName,
        requestsOpen: store.rules.requestsOpen && !!src,
        canSearch: !!src?.can.search,
        nowPlaying,
        upNext: upNext().slice(0, 20).map(publicItem),
        guestUrl: await guestUrl(),
      };
      res.json(body);
    }),
  );

  app.get("/api/me", (req, res) => {
    res.set("Cache-Control", "no-cache");
    const id = guest(req, res);
    const order = upNext();
    const body: GuestState = {
      requests: queue
        .forGuest(id)
        .slice(-20)
        .reverse()
        .map((i) => {
          const pos = order.indexOf(i);
          return { id: i.id, title: i.track.title, artist: i.track.artist, art: i.track.art, status: i.status, position: pos >= 0 ? pos + 1 : null, requestedAt: i.requestedAt };
        }),
      rulesText: describeRules(store.rules),
    };
    res.json(body);
  });

  app.get(
    "/api/search",
    safe(async (req, res) => {
      const id = guest(req, res);
      const q = String(req.query.q ?? "").trim();
      if (!q) return void res.json({ tracks: [] });
      if (q.length > 100) return void res.status(400).json({ ok: false, error: "That search is too long." });
      if (!searchAllowed(id)) return void res.status(429).json({ ok: false, error: "That's a lot of searching. Wait a minute and try again." });
      res.json({ tracks: await search(q) });
    }),
  );

  app.post(
    "/api/request",
    safe(async (req, res) => {
      const id = guest(req, res);
      const b = (req.body ?? {}) as { sourceId?: unknown; name?: unknown };
      const src = source();
      if (!src) return void res.status(409).json({ ok: false, rule: "source", error: "Music isn't set up yet." });
      const track = await lookup(String(b.sourceId ?? ""));
      if (!track) return void res.status(404).json({ ok: false, rule: "source", error: "Search for the song again, then request it." });
      const name = String(b.name ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24);
      if (name && store.rules.blockedWords.some((w) => normalize(name).includes(normalize(w)))) {
        return void res.status(409).json({ ok: false, rule: "word", error: "Pick another name." });
      }
      const r = queue.request(track, { id, name });
      if (!r.ok) return void res.status(409).json({ ok: false, rule: r.block.rule, error: r.block.message });
      event("x-music-requested", { title: track.title, artist: track.artist, guestName: name, needsApproval: r.item.status === "pending" });
      player.poke();
      res.json({ ok: true, status: r.item.status });
    }),
  );

  // ---------------------------------------------------------------- staff and admin
  const admin = adminRouter({ auth, clientIp: (req) => bg.clientIp(req), trusted: (req) => bg.isStaff(req) });

  admin.get(
    "/host",
    safe(async (_req, res) => {
      const src = source();
      const body: HostState = {
        rules: store.rules,
        source: store.settings.source,
        sourceLabel: src?.label ?? "",
        sourceStatus: await sourceStatus(),
        can: src?.can ?? { search: false, queueTrack: false, skip: false, pause: false, readQueue: false },
        nowPlaying: player.nowPlaying(),
        // Guests' cookie ids stay on the server.
        pending: queue.pending().map(hideGuest),
        queue: queue.queued().map(hideGuest),
        handed: queue.handed().map(hideGuest),
        problem: player.problem || (store.settings.source === "files" ? files.problem : ""),
        outputs: store.settings.source === "files" ? await outputChoices() : [],
        output: store.settings.output,
        speakerConnected: speaker.connected,
        busyOutput: player.problemKind === "busy" ? player.problem : null,
        // The queue waits after the speaker was stopped, taken or went away (box 0.15.4+).
        held: src?.hold?.()?.reason ?? null,
        notice: store.settings.source === "files" ? files.notice() : "",
      };
      res.json(body);
    }),
  );

  admin.get(
    "/state",
    safe(async (_req, res) => {
      const body: AdminState = {
        settings: store.settings,
        rules: store.rules,
        spotify: spotify.info(),
        library: { tracks: library.all(), bytes: library.bytes() },
        history: store.history.slice(0, 200),
        onBox: audio.onBox,
        outputs: await outputChoices(),
        sourceStatus: await sourceStatus(),
        publicUrl: (await guestUrl())?.replace(/\/+$/, "") ?? null,
      };
      res.json(body);
    }),
  );

  admin.put(
    "/settings",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as { name?: unknown; source?: unknown; output?: unknown };
      const s = store.settings;
      if (b.name !== undefined) {
        const n = String(b.name ?? "").trim();
        if (n.length > 40) throw new QueueError("The name can be at most 40 characters.", 400);
        s.name = n;
      }
      if (b.source !== undefined) {
        const v = b.source === null || b.source === "" ? null : String(b.source);
        if (v !== null && v !== "spotify" && v !== "files") throw new QueueError("Pick Spotify or Music files.", 400);
        if (v !== s.source) {
          if (s.source === "files") await files.stopAll();
          s.source = v as SourceId | null;
          player.reset();
        }
      }
      if (b.output !== undefined) {
        const v = String(b.output ?? "");
        if (v !== "" && v !== "speaker" && !/^box:[\w:.\-]{1,100}$/.test(v)) throw new QueueError("Pick one of the listed speakers.", 400);
        if (v !== s.output) {
          if (s.source === "files") await files.stopAll();
          s.output = v;
          player.reset();
        }
      }
      await store.saveSettings();
      await refreshName();
      res.json({ ok: true });
    }),
  );

  admin.put(
    "/rules",
    safe(async (req, res) => {
      let next;
      try {
        next = cleanRules(store.rules, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        throw new QueueError((err as Error).message, 400);
      }
      const wasOpen = store.rules.requestsOpen;
      const wasAuto = store.rules.approval === "auto";
      store.rules = next;
      await store.saveRules();
      if (wasOpen !== next.requestsOpen) event(next.requestsOpen ? "x-music-requests-open" : "x-music-requests-closed", {});
      // Switching to automatic lets what's waiting through.
      if (!wasAuto && next.approval === "auto") for (const p of queue.pending()) queue.approve(p.id);
      player.poke();
      res.json({ ok: true, rules: next });
    }),
  );

  admin.post("/requests/:id/approve", (req, res) => {
    const item = queue.approve(String(req.params.id));
    event("x-music-approved", { title: item.track.title, artist: item.track.artist, guestName: item.guestName });
    player.poke();
    res.json({ ok: true });
  });
  admin.post("/requests/:id/reject", (req, res) => {
    const item = queue.reject(String(req.params.id));
    event("x-music-rejected", { title: item.track.title, artist: item.track.artist });
    res.json({ ok: true });
  });
  admin.post("/queue/:id/move", (req, res) => {
    queue.move(String(req.params.id), Number((req.body as { to?: unknown })?.to ?? 0));
    res.json({ ok: true });
  });
  admin.delete("/queue/:id", (req, res) => {
    queue.remove(String(req.params.id));
    res.json({ ok: true });
  });

  admin.get(
    "/search",
    safe(async (req, res) => {
      const q = String(req.query.q ?? "").trim().slice(0, 100);
      res.json({ tracks: q ? await search(q) : [] });
    }),
  );
  admin.post(
    "/queue",
    safe(async (req, res) => {
      const track = await lookup(String((req.body as { sourceId?: unknown })?.sourceId ?? ""));
      if (!track) throw new QueueError("Search for the song again, then add it.", 404);
      const r = queue.request(track, { id: "staff", name: "" }, { staff: true });
      if (!r.ok) throw new QueueError(r.block.message);
      player.poke();
      res.json({ ok: true });
    }),
  );

  admin.post(
    "/player/:action",
    safe(async (req, res) => {
      const a = String(req.params.action);
      if (a === "skip") await player.skip();
      else if (a === "pause") await player.pause();
      else if (a === "resume") await player.resume();
      else if (a === "takeover") {
        files.release();
        files.replaceOnce = true;
        player.poke();
      } else if (a === "volume") {
        const v = Number((req.body as { volume?: unknown })?.volume);
        if (!Number.isFinite(v)) throw new QueueError("Pick a volume from 0 to 100.", 400);
        if (store.settings.source !== "files") throw new QueueError("Change the volume in Spotify.", 400);
        await files.setVolume(v);
      } else return void res.status(404).json({ ok: false, error: "Not found." });
      res.json({ ok: true });
    }),
  );

  // ---- Spotify setup (credentials stay here; the browser gets only the authorize URL)
  admin.post(
    "/spotify/consent",
    safe(async (_req, res) => {
      await spotify.consent();
      res.json({ ok: true });
    }),
  );
  admin.put(
    "/spotify/client",
    safe(async (req, res) => {
      await spotify.setClientId(String((req.body as { clientId?: unknown })?.clientId ?? ""));
      res.json({ ok: true });
    }),
  );
  admin.post(
    "/spotify/login",
    safe(async (req, res) => {
      const url = await spotify.beginLogin(String((req.body as { redirectUri?: unknown })?.redirectUri ?? ""));
      res.json({ ok: true, url });
    }),
  );
  admin.post(
    "/spotify/callback",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as { url?: unknown; code?: unknown; state?: unknown };
      await spotify.finishLogin(b.url !== undefined ? { url: String(b.url) } : { code: String(b.code ?? ""), state: String(b.state ?? "") });
      if (!store.settings.source) {
        store.settings.source = "spotify";
        await store.saveSettings();
      }
      player.reset();
      res.json({ ok: true });
    }),
  );
  admin.get(
    "/spotify/devices",
    safe(async (_req, res) => {
      res.json({ ok: true, devices: await spotify.devices() });
    }),
  );
  admin.put(
    "/spotify/device",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as { id?: unknown; name?: unknown };
      await spotify.setDevice(String(b.id ?? ""), String(b.name ?? ""));
      player.poke();
      res.json({ ok: true });
    }),
  );
  admin.post(
    "/spotify/signout",
    safe(async (_req, res) => {
      await spotify.signOut();
      player.reset();
      res.json({ ok: true });
    }),
  );

  // ---- Library (files source)
  admin.post(
    "/library",
    safe(async (req, res) => {
      const name = decodeURIComponent(String(req.headers["x-filename"] ?? "")).slice(0, 255);
      if (!name) throw new LibraryError("The upload has no file name.");
      const t = await library.add(req, name, maxUpload);
      res.json({ ok: true, track: t });
    }),
  );
  admin.patch(
    "/library/:id",
    safe(async (req, res) => {
      res.json({ ok: true, track: await library.update(String(req.params.id), (req.body ?? {}) as Record<string, unknown>) });
    }),
  );
  admin.delete(
    "/library/:id",
    safe(async (req, res) => {
      await library.remove(String(req.params.id));
      res.json({ ok: true });
    }),
  );
  admin.delete(
    "/history",
    safe(async (_req, res) => {
      store.history = [];
      await store.saveHistory();
      res.json({ ok: true });
    }),
  );

  app.use("/api/admin", admin);
  app.use("/api", (_req, res) => void res.status(404).json({ ok: false, error: "Not found." }));

  // ---------------------------------------------------------------- client
  const indexHtml = o.clientDist ? path.join(o.clientDist, "index.html") : "";
  if (indexHtml && existsSync(indexHtml)) {
    serveSpa(app, { dist: o.clientDist!, ...(o.basePath !== undefined ? { basePath: o.basePath } : {}), skip: ["/api", "/socket.io", "/__bargames", "/health", "/box-audio", "/speaker-audio", "/art"] });
  } else {
    log.warn("boot", "client build not found; serving the API only", { path: o.clientDist });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SourceError || err instanceof QueueError || err instanceof LibraryError) {
      return void res.status(err.status).json({ ok: false, error: err.message });
    }
    const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error("http", "request failed", { err: String(err) });
    if (!res.headersSent) res.status(status).json({ ok: false, error: status === 404 ? "Not found." : status === 413 ? "That's too big." : status < 500 ? "Bad request." : "Something went wrong." });
  });

  const nameTimer = setInterval(() => void refreshName().catch(() => undefined), 60_000);
  nameTimer.unref();

  return {
    app,
    io,
    store,
    auth,
    queue,
    player,
    spotify,
    files,
    library,
    speaker,
    attach(server) {
      io.attach(server);
    },
    async close() {
      clearInterval(nameTimer);
      player.stop();
      for (const b of boxCache.values()) b.close();
      auth.close();
      await new Promise<void>((r) => io.close(() => r()));
      await store.flush();
    },
  };
}
