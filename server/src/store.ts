// Everything this app keeps, as JSON files in DATA_DIR (the kit's atomic JSON store).
//   settings.json   name, source, output
//   rules.json      the request rules
//   queue.json      requests and the queue, the request log (rate rule), recent plays
//   history.json    what played (newest 500)
//   spotify.json    client id, tokens, consent time, device (0600)
//   library.json    the uploaded files' tags (the files are in music/)
//   admin.json      the admin password (the kit's)

import { chmod } from "node:fs/promises";
import { createJsonStore, log, type JsonStore } from "@bargames/gamekit/server";
import { DEFAULT_RULES, type HistoryEntry, type LibraryTrack, type QueueItem, type Rules, type Settings } from "@music/shared";

export const DEFAULT_SETTINGS: Settings = { name: "", source: null, output: "" };

export interface StoredQueue {
  items: QueueItem[];
  requests: { guestId: string; at: number; sourceId: string }[];
  plays: { sourceId: string; at: number }[];
}

export interface StoredSpotify {
  /** When the user confirmed the personal-use notice. */
  consentAt: number | null;
  clientId: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  account: string;
  deviceId: string;
  deviceName: string;
  /** The sign-in in progress (PKCE verifier and state). */
  pending: { verifier: string; state: string; redirectUri: string; startedAt: number } | null;
  problem: string;
}

export const DEFAULT_SPOTIFY: StoredSpotify = {
  consentAt: null,
  clientId: "",
  refreshToken: "",
  accessToken: "",
  accessExpiresAt: 0,
  account: "",
  deviceId: "",
  deviceName: "",
  pending: null,
  problem: "",
};

const SECRET_FILES = new Set(["spotify.json"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const obj = <T>() => isObj as unknown as (v: unknown) => v is T;

export class Store {
  readonly json: JsonStore;
  settings: Settings = { ...DEFAULT_SETTINGS };
  rules: Rules = { ...DEFAULT_RULES };
  queue: StoredQueue = { items: [], requests: [], plays: [] };
  history: HistoryEntry[] = [];
  spotify: StoredSpotify = { ...DEFAULT_SPOTIFY };
  library: LibraryTrack[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(readonly dir: string) {
    this.json = createJsonStore(dir);
  }

  async init(): Promise<void> {
    const s = await this.json.read<Settings>("settings.json", obj<Settings>());
    if (s) this.settings = { ...this.settings, ...s };
    const r = await this.json.read<Rules>("rules.json", obj<Rules>());
    if (r) this.rules = { ...this.rules, ...r };
    const q = await this.json.read<StoredQueue>("queue.json", obj<StoredQueue>());
    if (q) {
      this.queue = {
        items: Array.isArray(q.items) ? q.items : [],
        requests: Array.isArray(q.requests) ? q.requests : [],
        plays: Array.isArray(q.plays) ? q.plays : [],
      };
    }
    const h = await this.json.read<{ history: HistoryEntry[] }>("history.json", obj<{ history: HistoryEntry[] }>());
    if (Array.isArray(h?.history)) this.history = h.history;
    const sp = await this.json.read<StoredSpotify>("spotify.json", obj<StoredSpotify>());
    if (sp) this.spotify = { ...DEFAULT_SPOTIFY, ...sp };
    const l = await this.json.read<{ tracks: LibraryTrack[] }>("library.json", obj<{ tracks: LibraryTrack[] }>());
    if (Array.isArray(l?.tracks)) this.library = l.tracks;
  }

  private async write(name: string, value: unknown): Promise<void> {
    await this.json.write(name, value);
    if (SECRET_FILES.has(name)) await chmod(this.json.file(name), 0o600).catch(() => undefined);
  }

  saveSettings = () => this.write("settings.json", this.settings);
  saveRules = () => this.write("rules.json", this.rules);
  saveSpotify = () => this.write("spotify.json", this.spotify);
  saveLibrary = () => this.write("library.json", { tracks: this.library });
  saveQueue = () => this.write("queue.json", this.queue);
  saveHistory = () => this.write("history.json", { history: this.history.slice(0, 500) });

  /** Coalesces frequent writes into one per `ms`. */
  later(name: "queue" | "history", ms = 1000): void {
    if (this.timers.has(name)) return;
    const t = setTimeout(() => {
      this.timers.delete(name);
      (name === "queue" ? this.saveQueue() : this.saveHistory()).catch((err) => log.warn("store", `saving ${name} failed`, { err: String(err) }));
    }, ms);
    t.unref();
    this.timers.set(name, t);
  }

  async flush(): Promise<void> {
    const names = [...this.timers.keys()];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const n of names) await (n === "queue" ? this.saveQueue() : this.saveHistory()).catch(() => undefined);
  }
}
