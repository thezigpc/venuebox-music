import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const PORT = num("PORT", 3009);
/** Built client, served by this process (one origin). */
export const CLIENT_DIST_PATH = process.env.CLIENT_DIST_PATH ?? path.resolve(here, "../../client/dist");
/** Everything written at runtime (see store.ts). */
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(here, "../../data"));
/** Overrides the password chosen on the /admin setup screen. */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
/** Standalone name (the admin's name setting wins, the venue's rename on a box). */
export const GAME_NAME = process.env.GAME_NAME ?? "";
/** Standalone: the public address (https://music.example.com), for the TV's QR code. */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
/** Largest upload, in MB. */
export const MAX_UPLOAD_MB = num("MAX_UPLOAD_MB", 60);
