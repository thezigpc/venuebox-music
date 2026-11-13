import { createServer } from "node:http";
import { log } from "@bargames/gamekit/server";
import { DEFAULT_NAME } from "@music/shared";
import { createApp } from "./app.js";
import { makeBarGames } from "./bargames.js";
import { ADMIN_PASSWORD, CLIENT_DIST_PATH, DATA_DIR, GAME_NAME, MAX_UPLOAD_MB, PORT, PUBLIC_URL } from "./config.js";

// Spotify tokens and the music library live in DATA_DIR: nothing written here is for other users.
process.umask(0o077);

const bg = makeBarGames({ defaultName: GAME_NAME || DEFAULT_NAME });
const music = await createApp({
  dataDir: DATA_DIR,
  bg,
  adminPassword: ADMIN_PASSWORD,
  gameName: GAME_NAME,
  clientDist: CLIENT_DIST_PATH,
  publicUrl: PUBLIC_URL || undefined,
  maxUploadBytes: MAX_UPLOAD_MB * 1e6,
});

const server = createServer(music.app);
music.attach(server);
server.listen(PORT, () => log.info("boot", "listening", { port: PORT, dataDir: DATA_DIR, box: bg.connected, audio: bg.audio.onBox, source: music.store.settings.source ?? "none" }));

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("boot", "shutting down", { signal });
  setTimeout(() => process.exit(0), 3000).unref();
  void music
    .close()
    .catch(() => undefined)
    .then(() => bg.flush())
    .finally(() => server.close(() => process.exit(0)));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
