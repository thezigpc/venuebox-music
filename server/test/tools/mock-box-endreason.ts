// Every endReason through `npx bargames mock-box` (SDK 0.13.2+). Start the mock box and the
// app as in CLAUDE.md ("Mock box on this PC"), with ADMIN_PASSWORD=dev-password-123:
//   MSYS_NO_PATHCONV=1 npx bargames mock-box . --base /music --port 7381 --core-port 7399
// Song 1 (3 s) plays to the end ("finished"); the others (30 s) are ended through the mock's
// POST /__bargames/dev/audio/end?reason=… : stopped, replaced, disconnected hold the queue
// until staff carry on (or take the speaker over); error moves on with a note.
import { makeMp3 } from "../fakes.js";
const GW = process.env.GW ?? "http://localhost:7381";
const G = `${GW}/music`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const login = await j(await fetch(G + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "dev-password-123" }) }));
const H = { authorization: `Bearer ${login.token}` };
const call = async (m: string, p: string, b?: unknown) => j(await fetch(G + "/api/admin" + p, { method: m, headers: { ...H, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }));
type Host = { nowPlaying: { title: string } | null; queue: { track: { title: string } }[]; held: string | null; busyOutput: string | null; problem: string; notice: string };
const show = async (label: string): Promise<Host> => {
  const h = (await call("GET", "/host")) as Host;
  console.log(label.padEnd(13), "|", h.nowPlaying?.title ?? "nothing", "| queued", h.queue.map((i) => i.track.title).join(", ") || "-", "| held", h.held, "|", h.problem || h.notice || "-");
  return h;
};
const endAs = async (reason: string) => console.log(`  box ends it: ${reason}`, JSON.stringify(await j(await fetch(`${GW}/__bargames/dev/audio/end?reason=${reason}`, { method: "POST" }))).slice(0, 120));
let ok = true;
const expect = (what: string, cond: boolean) => {
  console.log(cond ? "  ok  " : "  FAIL", what);
  ok &&= cond;
};

await call("PUT", "/settings", { source: "files" });
const stamp = Date.now().toString(36);
const t = (n: number) => `End ${stamp} ${n}`;
for (const n of [1, 2, 3, 4, 5, 6]) {
  const r = await j(await fetch(G + "/api/admin/library", { method: "POST", headers: { ...H, "content-type": "application/octet-stream", "x-filename": `${n}.mp3` }, body: makeMp3({ title: t(n), artist: "Mock Band" }, n === 1 ? 3 : 30) }));
  await call("POST", "/queue", { sourceId: `file:${r.track.id}` });
}
await wait(1500);
await show("start");

await wait(4500); // song 1 plays to the end
let h = await show("finished");
expect("finished: song 2 followed on its own", h.nowPlaying?.title === t(2) && h.held === null);

for (const [reason, next] of [["stopped", 3], ["replaced", 4], ["disconnected", 5]] as const) {
  await endAs(reason);
  await wait(2500);
  h = await show(reason);
  expect(`${reason}: the queue waits, song ${next} first`, h.held === reason && !h.nowPlaying && h.queue[0]?.track.title === t(next));
  if (reason === "replaced") expect("replaced: staff can take the speaker over", !!h.busyOutput);
  if (reason === "disconnected") expect("disconnected: says the speaker went away", /speaker went away/.test(h.problem));
  await call("POST", reason === "replaced" ? "/player/takeover" : "/player/resume");
  await wait(2000);
  h = await show(reason === "replaced" ? "take over" : "carry on");
  expect(`song ${next} starts after staff act`, h.nowPlaying?.title === t(next) && h.held === null);
}

await endAs("error");
await wait(2500);
h = await show("error");
expect("error: the queue moved on to song 6 with a note", h.nowPlaying?.title === t(6) && h.held === null && h.notice.includes(t(5)));

await endAs("stopped"); // leave the mock quiet
console.log(ok ? "ALL OK" : "SOMETHING FAILED");
process.exit(ok ? 0 : 1);
