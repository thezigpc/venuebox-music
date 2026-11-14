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

describe("files on a box 0.15.4 (endReason)", () => {
  let t: TestApp;
  let fake: FakeAudio;
  let n = 0;
  type Host = { problem: string; held: string | null; busyOutput: string | null; notice: string };
  const host = async () => (await (await t.get("/api/admin/host", t.token)).json()) as Host;
  before(async () => {
    const bg = makeBarGames({ defaultName: "Music", coreUrl: "http://127.0.0.1:1", token: "box-token" });
    let url = "";
    fake = new FakeAudio(() => url, "box-token");
    t = await startApp({ bg, audio: fake.api() });
    url = t.url;
    await t.call("PUT", "/settings", { source: "files" });
  });
  after(() => t.stop());

  /** Two new songs from staff: the first plays, the second is handed (in the next slot). */
  async function twoSongs(): Promise<[string, string]> {
    const titles: string[] = [];
    for (let i = 0; i < 2; i++) {
      const tr = (await upload(t, `Band - Song ${++n}.mp3`, makeMp3({}, 2))).json.track!;
      await t.call("POST", "/queue", { sourceId: `file:${tr.id}` });
      titles.push(tr.title);
    }
    await t.music.player.tick();
    await t.music.player.tick();
    assert.equal(t.music.queue.playing()?.track.title, titles[0]);
    assert.equal(t.music.queue.handed()[0]?.track.title, titles[1]);
    return titles as [string, string];
  }
  /** Let the last song finish so the next test starts with nothing playing. */
  async function drain() {
    fake.endWith(fake.sessions.at(-1)!.id, "finished");
    await t.music.player.tick();
    assert.equal(t.music.queue.playing(), null);
    assert.equal(t.music.queue.next(), null);
  }

  test("finished: the next song starts", async () => {
    const [, second] = await twoSongs();
    const before = fake.sessions.length;
    fake.endWith(fake.sessions.at(-1)!.id, "finished");
    await until(() => fake.sessions.length === before + 1, "next song");
    await t.music.player.tick();
    assert.equal(t.music.queue.playing()?.track.title, second);
    assert.equal((await host()).held, null);
    await drain();
  });

  test("error: the queue moves on and staff get a note", async () => {
    const [first, second] = await twoSongs();
    const before = fake.sessions.length;
    fake.endWith(fake.sessions.at(-1)!.id, "error", "The app's audio file wasn't found.");
    await until(() => fake.sessions.length === before + 1, "next song");
    await t.music.player.tick();
    assert.equal(t.music.queue.playing()?.track.title, second);
    const h = await host();
    assert.equal(h.held, null);
    assert.equal(h.notice, `"${first}" couldn't play (The app's audio file wasn't found), so the queue moved on.`);
    await drain();
  });

  for (const reason of ["stopped", "disconnected"] as const) {
    test(`${reason}: the queue waits until staff carry on`, async () => {
      const [, second] = await twoSongs();
      const before = fake.sessions.length;
      fake.endWith(fake.sessions.at(-1)!.id, reason, reason === "disconnected" ? "The speaker disconnected." : undefined);
      await t.music.player.tick();
      await t.music.player.tick();
      assert.equal(fake.sessions.length, before, "nothing new started");
      assert.equal(t.music.queue.playing(), null);
      // The handed song went back to the queue, still first.
      assert.equal(t.music.queue.handed().length, 0);
      assert.equal(t.music.queue.next()?.track.title, second);
      const h = await host();
      assert.equal(h.held, reason);
      assert.equal(h.busyOutput, null);
      assert.match(h.problem, reason === "disconnected" ? /speaker went away \(The speaker disconnected\)/ : /stopped on/);
      await t.call("POST", "/player/resume");
      assert.equal(fake.sessions.length, before + 1);
      assert.equal(t.music.queue.playing()?.track.title, second);
      const after = await host();
      assert.equal(after.held, null);
      assert.equal(after.problem, "");
      await drain();
    });
  }

  test("replaced: the queue waits; staff can take the speaker over", async () => {
    const [, second] = await twoSongs();
    const before = fake.sessions.length;
    fake.busy.add("box:0-0");
    fake.endWith(fake.sessions.at(-1)!.id, "replaced", "Replaced by something else on Bar amp.");
    await t.music.player.tick();
    assert.equal(fake.sessions.length, before);
    const h = await host();
    assert.equal(h.held, "replaced");
    assert.match(h.busyOutput ?? "", /Something else started on .*Replaced by something else on Bar amp/);
    await t.call("POST", "/player/takeover");
    await t.music.player.tick();
    assert.equal(fake.sessions.length, before + 1);
    assert.equal(t.music.queue.playing()?.track.title, second);
    assert.equal((await host()).held, null);
    fake.busy.delete("box:0-0");
    await drain();
  });

  test("our own skip isn't mistaken for a stop", async () => {
    const [, second] = await twoSongs();
    await t.call("POST", "/player/skip");
    await t.music.player.tick();
    assert.equal(t.music.queue.playing()?.track.title, second);
    assert.equal((await host()).held, null);
    await drain();
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
