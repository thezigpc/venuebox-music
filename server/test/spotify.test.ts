// The Spotify connector against a fake Spotify: the setup steps, sign-in with a pasted
// address (PKCE), search, the one-ahead handover through Spotify's queue, no active device,
// 429 back-off, an expired sign-in, and that no secret reaches a response or a log.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CLIENT_ID, captureLogs, fakeSpotify, teeLogs, startApp, track, type FakeSpotify, type TestApp } from "./fakes.js";

const catalog = [
  track("spotify:track:aaa111", { title: "Alpha Song", durationMs: 180_000 }),
  track("spotify:track:bbb222", { title: "Beta Song", durationMs: 200_000 }),
  track("spotify:track:ccc333", { title: "Explicit Song", explicit: true }),
  track("spotify:track:ddd444", { title: "Long Song", durationMs: 20 * 60_000 }),
];

describe("Spotify", () => {
  let t: TestApp;
  let sp: FakeSpotify;
  let logs = "";
  const bodies: string[] = [];
  const keep = async (r: Response) => {
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };

  let tee: ReturnType<typeof teeLogs>;
  before(async () => {
    // Every log line from the whole suite is checked for secrets at the end.
    tee = teeLogs();
    sp = fakeSpotify(catalog);
    t = await startApp({ fetch: sp.fetch, spotifyUrls: { accounts: "https://accounts.test", api: "https://api.test/v1" } });
  });
  after(async () => {
    await t.stop();
    tee.restore();
    logs += tee.text();
    // No secret anywhere: not in any response this suite read, not in any log line.
    const secrets = [...sp.tokens.access, ...sp.tokens.refresh, CLIENT_ID, "good-code-1234567890"];
    const all = bodies.join("\n");
    for (const s of secrets) {
      assert.ok(!all.includes(s), `a response contained ${s.slice(0, 6)}…`);
      assert.ok(!logs.includes(s), `a log line contained ${s.slice(0, 6)}…`);
    }
  });

  test("setup: consent first, then the client id, then sign-in", async () => {
    const r1 = await keep(await t.send("PUT", "/api/admin/spotify/client", { clientId: CLIENT_ID }, t.token));
    assert.equal(r1.status, 400);
    assert.match(r1.json.error, /terms/);
    await t.call("POST", "/spotify/consent");
    const bad = await keep(await t.send("PUT", "/api/admin/spotify/client", { clientId: "nope" }, t.token));
    assert.match(bad.json.error, /32 letters/);
    await t.call("PUT", "/spotify/client", { clientId: CLIENT_ID });
    const state = await keep(await t.get("/api/admin/state", t.token));
    assert.equal(state.json.spotify.clientIdSet, true);
    assert.equal(state.json.spotify.clientIdHint, "cdef");
    assert.ok(state.json.spotify.consentAt > 0);
  });

  test("the redirect URI must be https or loopback", async () => {
    const r = await keep(await t.send("POST", "/api/admin/spotify/login", { redirectUri: "http://192.168.1.5/cb" }, t.token));
    assert.equal(r.status, 400);
  });

  test("sign in by pasting the address Spotify sent the browser to", async () => {
    const { result } = await captureLogs(async () => {
      const r = await t.send("POST", "/api/admin/spotify/login", { redirectUri: "http://127.0.0.1:8909/callback" }, t.token);
      const { url } = (await r.json()) as { url: string };
      const u = new URL(url);
      assert.equal(u.origin + u.pathname, "https://accounts.test/authorize");
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      assert.equal(u.searchParams.get("scope"), "user-read-playback-state user-modify-playback-state");
      assert.equal(u.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:8909/callback");
      // A paste from another sign-in is refused.
      const wrong = await keep(await t.send("POST", "/api/admin/spotify/callback", { url: "http://127.0.0.1:8909/callback?code=good-code-1234567890&state=otherstate123" }, t.token));
      assert.match(wrong.json.error, /different sign-in/);
      const pasted = `http://127.0.0.1:8909/callback?code=good-code-1234567890&state=${u.searchParams.get("state")}`;
      return keep(await t.send("POST", "/api/admin/spotify/callback", { url: pasted }, t.token));
    }).then((x) => ((logs += x.logs), x));
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const state = await keep(await t.get("/api/admin/state", t.token));
    assert.equal(state.json.spotify.connected, true);
    assert.equal(state.json.spotify.account, "Venue Account");
    assert.equal(state.json.settings.source, "spotify");
    // Owner-only file (on systems with Unix permissions).
    const file = path.join(t.dataDir, "spotify.json");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), /RT-secret/);
  });

  test("devices: pick one", async () => {
    const r = await keep(await t.get("/api/admin/spotify/devices", t.token));
    assert.deepEqual(r.json.devices.map((d: { name: string }) => d.name), ["Bar PC"]);
    await t.call("PUT", "/spotify/device", { id: "dev1", name: "Bar PC" });
  });

  test("guests search (10 results at most) and request; the first plays at once", async () => {
    const s = await keep(await t.get("/api/search?q=song"));
    assert.equal(s.status, 200);
    assert.equal(s.json.tracks.length, 4);
    assert.equal(s.json.tracks[0].art, "https://i.scdn.co/image/mid");
    assert.ok(sp.log.some((l) => l.startsWith("GET /v1/search") && l.includes("limit=10")));

    // Approval by staff (the default): the request waits.
    const res = await t.send("POST", "/api/request", { sourceId: "spotify:track:aaa111", name: "Sam" });
    const guestCookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const r = await keep(res);
    assert.equal(r.json.status, "pending");
    const host = await keep(await t.get("/api/admin/host", t.token));
    assert.equal(host.json.pending[0].guestName, "Sam");
    assert.equal(host.json.pending[0].guestId, "");
    await t.call("POST", `/requests/${host.json.pending[0].id}/approve`);
    await t.music.player.tick();
    assert.equal(sp.state.item?.sourceId, "spotify:track:aaa111");
    assert.ok(sp.log.includes("PUT /v1/me/player/play?device_id=dev1"));

    // The guest sees it playing.
    const me = await keep(await t.get("/api/me", undefined, { cookie: guestCookie }));
    assert.equal(me.json.requests[0].status, "playing");
    const now = await keep(await t.get("/api/now"));
    assert.equal(now.json.nowPlaying.title, "Alpha Song");
    assert.equal(now.json.nowPlaying.guestName, "Sam");
  });

  test("rules block in plain words", async () => {
    const ex = await keep(await t.send("POST", "/api/request", { sourceId: "spotify:track:ccc333" }));
    assert.equal(ex.status, 409);
    assert.equal(ex.json.rule, "explicit");
    const long = await keep(await t.send("POST", "/api/request", { sourceId: "spotify:track:ddd444" }));
    assert.equal(long.json.rule, "length");
    // A song the server hasn't seen in a search can't be requested (its length and explicit flag are unknown).
    const unseen = await keep(await t.send("POST", "/api/request", { sourceId: "spotify:track:zzz999" }));
    assert.equal(unseen.status, 404);
  });

  test("the next song goes to Spotify's queue only near the end of the current one", async () => {
    await t.call("PUT", "/rules", { approval: "auto" });
    await keep(await t.send("POST", "/api/request", { sourceId: "spotify:track:bbb222" }));
    sp.state.playing = true;
    sp.state.progressMs = 60_000;
    await t.music.player.tick();
    assert.deepEqual(sp.state.queue, []);
    sp.state.progressMs = 170_000;
    await t.music.player.tick();
    assert.deepEqual(sp.state.queue, ["spotify:track:bbb222"]);
    const host = await keep(await t.get("/api/admin/host", t.token));
    assert.equal(host.json.handed.length, 1);
  });

  test("429: backs off for Retry-After and says so", async () => {
    sp.next429 = true;
    await captureLogs(() => t.music.player.tick()).then((x) => (logs += x.logs));
    assert.match(t.music.player.problem, /slow down/);
    const calls = sp.log.length;
    await t.music.player.tick();
    assert.equal(sp.log.length, calls, "no call during the back-off");
  });

  test("no active device is explained", async () => {
    await new Promise((r) => setTimeout(r, 1100)); // the 429 back-off
    await t.call("PUT", "/spotify/device", { id: "", name: "" });
    sp.state.activeDevice = false;
    const r = await captureLogs(() => t.music.spotify.skip().catch((e: Error) => e.message));
    logs += r.logs;
    assert.match(String(r.result), /No Spotify device is active/);
    sp.state.activeDevice = true;
  });

  test("an expired sign-in asks to sign in again", async () => {
    sp.failRefresh = true;
    t.music.store.spotify.accessExpiresAt = 0;
    const r = await captureLogs(() => t.music.spotify.search("alpha", 5).catch((e: Error) => e.message));
    logs += r.logs;
    assert.match(String(r.result), /Sign in with Spotify again/);
    const state = await keep(await t.get("/api/admin/state", t.token));
    assert.equal(state.json.spotify.connected, false);
    assert.equal(state.json.sourceStatus.state, "error");
  });
});
