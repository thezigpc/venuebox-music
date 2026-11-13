// The app's single connection to a Bar Games box. Off a box (no BG_CORE_URL / BG_GAME_TOKEN)
// every call is a no-op and the app runs exactly as it does standalone.
//
// Level 2: no rooms or commands; x-music-* events for scenes and Home Assistant.

import { createBarGames, type BarGames } from "@bargames/sdk/server";
import { log } from "@bargames/gamekit/server";

export function makeBarGames(opts: { coreUrl?: string; token?: string; defaultName: string }): BarGames {
  const bg = createBarGames({ gameId: "music", defaultName: opts.defaultName, coreUrl: opts.coreUrl, token: opts.token });
  bg.setStatusProvider(() => ({ rooms: [] }));
  return bg;
}

/** The venue's name for the app on a box; null standalone or when the box can't be reached. */
export async function venueName(bg: BarGames): Promise<string | null> {
  if (!bg.connected) return null;
  try {
    return (await bg.venue()).game.displayName || null;
  } catch (err) {
    log.warn("bargames", "venue context unavailable", { err: String(err) });
    return null;
  }
}
