// The queue and the player against a fake source: one-ahead handover, reorder, remove,
// skip, pause, the source's own music, and failures.
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, type HistoryEntry, type Rules } from "@music/shared";
import { Player } from "../src/player.js";
import { RequestQueue } from "../src/queue.js";
import { SourceError } from "../src/sources/types.js";
import { FakeSource, track } from "./fakes.js";

let clock: number;
let rules: Rules;
let q: RequestQueue;
let src: FakeSource;
let player: Player;
let events: string[];
let history: Pick<HistoryEntry, "title" | "outcome" | "requested">[];

const guest = (id: string) => ({ id, name: id.toUpperCase() });
function add(id: string, g = "g1") {
  const r = q.request(track(id), guest(g));
  assert.ok(r.ok, r.ok ? "" : r.block.message);
  return r.item;
}
/** Advances time and lets the player look. */
async function run(ms: number, step = 1000) {
  for (let t = 0; t < ms; t += step) {
    clock += step;
    src.advance(step);
    await player.tick();
  }
}

beforeEach(() => {
  clock = 1_000_000;
  rules = { ...DEFAULT_RULES, approval: "auto", perGuestCount: 0, maxPendingPerGuest: 0 };
  q = new RequestQueue({ items: [], requests: [], plays: [] }, () => rules, () => clock);
  src = new FakeSource();
  events = [];
  history = [];
  player = new Player({
    queue: q,
    source: () => src,
    now: () => clock,
    manual: true,
    events: {
      nowPlaying: (np) => void events.push(`now:${np.title}`),
      finished: (_i, np, outcome) => void history.push({ title: np.title, outcome, requested: np.requested }),
    },
  });
});

describe("queue", () => {
  test("staff approval: pending until approved, then to the end of the queue", () => {
    rules.approval = "staff";
    const a = add("a");
    const b = add("b", "g2");
    assert.deepEqual(q.pending().map((i) => i.id), [a.id, b.id]);
    q.approve(b.id);
    q.approve(a.id);
    assert.deepEqual(q.queued().map((i) => i.track.sourceId), ["b", "a"]);
    assert.throws(() => q.approve(a.id), /moved on/);
  });

  test("reorder and remove", () => {
    const [a, b, c] = [add("a"), add("b"), add("c")];
    q.move(c.id, 0);
    assert.deepEqual(q.queued().map((i) => i.track.sourceId), ["c", "a", "b"]);
    q.move(c.id, 99);
    assert.deepEqual(q.queued().map((i) => i.track.sourceId), ["a", "b", "c"]);
    q.remove(b.id);
    assert.deepEqual(q.queued().map((i) => i.track.sourceId), ["a", "c"]);
    assert.equal(q.find(b.id)?.status, "removed");
    void a;
  });

  test("a rule block comes back in plain words and isn't added", () => {
    rules.blockExplicit = true;
    const r = q.request(track("x", { explicit: true }), guest("g1"));
    assert.equal(r.ok, false);
    assert.equal(q.active.length, 0);
  });
});

describe("player", () => {
  test("starts the first song at once when nothing plays", async () => {
    add("a");
    await player.tick();
    assert.equal(src.current?.track.sourceId, "a");
    assert.equal(q.playing()?.track.sourceId, "a");
    assert.deepEqual(events, ["now:Song a"]);
  });

  test("hands over one song at a time, shortly before the current one ends", async () => {
    add("a");
    add("b");
    add("c");
    await player.tick();
    // Halfway through "a": nothing else has gone to the source yet.
    await run(100_000);
    assert.deepEqual(src.calls, ["play:a"]);
    assert.equal(q.handed().length, 0);
    // 15 s before the end, "b" (only "b") is handed over.
    await run(86_000);
    assert.deepEqual(src.calls, ["play:a", "play:b"]);
    assert.deepEqual(q.handed().map((i) => i.track.sourceId), ["b"]);
    assert.deepEqual(q.queued().map((i) => i.track.sourceId), ["c"]);
    // "b" starts when "a" ends; "a" goes to history.
    await run(15_000);
    assert.equal(q.playing()?.track.sourceId, "b");
    assert.deepEqual(history, [{ title: "Song a", outcome: "played", requested: true }]);
  });

  test("staff can reorder and remove until a song is handed over, not after", async () => {
    add("a");
    const b = add("b");
    const c = add("c");
    await player.tick();
    q.move(c.id, 0);
    await run(190_000);
    assert.deepEqual(q.handed().map((i) => i.track.sourceId), ["c"]);
    assert.throws(() => q.remove(c.id), /already gone to the music player/);
    assert.throws(() => q.move(c.id, 1), /already gone/);
    q.remove(b.id);
    await run(30_000);
    assert.equal(q.playing()?.track.sourceId, "c");
    assert.equal(q.next(), null);
  });

  test("skip hands the next request over first, so it plays next", async () => {
    add("a");
    add("b");
    await player.tick();
    await run(5_000);
    await player.skip();
    assert.deepEqual(src.calls, ["play:a", "play:b", "skip"]);
    assert.equal(q.playing()?.track.sourceId, "b");
    assert.deepEqual(history, [{ title: "Song a", outcome: "skipped", requested: true }]);
  });

  test("a staff pause isn't mistaken for the end of the queue", async () => {
    add("a");
    await player.tick();
    await player.pause();
    add("b");
    await run(10_000);
    assert.equal(src.current?.track.sourceId, "a");
    assert.equal(q.playing()?.track.sourceId, "a");
    await player.resume();
    assert.equal(src.current?.playing, true);
  });

  test("the source's own music plays between requests and counts in history", async () => {
    src.current = { track: track("bg1"), progressMs: 0, playing: true };
    await player.tick();
    assert.deepEqual(events, ["now:Song bg1"]);
    add("a");
    await run(180_000);
    assert.deepEqual(src.calls, []);
    await run(10_000);
    assert.deepEqual(src.calls, ["play:a"]);
    await run(15_000);
    assert.equal(q.playing()?.track.sourceId, "a");
    assert.deepEqual(history, [{ title: "Song bg1", outcome: "played", requested: false }]);
    // It counts for "no repeats".
    assert.ok(q.plays.some((p) => p.sourceId === "bg1"));
  });

  test("a song that stops in place at the end (Spotify) moves the queue on", async () => {
    add("a");
    await player.tick();
    // The player keeps showing "a", stopped at 0, after it finished.
    src.current = { track: track("a"), progressMs: 0, playing: false };
    clock += 30_000;
    add("b");
    await player.tick();
    assert.equal(q.find(q.playing()!.id)?.track.sourceId, "b");
    assert.deepEqual(history.map((h) => h.title), ["Song a"]);
  });

  test("a source error is shown, the song stays queued, and it retries", async () => {
    add("a");
    src.failPlay = new SourceError("no-device", "No Spotify device is active.");
    await player.tick();
    assert.equal(player.problem, "No Spotify device is active.");
    assert.equal(q.queued().length, 1);
    src.failPlay = null;
    await player.tick();
    assert.equal(player.problem, "");
    assert.equal(q.playing()?.track.sourceId, "a");
  });

  test("a song the source can never play is dropped, not retried forever", async () => {
    add("a");
    add("b");
    src.failPlay = new SourceError("gone", "Song a isn't in the library any more.");
    await player.tick();
    assert.equal(q.next()?.track.sourceId, "b");
    src.failPlay = null;
    await player.tick();
    assert.equal(q.playing()?.track.sourceId, "b");
  });

  test("a handed song that never starts is dropped so the queue keeps moving", async () => {
    add("a");
    add("b");
    add("c");
    await player.tick();
    await run(190_000);
    assert.equal(q.handed()[0]?.track.sourceId, "b");
    // Someone cleared the player's own queue: "b" never comes.
    src.upcoming = [];
    await run(10_000);
    assert.equal(src.current, null);
    await run(120_000);
    assert.equal(q.find(q.handed()[0]?.id ?? "")?.track.sourceId ?? null, null);
    assert.equal(q.playing()?.track.sourceId, "c");
  });
});
