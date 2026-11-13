// The files source: upload and tags, local search, the box's audio outputs (the box fetches
// our file with its token, like the real one) and the speaker page over socket.io.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { io as ioClient, type Socket } from "socket.io-client";
import { makeBarGames } from "../src/bargames.js";
import { FakeAudio, makeMp3, startApp, until, type TestApp } from "./fakes.js";

async function upload(t: TestApp, name: string, body: Buffer) {
  const r = await fetch(t.url + "/api/admin/library", { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/octet-stream", "x-filename": encodeURIComponent(name) }, body });
  return { status: r.status, json: (await r.json()) as { track?: { id: string; title: string; artist: string; durationMs: number }; error?: string } };
}

describe("files on a box", () => {
  let t: TestApp;
  let fake: FakeAudio;
  before(async () => {
    const bg = makeBarGames({ defaultName: "Music", coreUrl: "http://127.0.0.1:1", token: "box-token" });
    let url = "";
    fake = new FakeAudio(() => url, "box-token");
    t = await startApp({ bg, audio: fake.api() });
    url = t.url;
    await t.call("PUT", "/settings", { source: "files" });
  });
  after(() => t.stop());

  test("upload reads the tags; bad files are refused", async () => {
    const a = await upload(t, "x.mp3", makeMp3({ title: "Tagged Title", artist: "Tag Band", album: "Tag Album" }, 3));
    assert.equal(a.status, 200, a.json.error);
    assert.equal(a.json.track!.title, "Tagged Title");
    assert.equal(a.json.track!.artist, "Tag Band");
    assert.ok(Math.abs(a.json.track!.durationMs - 3000) < 200, String(a.json.track!.durationMs));
    const b = await upload(t, "The Band - Untagged Tune.mp3", makeMp3({}, 2));
    assert.equal(b.json.track!.title, "Untagged Tune");
    assert.equal(b.json.track!.artist, "The Band");
    assert.equal((await upload(t, "notes.txt", Buffer.from("hi"))).status, 400);
    assert.match((await upload(t, "fake.mp3", Buffer.from("not audio at all".repeat(100)))).json.error!, /isn't/);
    assert.equal((await fetch(t.url + "/api/admin/library", { method: "POST", headers: { "x-filename": "a.mp3" }, body: makeMp3() })).status, 401);
  });

  test("local search", async () => {
    const r = (await (await t.get("/api/search?q=tag band")).json()) as { tracks: { title: string; sourceId: string }[] };
    assert.deepEqual(r.tracks.map((x) => x.title), ["Tagged Title"]);
    assert.match(r.tracks[0]!.sourceId, /^file:[a-f0-9]{16}$/);
  });

  test("audio files are for the box only", async () => {
    const file = t.music.library.all()[0]!.file;
    assert.equal((await t.get(`/box-audio/${file}`)).status, 403);
    assert.equal((await t.get(`/box-audio/${file}`, "box-token", { range: "bytes=0-99" })).status, 206);
  });

  test("plays on the box's default output; the next song starts when the box says it ended", async () => {
    await t.call("PUT", "/rules", { approval: "auto" });
    const [a, b] = t.music.library.all();
    for (const tr of [a!, b!]) {
      const r = await t.send("POST", "/api/request", { sourceId: `file:${tr.id}` });
      assert.equal(r.status, 200, await r.clone().text());
    }
    await t.music.player.tick();
    assert.equal(fake.sessions.length, 1);
    assert.equal(fake.sessions[0]!.output, "box:0-0");
    assert.deepEqual(fake.fetched, [{ path: `/box-audio/${a!.file}`, status: 206 }]);
    // Near the end (the files source hands over 10 s ahead; these songs are 2-3 s long).
    await t.music.player.tick();
    assert.equal(t.music.queue.handed().length, 1);
    fake.finish(fake.sessions[0]!.id);
    await until(() => fake.sessions.length === 2, "second song");
    assert.equal(fake.sessions[1]!.path, `/box-audio/${b!.file}`);
    await t.music.player.tick();
    assert.equal(t.music.queue.playing()?.track.sourceId, `file:${b!.id}`);
    const host = (await (await t.get("/api/admin/host", t.token)).json()) as { outputs: { id: string; name: string }[] };
    assert.ok(host.outputs.some((o) => o.id === "box:bt:11" && o.name === "Patio speaker"));
  });

  test("volume while playing", async () => {
    await t.call("POST", "/player/volume", { volume: 40 });
    assert.deepEqual(fake.volumes.at(-1), ["box:0-0", 40]);
  });

  test("a busy output answers in plain words until staff take it over", async () => {
    fake.busy.add("bt:11");
    await t.call("PUT", "/settings", { output: "box:bt:11" });
    const c = (await upload(t, "Another - One.mp3", makeMp3({}, 2))).json.track!;
    await t.send("POST", "/api/request", { sourceId: `file:${c.id}` });
    await t.music.player.tick();
    const host = (await (await t.get("/api/admin/host", t.token)).json()) as { busyOutput: string | null };
    assert.match(host.busyOutput ?? "", /Karaoke/);
    await t.call("POST", "/player/takeover");
    await t.music.player.tick();
    assert.equal(fake.sessions.at(-1)!.output, "bt:11");
    assert.equal(t.music.queue.playing()?.track.title, "One");
  });
});

describe("files with the speaker page (no box)", () => {
  let t: TestApp;
  let sock: Socket;
  before(async () => {
    t = await startApp({ speakerGraceMs: 100 });
    await t.call("PUT", "/settings", { source: "files" });
    await t.call("PUT", "/rules", { approval: "auto" });
  });
  after(async () => {
    sock?.close();
    await t.stop();
  });

  test("without a speaker page open, staff are told", async () => {
    const tr = (await upload(t, "Solo - Track.mp3", makeMp3({}, 2))).json.track!;
    await t.send("POST", "/api/request", { sourceId: `file:${tr.id}` });
    await t.music.player.tick();
    const host = (await (await t.get("/api/admin/host", t.token)).json()) as { problem: string; speakerConnected: boolean };
    assert.equal(host.speakerConnected, false);
    assert.match(host.problem, /Speaker page not open/);
  });

  test("the speaker page needs staff sign-in", async () => {
    const s = ioClient(t.url + "/speaker", { path: "/socket.io", auth: { token: "nope" }, reconnection: false, transports: ["websocket"] });
    const err = await new Promise<string>((r) => s.on("connect_error", (e) => r(e.message)));
    s.close();
    assert.match(err, /Sign in/);
  });

  test("plays what's sent, reports progress, and the next song follows", async () => {
    sock = ioClient(t.url + "/speaker", { path: "/socket.io", auth: { token: t.token }, transports: ["websocket"] });
    const loads: { trackId: string; url: string }[] = [];
    sock.on("load", (m) => loads.push(m));
    await until(() => t.music.speaker.connected, "speaker connected");
    await t.music.player.tick();
    await until(() => loads.length === 1, "load");
    // The signed link works without a header; a tampered one doesn't.
    assert.equal((await fetch(t.url + loads[0]!.url)).status, 200);
    assert.equal((await fetch(t.url + loads[0]!.url.replace(/s=[^&]+/, "s=bad"))).status, 403);
    sock.emit("state", { trackId: loads[0]!.trackId, positionMs: 1500, playing: true });
    await until(async () => ((await t.music.files.nowPlaying())?.progressMs ?? 0) >= 1500, "progress");
    const second = (await upload(t, "Duo - Second.mp3", makeMp3({}, 2))).json.track!;
    await t.send("POST", "/api/request", { sourceId: `file:${second.id}` });
    await t.music.player.tick();
    sock.emit("ended", { trackId: loads[0]!.trackId });
    await until(() => loads.length === 2, "second load");
    assert.equal(loads[1]!.trackId, second.id);
  });

  test("closing the speaker page stops with a message", async () => {
    sock.close();
    await until(() => t.music.files.problem === "The speaker page closed.", "closed message", 2000);
  });
});
