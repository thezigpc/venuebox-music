// HTTP helpers. The client is always served by the server (Vite proxies in dev). Under path
// routing (venue.example.com/music/) every call carries the prefix (bgUrl).

import { bgUrl } from "@bargames/sdk/client";
import type { AdminState, GuestState, HostState, LibraryTrack, PublicState, Rules, Settings, SpotifyDevice, Track } from "@music/shared";

const TOKEN_KEY = "music.adminToken";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: signed in until reload */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rule?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: { body: Blob; headers: Record<string, string> }): Promise<T> {
  const headers: Record<string, string> = { ...(raw?.headers ?? {}) };
  const token = getToken();
  if (token && path.startsWith("/api/admin")) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(bgUrl(path), { method, headers, body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new ApiError("Can't reach the server. Check the connection and try again.", 0);
  }
  const json = (await res.json().catch(() => null)) as { error?: string; rule?: string } | null;
  if (!res.ok) throw new ApiError(json?.error ?? `The server answered ${res.status}.`, res.status, json?.rule);
  return json as T;
}

export interface AuthStatus {
  setupNeeded: boolean;
  configured: boolean;
  broken: boolean;
  authenticated: boolean;
  minPasswordLength: number;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

const id = encodeURIComponent;

export const api = {
  // Guests
  now: () => request<PublicState>("GET", "/api/now"),
  me: () => request<GuestState>("GET", "/api/me"),
  search: (q: string) => request<{ tracks: Track[] }>("GET", `/api/search?q=${id(q)}`),
  request: (sourceId: string, name: string) => request<{ status: string }>("POST", "/api/request", { sourceId, name }),

  // Staff sign-in
  status: () => request<AuthStatus>("GET", "/api/admin/status"),
  setup: (password: string) => request<{ token: string }>("POST", "/api/admin/setup", { password }),
  login: (password: string) => request<{ token: string }>("POST", "/api/admin/login", { password }),
  logout: () => request("POST", "/api/admin/logout", {}),

  // Staff page
  host: () => request<HostState>("GET", "/api/admin/host"),
  approve: (itemId: string) => request("POST", `/api/admin/requests/${id(itemId)}/approve`, {}),
  reject: (itemId: string) => request("POST", `/api/admin/requests/${id(itemId)}/reject`, {}),
  move: (itemId: string, to: number) => request("POST", `/api/admin/queue/${id(itemId)}/move`, { to }),
  remove: (itemId: string) => request("DELETE", `/api/admin/queue/${id(itemId)}`),
  player: (action: "skip" | "pause" | "resume" | "takeover") => request("POST", `/api/admin/player/${action}`, {}),
  volume: (volume: number) => request("POST", "/api/admin/player/volume", { volume }),
  staffSearch: (q: string) => request<{ tracks: Track[] }>("GET", `/api/admin/search?q=${id(q)}`),
  staffAdd: (sourceId: string) => request("POST", "/api/admin/queue", { sourceId }),

  // Admin
  state: () => request<AdminState>("GET", "/api/admin/state"),
  settings: (patch: Partial<Settings>) => request("PUT", "/api/admin/settings", patch),
  rules: (patch: Partial<Rules>) => request<{ rules: Rules }>("PUT", "/api/admin/rules", patch),
  spotifyConsent: () => request("POST", "/api/admin/spotify/consent", {}),
  spotifyClient: (clientId: string) => request("PUT", "/api/admin/spotify/client", { clientId }),
  spotifyLogin: (redirectUri: string) => request<{ url: string }>("POST", "/api/admin/spotify/login", { redirectUri }),
  spotifyCallback: (body: { url: string } | { code: string; state: string }) => request("POST", "/api/admin/spotify/callback", body),
  spotifyDevices: () => request<{ devices: SpotifyDevice[] }>("GET", "/api/admin/spotify/devices"),
  spotifyDevice: (d: { id: string; name: string }) => request("PUT", "/api/admin/spotify/device", d),
  spotifySignOut: () => request("POST", "/api/admin/spotify/signout", {}),
  upload: (file: File) =>
    request<{ track: LibraryTrack }>("POST", "/api/admin/library", undefined, {
      body: file,
      headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(file.name) },
    }),
  updateTrack: (trackId: string, patch: Partial<Pick<LibraryTrack, "title" | "artist" | "album" | "explicit">>) => request("PATCH", `/api/admin/library/${id(trackId)}`, patch),
  deleteTrack: (trackId: string) => request("DELETE", `/api/admin/library/${id(trackId)}`),
  clearHistory: () => request("DELETE", "/api/admin/history"),
};

/** "3:07" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
