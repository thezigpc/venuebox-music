// The request rules and the Spotify redirect helpers.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkRequest, cleanRules, containsWords, DEFAULT_RULES, describeRules, LOOPBACK_REDIRECT, parseRedirect, redirectUriFor, type QueueItem, type RuleContext, type Rules, type Track } from "../src/index.js";

const MIN = 60_000;
const t = (id: string, extra: Partial<Track> = {}): Track => ({ sourceId: id, title: `Song ${id}`, artist: "Band", durationMs: 200_000, ...extra });
const item = (id: string, guestId: string, status: QueueItem["status"] = "queued"): QueueItem => ({ id, track: t(id), guestId, guestName: "", requestedAt: 0, status });
const ctx = (over: Partial<RuleContext> = {}, rules: Partial<Rules> = {}): RuleContext => ({
  rules: { ...DEFAULT_RULES, ...rules },
  guestId: "g1",
  now: 1_000 * MIN,
  active: [],
  requests: [],
  plays: [],
  ...over,
});

describe("rules", () => {
  test("a fresh request goes through", () => {
    assert.equal(checkRequest(t("a"), ctx()), null);
  });

  test("requests off", () => {
    assert.equal(checkRequest(t("a"), ctx({}, { requestsOpen: false }))?.rule, "closed");
    // Staff can still add songs.
    assert.equal(checkRequest(t("a"), ctx({ staff: true }, { requestsOpen: false })), null);
  });

  test("explicit songs are blocked by default, and can be allowed", () => {
    const b = checkRequest(t("a", { explicit: true }), ctx());
    assert.equal(b?.rule, "explicit");
    assert.match(b!.message, /Explicit/);
    assert.equal(checkRequest(t("a", { explicit: true }), ctx({}, { blockExplicit: false })), null);
  });

  test("blocked artists and words match whole words, any case or accent", () => {
    assert.equal(checkRequest(t("a", { artist: "Mötley Crüe" }), ctx({}, { blockedArtists: ["motley crue"] }))?.rule, "artist");
    assert.equal(checkRequest(t("a", { artist: "Bandana" }), ctx({}, { blockedArtists: ["band"] })), null);
    assert.equal(checkRequest(t("a", { title: "Happy Birthday (Remix)" }), ctx({}, { blockedWords: ["birthday"] }))?.rule, "word");
    assert.equal(checkRequest(t("a", { title: "Birthdays" }), ctx({}, { blockedWords: ["birthday"] })), null);
    assert.ok(containsWords("AC/DC - Live", "ac dc"));
  });

  test("longest song", () => {
    const b = checkRequest(t("a", { durationMs: 9 * MIN }), ctx({}, { maxSongMinutes: 8 }));
    assert.equal(b?.rule, "length");
    assert.match(b!.message, /longer than 8 minutes/);
    assert.equal(checkRequest(t("a", { durationMs: 9 * MIN }), ctx({}, { maxSongMinutes: 0 })), null);
  });

  test("songs waiting per guest", () => {
    const active = [item("x", "g1"), item("y", "g1", "pending"), item("z", "g2")];
    const b = checkRequest(t("a"), ctx({ active }, { maxPendingPerGuest: 2 }));
    assert.equal(b?.rule, "pending");
    assert.match(b!.message, /2 songs waiting/);
    // A handed or playing song no longer counts as waiting.
    const later = [item("x", "g1", "playing"), item("y", "g1", "handed")];
    assert.equal(checkRequest(t("a"), ctx({ active: later }, { maxPendingPerGuest: 2 })), null);
  });

  test("requests per guest per N minutes says when to come back", () => {
    const now = 1_000 * MIN;
    const requests = [
      { guestId: "g1", at: now - 25 * MIN, sourceId: "p" },
      { guestId: "g1", at: now - 10 * MIN, sourceId: "q" },
      { guestId: "g1", at: now - 1 * MIN, sourceId: "r" },
      { guestId: "g2", at: now - 1 * MIN, sourceId: "s" },
    ];
    const b = checkRequest(t("a"), ctx({ requests }, { perGuestCount: 3, perGuestMinutes: 30 }));
    assert.equal(b?.rule, "rate");
    assert.match(b!.message, /3 songs every 30 minutes\. Try again in 5 minutes/);
    assert.equal(checkRequest(t("a"), ctx({ requests, guestId: "g2" })), null);
  });

  test("no repeats within N minutes, and never twice in the queue", () => {
    const now = 1_000 * MIN;
    const b = checkRequest(t("a"), ctx({ plays: [{ sourceId: "a", at: now - 20 * MIN }] }, { noRepeatMinutes: 60 }));
    assert.equal(b?.rule, "repeat");
    assert.match(b!.message, /Try again in 40 minutes/);
    assert.equal(checkRequest(t("a"), ctx({ plays: [{ sourceId: "a", at: now - 61 * MIN }] }, { noRepeatMinutes: 60 })), null);
    assert.equal(checkRequest(t("a"), ctx({ active: [item("a", "g2")] }))?.message, "That song is already in the queue.");
    assert.equal(checkRequest(t("a"), ctx({ active: [item("a", "g2")], staff: true }))?.rule, "repeat");
  });

  test("a full queue", () => {
    const active = Array.from({ length: 3 }, (_, i) => item(`q${i}`, `g${i + 5}`));
    assert.equal(checkRequest(t("a"), ctx({ active }, { maxQueue: 3 }))?.rule, "full");
  });

  test("cleanRules checks numbers and lists", () => {
    assert.throws(() => cleanRules(DEFAULT_RULES, { perGuestCount: -1 }), /0 to 50/);
    assert.throws(() => cleanRules(DEFAULT_RULES, { approval: "maybe" }), /staff or auto/);
    const r = cleanRules(DEFAULT_RULES, { blockedWords: "one, two\nthree,, one", approval: "auto", maxSongMinutes: 10 });
    assert.deepEqual(r.blockedWords, ["one", "two", "three"]);
    assert.equal(r.approval, "auto");
    assert.equal(r.maxSongMinutes, 10);
    assert.ok(describeRules(DEFAULT_RULES).includes("No explicit songs."));
  });
});

describe("Spotify redirect", () => {
  test("which redirect URI to register", () => {
    assert.deepEqual(redirectUriFor("https://bar.example.com", "/music"), { uri: "https://bar.example.com/music/admin/spotify/callback", paste: false });
    assert.deepEqual(redirectUriFor("http://127.0.0.1:3009", ""), { uri: "http://127.0.0.1:3009/admin/spotify/callback", paste: false });
    assert.deepEqual(redirectUriFor("http://192.168.1.20:3009", ""), { uri: LOOPBACK_REDIRECT, paste: true });
    assert.deepEqual(redirectUriFor("http://localhost:3009", ""), { uri: LOOPBACK_REDIRECT, paste: true });
  });

  test("reads the code from a pasted address", () => {
    const ok = parseRedirect("  http://127.0.0.1:8909/callback?code=AQBx-abc_123.456~xyz&state=abcdefgh1234  ");
    assert.deepEqual(ok, { ok: true, code: "AQBx-abc_123.456~xyz", state: "abcdefgh1234" });
    assert.deepEqual(parseRedirect("?code=AQBx-abc_123456&state=abcdefgh1234"), { ok: true, code: "AQBx-abc_123456", state: "abcdefgh1234" });
    assert.deepEqual(parseRedirect("code=AQBx-abc_123456&state=abcdefgh1234"), { ok: true, code: "AQBx-abc_123456", state: "abcdefgh1234" });
  });

  test("explains what's wrong with a bad paste", () => {
    assert.match((parseRedirect("") as { error: string }).error, /Paste/);
    assert.match((parseRedirect("http://127.0.0.1:8909/callback?error=access_denied&state=abcdefgh1234") as { error: string }).error, /cancelled/);
    assert.match((parseRedirect("http://127.0.0.1:8909/callback") as { error: string }).error, /no sign-in code/);
    assert.match((parseRedirect("http://x/cb?code=<script>&state=abcdefgh1234") as { error: string }).error, /doesn't look like/);
  });
});
