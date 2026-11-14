// SDK 0.13.1's endReason against `npx bargames mock-box . --base /music` (see BARGAMES.md).
// Three 4 s songs: the first plays to the end ("finished") and the second follows; the
// second is then stopped on the box ("stopped", as staff would from the box admin), and the
// queue must wait with the third; "Carry on" starts it.
// Start the app with ADMIN_PASSWORD=dev-password-123 and the mock box's env first.
import { makeMp3 } from "../fakes.js";
const G = "http://localhost:7381/music";
const CORE = "http://127.0.0.1:7399";
const BOX = { authorization: "Bearer dev-token" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const login = await j(await fetch(G + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "dev-password-123" }) }));
const H = { authorization: `Bearer ${login.token}` };
const call = async (m: string, p: string, b?: unknown) => j(await fetch(G + "/api/admin" + p, { method: m, headers: { ...H, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }));
const sessions = async () => (await j(await fetch(CORE + "/internal/audio/sessions", { headers: BOX }))) as { id: string; title?: string; state: string; endReason?: string }[];
const show = async (label: string) => {
  const h = await call("GET", "/host");
  console.log(label.padEnd(10), "|", h.nowPlaying ? `${h.nowPlaying.title} ${h.nowPlaying.playing ? "playing" : "stopped"}` : "nothing", "| queued", h.queue.map((i: { track: { title: string } }) => i.track.title).join(", ") || "-", "| held", h.held, "|", h.problem || "-");
  return h;
};
let ok = true;
const expect = (what: string, cond: boolean) => {
  console.log(cond ? "  ok  " : "  FAIL", what);
  ok &&= cond;
};

await call("PUT", "/settings", { source: "files" });
const stamp = Date.now().toString(36);
for (const n of [1, 2, 3]) {
  const r = await j(await fetch(G + "/api/admin/library", { method: "POST", headers: { ...H, "content-type": "application/octet-stream", "x-filename": `${n}.mp3` }, body: makeMp3({ title: `End ${stamp} ${n}`, artist: "Mock Band" }, 4) }));
  console.log(await call("POST", "/queue", { sourceId: `file:${r.track.id}` }), r.track.title);
}
await wait(1500);
await show("start");
await wait(5000); // the first one plays to the end
const h1 = await show("finished");
const s1 = (await sessions()).find((s) => s.title === `End ${stamp} 1`);
expect(`song 1 ended with endReason "finished" (got ${s1?.endReason})`, s1?.endReason === "finished");
expect("song 2 followed on its own", h1.nowPlaying?.title === `End ${stamp} 2`);

const s2 = (await sessions()).find((s) => s.title === `End ${stamp} 2` && s.state === "playing");
console.log("stop on the box:", (await j(await fetch(`${CORE}/internal/audio/sessions/${s2!.id}/stop`, { method: "POST", headers: BOX }))).endReason);
await wait(3000);
const h2 = await show("stopped");
expect("the queue waits after a stop", h2.held === "stopped" && !h2.nowPlaying && h2.queue[0]?.track.title === `End ${stamp} 3`);

console.log(await call("POST", "/player/resume"));
await wait(1500);
const h3 = await show("carry on");
expect("Carry on starts song 3", h3.nowPlaying?.title === `End ${stamp} 3` && h3.held === null);
await wait(5000);
await show("end");
console.log(ok ? "ALL OK" : "SOMETHING FAILED");
process.exit(ok ? 0 : 1);
