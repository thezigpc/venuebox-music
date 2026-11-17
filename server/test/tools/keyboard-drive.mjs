// Kit 0.10's on-screen keyboard through the mock box, in headless Edge driven over the
// DevTools protocol (real taps: pointer events at each key's centre). See CLAUDE.md ("Mock
// box on this PC") for starting the mock box and the app first, with free ports, and an
// admin password of dev-password-123.
//   GW=http://localhost:<P> DEBUG_PORT=<free> npx tsx server/test/tools/keyboard-drive.mjs
// Screenshots go to OUT (default: the system temp folder). Edge is closed at the end.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GW = process.env.GW ?? "http://localhost:7581";
const BASE = `${GW}/music`;
const DEBUG = Number(process.env.DEBUG_PORT ?? 9333);
const OUT = process.env.OUT ?? tmpdir();
const EDGE = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const expect = (what, cond, extra = "") => {
  console.log(cond ? "  ok  " : "  FAIL", what, cond ? "" : extra);
  ok &&= !!cond;
};

// ---- seed: files source, automatic approval, three songs
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const login = await j(await fetch(BASE + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "dev-password-123" }) }));
const H = { authorization: `Bearer ${login.token}` };
const call = async (m, p, b) => j(await fetch(BASE + "/api/admin" + p, { method: m, headers: { ...H, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }));
const { makeMp3 } = await import("../fakes.ts").catch(() => ({ makeMp3: null }));
await call("PUT", "/settings", { source: "files" });
await call("PUT", "/rules", { approval: "auto", perGuestCount: 0, maxPendingPerGuest: 0, noRepeatMinutes: 0 });
if (makeMp3 && !(await call("GET", "/state")).library.tracks.length) {
  for (const t of ["Mock Song One", "Mock Song Two", "Mock Song Three"]) {
    await fetch(BASE + "/api/admin/library", { method: "POST", headers: { ...H, "content-type": "application/octet-stream", "x-filename": `${t}.mp3` }, body: makeMp3({ title: t, artist: "Mock Band" }, 200) });
  }
}

// ---- Edge over the DevTools protocol
const profile = mkdtempSync(path.join(tmpdir(), "music-kbd-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let wsUrl = "";
for (let i = 0; i < 40 && !wsUrl; i++) {
  await wait(250);
  wsUrl = await fetch(`http://127.0.0.1:${DEBUG}/json/version`).then((r) => r.json()).then((v) => v.webSocketDebuggerUrl).catch(() => "");
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
let session = "";
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params, ...(session ? { sessionId: session } : {}) }));
  });
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
session = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
await send("Page.enable");
await send("Runtime.enable");

const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const size = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const open = async (url) => {
  await send("Page.navigate", { url });
  for (let i = 0; i < 40; i++) {
    await wait(250);
    if ((await evaluate("document.readyState")) === "complete" && (await evaluate("!!document.querySelector('#root > *')"))) break;
  }
  await wait(800);
};
const rect = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const tapAt = async ({ x, y }) => {
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "touch" });
  await wait(120);
};
const tap = async (sel) => {
  const r = await rect(sel);
  if (!r) throw new Error(`nothing to tap: ${sel}`);
  await tapAt(r);
};
const KB = '[aria-label="On-screen keyboard"]';
const keyboardShown = () => evaluate(`!!document.querySelector('${KB}')`);
const key = async (label) => {
  const r = await evaluate(`(() => { const k = [...document.querySelectorAll('${KB} [aria-label]')].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(label)}) ?? [...document.querySelectorAll('${KB} [aria-label]')].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(label.toUpperCase())}); if (!k) return null; const r = k.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!r) throw new Error(`no key "${label}"`);
  await tapAt(r);
};
const typeKeys = async (text) => {
  for (const c of text) await key(c === " " ? "space" : c);
};
const value = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.value`);
const keys = () => evaluate(`[...document.querySelectorAll('${KB} [aria-label]')].map((b) => b.getAttribute("aria-label"))`);
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, `kbd-${name}.png`), Buffer.from(data, "base64"));
};
const noSideScroll = () => evaluate("document.documentElement.scrollWidth <= innerWidth");

try {
  // 1. Phones: no flag, no keyboard, layout as before.
  console.log("phone 390x844, no flag");
  await size(390, 844, true);
  await open(`${BASE}/`);
  await tap('input[type="search"]');
  expect("no on-screen keyboard on a phone", !(await keyboardShown()));
  expect("no sideways scrolling", await noSideScroll());
  await shot("phone");

  for (const [w, h, label] of [[1920, 1080, "1080p"], [3840, 2160, "4k"]]) {
    console.log(`\n${label} with ?bg_keyboard=1`);
    await size(w, h);
    await open(`${BASE}/?bg_keyboard=1`);
    // A personal screen remembers the guest's name: start each pass without one.
    await evaluate("localStorage.removeItem('music.guestName')");
    await open(`${BASE}/?bg_keyboard=1&pass=${label}`);
    // Guest: search, name, request
    await tap('input[type="search"]');
    expect("search: keyboard opens", await keyboardShown());
    await typeKeys("mock");
    const typed = await value('input[type="search"]');
    expect(`search: typed with the keys ("${typed}")`, typed?.toLowerCase() === "mock", typed);
    await shot(`${label}-guest-search`);
    await key("Enter");
    await wait(1200);
    const found = await evaluate("document.querySelectorAll('.results li').length");
    expect(`search: Enter searched (${found} results)`, found > 0);
    await tap(".name-row input");
    expect("name: keyboard opens", await keyboardShown());
    await typeKeys("dana");
    expect("name: starts with a capital", (await value(".name-row input")) === "Dana", await value(".name-row input"));
    await key("Enter");
    await wait(300);
    expect("name: Enter closes the keyboard", !(await keyboardShown()));
    // Songs still queued or playing from an earlier run are refused (right): try the next.
    for (let i = 1; i <= found && !(await evaluate("!!document.querySelector('.results .ok')")); i++) {
      await tap(`.results li:nth-child(${i}) button`);
      await wait(1000);
    }
    expect("request: sent", /queue|Requested/.test(await evaluate("document.querySelector('.results .ok')?.textContent ?? ''")));
    await shot(`${label}-guest-sent`);

    // Staff: sign in through the mock gateway, then the host page
    await open(`${GW}/__bargames/staff?next=${encodeURIComponent("/music/host")}&bg_keyboard=1`);
    if (!(await evaluate("location.pathname")).endsWith("/host")) await open(`${BASE}/host?bg_keyboard=1`);
    await tap('.search-row input[type="search"]');
    expect("host search: keyboard opens", await keyboardShown());
    await typeKeys("two");
    await key("Enter");
    await wait(1000);
    expect("host search: Enter searched", (await evaluate("document.querySelectorAll('.list .track-row').length")) > 0);
    const before = await value(".output-pick select");
    await tap(".output-pick select");
    await wait(300);
    const picker = await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent)`);
    expect(`speaker dropdown: big-button list (${picker?.length ?? 0} buttons)`, picker?.length > 1);
    await shot(`${label}-host-picker`);
    const choice = await evaluate(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((b) => !b.disabled && /Patio|AirPlay|Bluetooth/.test(b.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: b.textContent }; })()`);
    if (choice) {
      await tapAt(choice);
      await wait(1200);
      const after = await value(".output-pick select");
      expect(`speaker dropdown: choosing changes it (${choice.t})`, after && after !== before, `${before} → ${after}`);
      await call("PUT", "/settings", { output: before });
    } else expect("speaker dropdown: an option to choose", false);

    // Admin: a rule number (number pad, Enter saves), the name, a library title
    await open(`${BASE}/admin?bg_keyboard=1#rules`);
    await tap(".rules-form input.num");
    const pad = await keys();
    expect("rule number: number pad", pad.includes("5") && !pad.includes("q"), pad.join(" "));
    for (let i = 0; i < 4; i++) await key("⌫");
    await typeKeys("7");
    await key("Enter");
    await wait(1000);
    expect("rule number: Enter saved it", (await call("GET", "/state")).rules.perGuestCount === 7);
    await shot(`${label}-admin-rules`);
    await call("PUT", "/rules", { perGuestCount: 0 });
    await open(`${BASE}/admin?bg_keyboard=1&tab=settings#settings`);
    await tap('input[placeholder="Music Requests"]');
    for (let i = 0; i < 40; i++) await key("⌫");
    await typeKeys("bar tunes");
    await key("Enter");
    await wait(1000);
    const saved = (await call("GET", "/state")).settings.name;
    expect(`app name: Enter saved it ("${saved}")`, saved === "Bar tunes", saved);
    await call("PUT", "/settings", { name: "" });
    await open(`${BASE}/admin?bg_keyboard=1&tab=source#source`);
    await tap('.lib-edit input[aria-label="Title"]');
    await key("space");
    await typeKeys("x");
    await key("Enter");
    await wait(1000);
    const titles = (await call("GET", "/state")).library.tracks.map((t) => t.title);
    expect("library title: Enter saved it", titles.some((t) => t.endsWith(" x")), titles.join(", "));
    for (const t of (await call("GET", "/state")).library.tracks) if (t.title.endsWith(" x")) await call("PATCH", `/library/${t.id}`, { title: t.title.slice(0, -2) });
    expect("admin: no sideways scrolling", await noSideScroll());
  }

  // 3. A shared screen (request kiosk): forgets the last person.
  console.log("\nshared screen (?bg_shared=1)");
  await size(1920, 1080);
  await open(`${BASE}/?bg_keyboard=1&bg_shared=1`);
  expect("kiosk: no remembered name", (await value(".name-row input")) === "");
  expect("kiosk: no 'Your requests'", !(await evaluate("[...document.querySelectorAll('h2')].some((h) => h.textContent === 'Your requests')")));
  await tap('input[type="search"]');
  await typeKeys("one");
  await key("Enter");
  await wait(1000);
  await tap(".name-row input");
  await typeKeys("sam");
  await key("Done");
  for (let i = 1; i <= 3 && !(await evaluate("!!document.querySelector('.results .ok')")); i++) {
    await tap(`.results li:nth-child(${i}) button`);
    await wait(800);
  }
  expect("kiosk: request sent", await evaluate("!!document.querySelector('.results .ok')"));
  await wait(6000);
  expect("kiosk: fresh 5 s after a request", (await value('input[type="search"]')) === "" && (await value(".name-row input")) === "" && (await evaluate("document.querySelectorAll('.results li').length")) === 0);

  // 4. ?bg_keyboard=0 turns it off again.
  await open(`${BASE}/?bg_keyboard=0`);
  await tap('input[type="search"]');
  expect("?bg_keyboard=0: no keyboard", !(await keyboardShown()));
} catch (err) {
  console.log("  FAIL", err.message);
  ok = false;
} finally {
  session = "";
  await send("Browser.close").catch(() => undefined);
  ws.close();
  await wait(500);
  if (edge.exitCode === null) edge.kill();
  await wait(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
}
console.log(ok ? "\nALL OK" : "\nSOMETHING FAILED");
process.exit(ok ? 0 : 1);
