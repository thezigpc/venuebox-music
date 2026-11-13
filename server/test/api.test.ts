// Admin protection, the guest cookie, the public feed, settings, and staff from the box.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp } from "./fakes.js";

describe("api", () => {
  let t: TestApp;
  before(async () => (t = await startApp({ gameName: "Juke" })));
  after(() => t.stop());

  test("health and config", async () => {
    assert.equal((await t.get("/health")).status, 200);
    assert.deepEqual(await (await t.get("/api/config")).json(), { gameName: "Juke" });
  });

  test("staff and admin APIs need a session", async () => {
    for (const p of ["/api/admin/state", "/api/admin/host", "/api/admin/spotify/devices"]) assert.equal((await t.get(p)).status, 401, p);
    assert.equal((await t.send("PUT", "/api/admin/rules", { requestsOpen: false })).status, 401);
    assert.equal((await t.get("/api/admin/state", t.token)).status, 200);
  });

  test("gateway staff headers are ignored standalone", async () => {
    const r = await fetch(t.url + "/api/admin/state", { headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } });
    assert.equal(r.status, 401);
  });

  test("one device = one cookie", async () => {
    const r = await t.get("/api/me");
    const c = r.headers.get("set-cookie")!;
    assert.match(c, /^music_guest=[a-f0-9]{24}; Max-Age=\d+; Path=\/; Expires=.*HttpOnly; SameSite=Lax/);
    const again = await t.get("/api/me", undefined, { cookie: c.split(";")[0]! });
    assert.equal(again.headers.get("set-cookie"), null);
  });

  test("with no source, guests see that requests are off", async () => {
    const now = (await (await t.get("/api/now")).json()) as { requestsOpen: boolean; name: string; nowPlaying: null };
    assert.equal(now.requestsOpen, false);
    assert.equal(now.name, "Juke");
    const r = await t.send("POST", "/api/request", { sourceId: "x" });
    assert.equal(r.status, 409);
  });

  test("settings and rules validate", async () => {
    await assert.rejects(t.call("PUT", "/settings", { source: "napster" }), /Spotify or Music files/);
    await assert.rejects(t.call("PUT", "/settings", { output: "../../etc" }), /listed speakers/);
    await assert.rejects(t.call("PUT", "/rules", { maxSongMinutes: 999 }), /0 to 120/);
    await t.call("PUT", "/settings", { name: "The Jukebox" });
    assert.deepEqual(await (await t.get("/api/config")).json(), { gameName: "The Jukebox" });
  });

  test("art and audio paths refuse anything odd", async () => {
    assert.equal((await t.get("/art/..%2Fspotify.json")).status, 404);
    assert.equal((await t.get("/speaker-audio/..%2Fspotify.json?e=1&s=x")).status, 403);
    assert.equal((await t.get("/box-audio/spotify.json")).status, 403);
  });
});
