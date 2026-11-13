// Spotify's redirect: building the address to register, and reading the code back from a
// pasted address (the "no tunnel" way in, where the browser shows an error page after login).

/** The loopback redirect for setups without a public https address. Spotify accepts 127.0.0.1, not localhost. */
export const LOOPBACK_REDIRECT = "http://127.0.0.1:8909/callback";

/** The path the app answers for the https redirect (under the base path). */
export const CALLBACK_PATH = "/admin/spotify/callback";

/**
 * The redirect URI to register with Spotify for a page at `origin` + `basePath`:
 * - https (the box's tunnel, a reverse proxy): the app's own callback page;
 * - the app opened at http://127.0.0.1:<port>: its own callback page too (loopback is allowed);
 * - anything else on http (a LAN address, localhost): the fixed loopback address, and the
 *   user pastes the address of the error page back into the admin.
 */
export function redirectUriFor(origin: string, basePath: string): { uri: string; paste: boolean } {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return { uri: LOOPBACK_REDIRECT, paste: true };
  }
  const base = basePath.replace(/\/+$/, "");
  if (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "127.0.0.1")) {
    return { uri: `${u.origin}${base}${CALLBACK_PATH}`, paste: false };
  }
  return { uri: LOOPBACK_REDIRECT, paste: true };
}

export type PastedRedirect = { ok: true; code: string; state: string } | { ok: false; error: string };

/**
 * Reads `code` and `state` from the address the user pasted (the whole URL, or just the
 * part after "?"). Spotify's own errors (`error=access_denied`) come back in plain words.
 */
export function parseRedirect(text: string): PastedRedirect {
  const t = text.trim();
  if (!t) return { ok: false, error: "Paste the address from the browser's address bar." };
  let query: string;
  try {
    query = new URL(t).search;
  } catch {
    const i = t.indexOf("?");
    query = i >= 0 ? t.slice(i) : t;
  }
  const p = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const err = p.get("error");
  if (err === "access_denied") return { ok: false, error: "Spotify says the sign-in was cancelled. Try again and press Agree." };
  if (err) return { ok: false, error: `Spotify answered "${err.slice(0, 60)}". Try again.` };
  const code = p.get("code");
  const state = p.get("state");
  if (!code || !state) return { ok: false, error: "That address has no sign-in code in it. Copy the whole address after Spotify sends you back." };
  if (!/^[A-Za-z0-9_\-.~]{10,2048}$/.test(code) || !/^[A-Za-z0-9_\-]{8,128}$/.test(state)) {
    return { ok: false, error: "That address doesn't look like Spotify's. Copy the whole address after Spotify sends you back." };
  }
  return { ok: true, code, state };
}
