// Spotify, through the Web API with the user's OWN developer app (client id) and PKCE: no
// client secret, and the app ships no credentials of its own. Playback happens on one of the
// user's own Spotify devices (phone, PC, speaker); this never plays audio itself.
//
// Development-mode apps (Spotify's February 2026 rules): search (at most 10 results per
// call), playback state, devices, add-to-queue, skip, pause/play and transfer still work; the
// app owner needs Premium; up to 5 users, and only the venue's own account signs in here.
//
// Tokens and the client id live in spotify.json (0600) and are never logged or sent to a
// browser (the authorize URL carries the client id, as OAuth requires).

import { createHash, randomBytes } from "node:crypto";
import { log } from "@bargames/gamekit/server";
import { parseRedirect, type SpotifyDevice, type SpotifyStatus, type SourceStatus, type Track } from "@music/shared";
import type { Store } from "../store.js";
import { SourceError, type MusicSource, type SourceNowPlaying } from "./types.js";

/** The smallest set: player state + devices (read), queue/skip/pause/play/transfer (modify). Search needs no scope. */
export const SPOTIFY_SCOPES = ["user-read-playback-state", "user-modify-playback-state"];

export const PERSONAL_USE_NOTICE =
  "Spotify's terms allow personal, non-commercial use. You're responsible for how you use your Spotify account and developer app. In a business, use a music service licensed for businesses.";

export interface SpotifyUrls {
  accounts: string;
  api: string;
}
const DEFAULT_URLS: SpotifyUrls = { accounts: "https://accounts.spotify.com", api: "https://api.spotify.com/v1" };

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]"));
  } catch {
    return false;
  }
}

interface SpImage {
  url: string;
  width?: number | null;
}
interface SpTrack {
  uri: string;
  name: string;
  duration_ms: number;
  explicit?: boolean;
  type?: string;
  artists?: { name: string }[];
  album?: { name: string; images?: SpImage[] };
  show?: { name: string; images?: SpImage[] };
  images?: SpImage[];
}

/** A medium-size image (about 300 px), else the first. */
function pickArt(images?: SpImage[]): string | undefined {
  if (!images?.length) return undefined;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= 300) ?? sorted[sorted.length - 1])!.url;
}

export function toTrack(t: SpTrack): Track {
  const episode = t.type === "episode";
  return {
    sourceId: t.uri,
    title: t.name,
    artist: episode ? (t.show?.name ?? "") : (t.artists ?? []).map((a) => a.name).join(", "),
    album: episode ? undefined : t.album?.name,
    art: pickArt(episode ? (t.images ?? t.show?.images) : t.album?.images),
    durationMs: t.duration_ms,
    explicit: !!t.explicit,
  };
}

export class Spotify implements MusicSource {
  readonly id = "spotify" as const;
  readonly label = "Spotify";
  readonly can = { search: true, queueTrack: true, skip: true, pause: true, readQueue: false };
  readonly pollMs = { playing: 5000, idle: 15000 };
  readonly leadMs = 15000;
  private readonly urls: SpotifyUrls;
  private refreshing: Promise<string> | null = null;
  private backoffUntil = 0;

  constructor(
    private readonly store: Store,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    urls?: Partial<SpotifyUrls>,
  ) {
    this.urls = { ...DEFAULT_URLS, ...urls };
  }

  private get s() {
    return this.store.spotify;
  }

  get connected(): boolean {
    return !!(this.s.clientId && this.s.refreshToken);
  }

  // ------------------------------------------------------------ setup

  info(): SpotifyStatus {
    const s = this.s;
    return {
      consentAt: s.consentAt,
      clientIdSet: !!s.clientId,
      clientIdHint: s.clientId ? s.clientId.slice(-4) : "",
      connected: this.connected,
      account: s.account,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      pending: s.pending ? { redirectUri: s.pending.redirectUri, startedAt: s.pending.startedAt } : null,
      problem: s.problem,
    };
  }

  async consent(): Promise<void> {
    this.s.consentAt = this.now();
    await this.store.saveSpotify();
  }

  async setClientId(raw: string): Promise<void> {
    if (!this.s.consentAt) throw new SourceError("setup", "Confirm the note about Spotify's terms first.", 0, 400);
    const id = String(raw ?? "").trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) throw new SourceError("setup", "That doesn't look like a client id: it's 32 letters and numbers, from your app's page on developer.spotify.com.", 0, 400);
    if (id !== this.s.clientId) {
      Object.assign(this.s, { clientId: id, refreshToken: "", accessToken: "", accessExpiresAt: 0, account: "", pending: null, problem: "" });
      await this.store.saveSpotify();
    }
  }

  /** Step 1 of sign-in: the Spotify address to open. */
  async beginLogin(redirectUri: string): Promise<string> {
    if (!this.s.consentAt) throw new SourceError("setup", "Confirm the note about Spotify's terms first.", 0, 400);
    if (!this.s.clientId) throw new SourceError("setup", "Paste your app's client id first.", 0, 400);
    if (!validRedirectUri(redirectUri)) throw new SourceError("setup", "The redirect URI must start with https://, or be a http://127.0.0.1 address.", 0, 400);
    const { verifier, challenge } = pkcePair();
    const state = b64url(randomBytes(18));
    this.s.pending = { verifier, state, redirectUri, startedAt: this.now() };
    await this.store.saveSpotify();
    const q = new URLSearchParams({
      client_id: this.s.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
      scope: SPOTIFY_SCOPES.join(" "),
    });
    return `${this.urls.accounts}/authorize?${q}`;
  }

  /** Step 2: the code from the callback page, or from the address the user pasted. */
  async finishLogin(input: { url?: string; code?: string; state?: string }): Promise<void> {
    const p = this.s.pending;
    if (!p) throw new SourceError("setup", "There's no sign-in waiting. Press Sign in with Spotify again.", 0, 400);
    if (this.now() - p.startedAt > 30 * 60_000) throw new SourceError("setup", "That sign-in is too old. Press Sign in with Spotify again.", 0, 400);
    let code: string, state: string;
    if (input.url !== undefined) {
      const r = parseRedirect(input.url);
      if (!r.ok) throw new SourceError("setup", r.error, 0, 400);
      ({ code, state } = r);
    } else {
      code = String(input.code ?? "");
      state = String(input.state ?? "");
    }
    if (state !== p.state) throw new SourceError("setup", "That address is from a different sign-in. Press Sign in with Spotify again and use the newest address.", 0, 400);
    const tok = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: this.s.clientId, code_verifier: p.verifier });
    this.s.pending = null;
    this.s.problem = "";
    await this.store.saveSpotify();
    try {
      const me = (await this.api("GET", "/me")) as { display_name?: string; id?: string } | null;
      this.s.account = me?.display_name || me?.id || "";
    } catch {
      this.s.account = "";
    }
    await this.store.saveSpotify();
    log.info("spotify", "signed in", { scopes: tok.scope ?? "" });
  }

  async signOut(): Promise<void> {
    Object.assign(this.s, { refreshToken: "", accessToken: "", accessExpiresAt: 0, account: "", pending: null, problem: "" });
    await this.store.saveSpotify();
  }

  async devices(): Promise<SpotifyDevice[]> {
    const r = (await this.api("GET", "/me/player/devices")) as { devices?: { id: string | null; name: string; type: string; is_active: boolean; is_restricted: boolean; volume_percent: number | null }[] } | null;
    return (r?.devices ?? [])
      .filter((d) => d.id)
      .map((d) => ({ id: d.id!, name: d.name, type: d.type, active: d.is_active, restricted: d.is_restricted, volume: d.volume_percent }));
  }

  async setDevice(id: string, name: string): Promise<void> {
    this.s.deviceId = String(id ?? "").slice(0, 100);
    this.s.deviceName = String(name ?? "").slice(0, 100);
    await this.store.saveSpotify();
  }

  // ------------------------------------------------------------ HTTP

  private async tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.urls.accounts}/api/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });
    } catch {
      throw new SourceError("network", "Can't reach Spotify. Check the internet connection.");
    }
    const json = (await res.json().catch(() => null)) as { error?: string; error_description?: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } | null;
    if (!res.ok || !json?.access_token) {
      const err = json?.error ?? `http ${res.status}`;
      log.warn("spotify", "token request refused", { err, grant: body.grant_type });
      if (err === "invalid_grant" && body.grant_type === "refresh_token") {
        this.s.refreshToken = "";
        this.s.accessToken = "";
        this.s.problem = "Spotify signed this app out (the sign-in expired or was removed). Sign in with Spotify again.";
        await this.store.saveSpotify();
        throw new SourceError("auth", this.s.problem);
      }
      if (err === "invalid_client") throw new SourceError("setup", "Spotify doesn't know that client id. Check it on developer.spotify.com.");
      if (err === "invalid_grant") throw new SourceError("setup", "Spotify didn't accept that sign-in code (it's used once and expires fast). Press Sign in with Spotify again.", 0, 400);
      throw new SourceError("auth", "Spotify refused the sign-in. Try again.");
    }
    this.s.accessToken = json.access_token;
    this.s.accessExpiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
    if (json.refresh_token) this.s.refreshToken = json.refresh_token;
    await this.store.saveSpotify();
    return { access_token: json.access_token, refresh_token: json.refresh_token, expires_in: json.expires_in ?? 3600, scope: json.scope };
  }

  private async token(force = false): Promise<string> {
    if (!this.connected) throw new SourceError("setup", "Spotify isn't signed in. Finish the setup in the admin.");
    if (!force && this.s.accessToken && this.s.accessExpiresAt - this.now() > 60_000) return this.s.accessToken;
    this.refreshing ??= this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.s.refreshToken, client_id: this.s.clientId })
      .then((t) => t.access_token)
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** One Web API call. 204 → null. Errors become SourceErrors in plain words. */
  async api(method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
    if (this.now() < this.backoffUntil) throw new SourceError("rate", "Spotify asked us to slow down. Trying again shortly.", this.backoffUntil - this.now());
    const token = await this.token();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.urls.api}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new SourceError("network", "Can't reach Spotify. Check the internet connection.");
    }
    if (res.status === 401 && !retried) {
      await this.token(true);
      return this.api(method, path, body, true);
    }
    if (res.status === 429) {
      const after = Math.min(600, Math.max(1, Number(res.headers.get("retry-after")) || 5)) * 1000;
      this.backoffUntil = this.now() + after;
      log.warn("spotify", "rate limited", { retryAfterMs: after });
      throw new SourceError("rate", "Spotify asked us to slow down. Trying again shortly.", after);
    }
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    let json: { error?: { message?: string; reason?: string; status?: number } } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return json;
    const reason = json?.error?.reason ?? "";
    const msg = json?.error?.message ?? "";
    log.warn("spotify", "api error", { method, path: path.split("?")[0], status: res.status, reason });
    if (reason === "NO_ACTIVE_DEVICE" || (res.status === 404 && /device/i.test(msg))) {
      throw new SourceError("no-device", "No Spotify device is active. Open Spotify on the device that plays here (phone, PC or speaker), play any song once, then pick it under Spotify → Device in the admin.");
    }
    if (reason === "PREMIUM_REQUIRED" || /premium/i.test(msg)) throw new SourceError("premium", "Spotify needs a Premium account to control playback.");
    if (res.status === 403) throw new SourceError("other", "Spotify refused that. If you just signed in, check the app's User Management on developer.spotify.com lists your Spotify account.");
    throw new SourceError("other", `Spotify answered ${res.status}. Try again.`);
  }

  // ------------------------------------------------------------ MusicSource

  async status(): Promise<SourceStatus> {
    const s = this.s;
    if (!s.consentAt || !s.clientId) return { state: "setup", message: "Spotify isn't set up. Open the admin's Source tab." };
    if (!s.refreshToken) return { state: s.problem ? "error" : "setup", message: s.problem || "Sign in with Spotify in the admin." };
    if (s.problem) return { state: "error", message: s.problem };
    return { state: "ok", message: `Signed in${s.account ? ` as ${s.account}` : ""}${s.deviceName ? `; plays on ${s.deviceName}` : ""}.` };
  }

  async search(q: string, limit: number): Promise<Track[]> {
    const query = q.trim().slice(0, 100);
    if (!query) return [];
    const n = Math.max(1, Math.min(10, limit));
    const r = (await this.api("GET", `/search?${new URLSearchParams({ q: query, type: "track", limit: String(n) })}`)) as { tracks?: { items?: SpTrack[] } } | null;
    return (r?.tracks?.items ?? []).filter((t) => t?.uri).map(toTrack);
  }

  private deviceQuery(): string {
    return this.s.deviceId ? `?device_id=${encodeURIComponent(this.s.deviceId)}` : "";
  }

  async play(track: Track): Promise<void> {
    if (!/^spotify:(track|episode):[A-Za-z0-9]+$/.test(track.sourceId)) throw new SourceError("gone", `"${track.title}" isn't a Spotify song, so it was dropped from the queue.`);
    const np = await this.nowPlaying();
    if (np?.track && np.playing) {
      // Right after the current song: Spotify's own queue (we only ever put one song there).
      await this.api("POST", `/me/player/queue?${new URLSearchParams({ uri: track.sourceId, ...(this.s.deviceId ? { device_id: this.s.deviceId } : {}) })}`);
    } else {
      await this.api("PUT", `/me/player/play${this.deviceQuery()}`, { uris: [track.sourceId] });
    }
  }

  async nowPlaying(): Promise<SourceNowPlaying | null> {
    const r = (await this.api("GET", "/me/player?additional_types=episode")) as { is_playing?: boolean; progress_ms?: number | null; item?: SpTrack | null; device?: { id?: string; name?: string } } | null;
    if (!r) return null;
    return { track: r.item ? toTrack(r.item) : undefined, progressMs: r.progress_ms ?? 0, playing: !!r.is_playing };
  }

  async skip(): Promise<void> {
    await this.api("POST", `/me/player/next${this.deviceQuery()}`);
  }
  async pause(): Promise<void> {
    await this.api("PUT", `/me/player/pause${this.deviceQuery()}`);
  }
  async resume(): Promise<void> {
    await this.api("PUT", `/me/player/play${this.deviceQuery()}`);
  }
}
