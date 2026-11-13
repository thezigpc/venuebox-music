// Drives the files source through `npx bargames mock-box . --base /music` (see BARGAMES.md):
// uploads two generated MP3s, requests them as a guest, and prints what the box plays.
// Start the app with ADMIN_PASSWORD=dev-password-123 and the mock box's env first.
import { makeMp3 } from "../fakes.js";
const G = "http://localhost:7080/music";
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const login = await j(await fetch(G + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "dev-password-123" }) }));
const H = { authorization: `Bearer ${login.token}` };
const call = async (m: string, p: string, b?: unknown) => j(await fetch(G + "/api/admin" + p, { method: m, headers: { ...H, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }));
console.log("settings", await call("PUT", "/settings", { source: "files" }));
console.log("rules", (await call("PUT", "/rules", { approval: "auto" })).ok);
for (const [n, title] of [["a", "Mock One"], ["b", "Mock Two"]]) {
  const r = await j(await fetch(G + "/api/admin/library", { method: "POST", headers: { ...H, "content-type": "application/octet-stream", "x-filename": `${n}.mp3` }, body: makeMp3({ title, artist: "Mock Band" }, 4) }));
  console.log("upload", r.track?.title, r.track?.durationMs);
}
const s = await j(await fetch(G + "/api/search?q=mock"));
console.log("search", s.tracks.map((t: { title: string }) => t.title));
const state = await call("GET", "/state");
console.log("outputs", state.outputs.map((o: { id: string; name: string }) => `${o.id}=${o.name}`));
let cookie = "";
for (const t of s.tracks) {
  const r = await fetch(G + "/api/request", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ sourceId: t.sourceId, name: "Tester" }) });
  cookie ||= (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  console.log("request", r.status, JSON.stringify(await j(r)));
}
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const h = await call("GET", "/host");
  console.log(i, h.nowPlaying ? `${h.nowPlaying.title} ${h.nowPlaying.progressMs}ms ${h.nowPlaying.playing}` : "nothing", "| handed", h.handed.length, "| queued", h.queue.length, "|", h.problem || h.sourceStatus.message);
}
console.log("history", (await call("GET", "/state")).history.map((x: { title: string; outcome: string }) => `${x.title}:${x.outcome}`));
const me = await j(await fetch(G + "/api/me", { headers: { cookie } }));
console.log("me", me.requests.map((r: { title: string; status: string }) => `${r.title}:${r.status}`));
