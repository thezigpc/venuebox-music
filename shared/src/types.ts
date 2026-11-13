// Types shared by the server and the pages.

export const DEFAULT_NAME = "Music Requests";

/** One song, from any source. `sourceId` is the source's own id (a Spotify URI, a library id). */
export interface Track {
  sourceId: string;
  title: string;
  artist: string;
  album?: string;
  /** Album art URL the browser can load. */
  art?: string;
  durationMs: number;
  explicit?: boolean;
}

export type SourceId = "spotify" | "files";

export interface SourceCan {
  search: boolean;
  queueTrack: boolean;
  skip: boolean;
  pause: boolean;
  readQueue: boolean;
}

export interface SourceStatus {
  state: "setup" | "ok" | "warn" | "error";
  message: string;
}

export type ApprovalMode = "staff" | "auto";

/** The request rules, all set in the admin. 0 turns a number rule off. */
export interface Rules {
  requestsOpen: boolean;
  approval: ApprovalMode;
  /** At most `perGuestCount` requests per guest every `perGuestMinutes`. */
  perGuestCount: number;
  perGuestMinutes: number;
  /** Songs a guest may have waiting (pending or queued) at once. */
  maxPendingPerGuest: number;
  /** The same song can't be requested again within this many minutes of playing or being requested. */
  noRepeatMinutes: number;
  blockExplicit: boolean;
  blockedArtists: string[];
  blockedWords: string[];
  /** Longest song allowed, in minutes. */
  maxSongMinutes: number;
  /** Most songs waiting in total. */
  maxQueue: number;
}

export const DEFAULT_RULES: Rules = {
  requestsOpen: true,
  approval: "staff",
  perGuestCount: 3,
  perGuestMinutes: 30,
  maxPendingPerGuest: 2,
  noRepeatMinutes: 60,
  blockExplicit: true,
  blockedArtists: [],
  blockedWords: [],
  maxSongMinutes: 8,
  maxQueue: 50,
};

export type ItemStatus = "pending" | "queued" | "handed" | "playing" | "played" | "skipped" | "rejected" | "removed" | "failed";

/** A request (or a song staff added), from pending to played. */
export interface QueueItem {
  id: string;
  track: Track;
  /** The guest's cookie id (server only; never sent to other guests). */
  guestId: string;
  /** Optional name the guest typed. */
  guestName: string;
  requestedAt: number;
  status: ItemStatus;
  /** When it was handed to the source / started / finished. */
  handedAt?: number;
  startedAt?: number;
  endedAt?: number;
  /** Staff added it themselves. */
  byStaff?: boolean;
}

/** What guests and the TV see of a queued song. */
export interface PublicItem {
  id: string;
  title: string;
  artist: string;
  art?: string;
  durationMs: number;
  guestName: string;
  /** Already handed to the music source: it can't move any more. */
  locked: boolean;
}

export interface NowPlaying {
  title: string;
  artist: string;
  album?: string;
  art?: string;
  durationMs: number;
  progressMs: number;
  playing: boolean;
  /** Who asked for it (empty for staff picks and songs the source chose itself). */
  guestName: string;
  /** Requested here, or the source's own music (a playlist running on Spotify). */
  requested: boolean;
  /** Server time when progressMs was read, so pages can count on. */
  at: number;
}

/** GET /api/now: guests and the TV. */
export interface PublicState {
  name: string;
  requestsOpen: boolean;
  canSearch: boolean;
  nowPlaying: NowPlaying | null;
  upNext: PublicItem[];
  /** The guest page's address, for the TV's QR code (null: the page works it out). */
  guestUrl: string | null;
}

/** GET /api/me: the guest's own requests. */
export interface GuestState {
  requests: { id: string; title: string; artist: string; art?: string; status: ItemStatus; position: number | null; requestedAt: number }[];
  /** Plain words about the rules, for the page footer. */
  rulesText: string[];
}

export interface RuleBlock {
  rule: "closed" | "rate" | "pending" | "repeat" | "explicit" | "artist" | "word" | "length" | "full" | "source";
  message: string;
}

export interface HistoryEntry {
  at: number;
  title: string;
  artist: string;
  album?: string;
  source: SourceId;
  guestName: string;
  requested: boolean;
  /** played | skipped */
  outcome: "played" | "skipped";
}

export interface LibraryTrack {
  id: string;
  file: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  hasArt: boolean;
  explicit: boolean;
  addedAt: number;
  size: number;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  active: boolean;
  restricted: boolean;
  volume: number | null;
}

/** What the admin sees of Spotify: never tokens or the full client id. */
export interface SpotifyStatus {
  consentAt: number | null;
  clientIdSet: boolean;
  /** Last 4 characters, so staff can tell which app it is. */
  clientIdHint: string;
  connected: boolean;
  account: string;
  deviceId: string;
  deviceName: string;
  /** An authorize step is waiting for its code. */
  pending: { redirectUri: string; startedAt: number } | null;
  problem: string;
}

export interface OutputChoice {
  /** "box" (box default), "box:<output id>", or "speaker". */
  id: string;
  name: string;
  kind: "box" | "speaker";
  available: boolean;
  busy?: boolean;
  detail?: string;
  volume?: number;
}

export interface Settings {
  name: string;
  source: SourceId | null;
  /** Files source: where the sound goes ("" = the box's default when on a box, else the speaker page). */
  output: string;
}

/** GET /api/host/state: the staff page. */
export interface HostState {
  rules: Rules;
  source: SourceId | null;
  sourceLabel: string;
  sourceStatus: SourceStatus;
  can: SourceCan;
  nowPlaying: (NowPlaying & { itemId: string | null }) | null;
  pending: QueueItem[];
  queue: QueueItem[];
  /** Handed to the source, waiting to start. */
  handed: QueueItem[];
  problem: string;
  /** Files source only. */
  outputs: OutputChoice[];
  output: string;
  speakerConnected: boolean;
  /** An output another app is using; staff may take it over. */
  busyOutput: string | null;
}

export interface AdminState {
  settings: Settings;
  rules: Rules;
  spotify: SpotifyStatus;
  library: { tracks: LibraryTrack[]; bytes: number };
  history: HistoryEntry[];
  onBox: boolean;
  outputs: OutputChoice[];
  sourceStatus: SourceStatus;
  /** For the redirect URI wizard: what this server knows of its public address. */
  publicUrl: string | null;
}
