// "/host": staff. Pending requests (approve or skip), the queue (reorder, remove), now
// playing (skip, pause), the speaker (files source), and the requests on/off switch.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BoxAdminLink, VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl } from "@bargames/sdk/client";
import type { HostState, QueueItem, Track } from "@music/shared";
import { api, duration } from "../api";
import { Art, Notice, StaffGate, useAct } from "../components/StaffGate";
import { useVenue } from "../useVenue";

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function Host({ signOut, recheck }: { signOut: () => void; recheck: () => void }) {
  const [s, setS] = useState<HostState | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[] | null>(null);
  const reload = useCallback(async () => {
    try {
      setS(await api.host());
    } catch (err) {
      if ((err as { status?: number }).status === 401) recheck();
    }
  }, [recheck]);
  const { act, notice, setNotice } = useAct(reload, recheck);

  useEffect(() => {
    void reload();
    const t = setInterval(() => !document.hidden && void reload(), 2500);
    return () => clearInterval(t);
  }, [reload]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return setResults(null);
    await act(async () => setResults((await api.staffSearch(q)).tracks));
  };

  if (!s) return <p className="muted center-page">Loading…</p>;
  const np = s.nowPlaying;
  const row = (i: QueueItem, extra: React.ReactNode) => (
    <li key={i.id} className="track-row">
      <Art src={i.track.art} size={44} />
      <div className="track-text">
        <p className="track-title">
          {i.track.title}
          {i.track.explicit && <span className="pill">E</span>}
        </p>
        <p className="muted small">
          {i.track.artist} · {duration(i.track.durationMs)}
          {i.guestName ? ` · ${i.guestName}` : i.byStaff ? " · staff" : ""} · {ago(i.requestedAt)}
        </p>
      </div>
      <div className="row-actions">{extra}</div>
    </li>
  );

  return (
    <>
      <header className="ad-header">
        <h1>Staff</h1>
        <label className="switch">
          <input type="checkbox" checked={s.rules.requestsOpen} onChange={(e) => void act(() => api.rules({ requestsOpen: e.target.checked }), e.target.checked ? "Requests are on." : "Requests are off.")} />
          <span>Requests {s.rules.requestsOpen ? "on" : "off"}</span>
        </label>
        <div className="ad-header-links">
          <a href={bgUrl("/admin")}>Admin</a>
          <a href={bgUrl("/tv")} target="_blank" rel="noreferrer">
            TV
          </a>
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!s.source && (
        <p className="card warn">
          No music source yet. <a href={bgUrl("/admin")}>Set one up in the admin.</a>
        </p>
      )}
      {s.source && s.sourceStatus.state !== "ok" && <p className={`card ${s.sourceStatus.state === "error" ? "is-error" : "warn"}`}>{s.sourceStatus.message}</p>}
      {s.problem && (
        <div className="card is-error">
          <p>{s.problem}</p>
          <div className="btn-row">
            {s.held && (
              <button className={s.busyOutput ? "" : "primary"} onClick={() => void act(() => api.player("resume"), "Carrying on…")}>
                Carry on with the queue
              </button>
            )}
            {s.busyOutput && (
              <button className="primary" onClick={() => void act(() => api.player("takeover"), "Taking the speaker over…")}>
                Take the speaker over
              </button>
            )}
          </div>
        </div>
      )}
      {s.notice && <p className="card warn">{s.notice}</p>}

      <main className="host-grid">
        <section className="card">
          <h2>Now playing {s.sourceLabel && <span className="muted small">· {s.sourceLabel}</span>}</h2>
          {np ? (
            <div className="track-row np-row">
              <Art src={np.art} size={64} />
              <div className="track-text">
                <p className="track-title">{np.title}</p>
                <p className="muted small">
                  {np.artist} · {duration(np.progressMs)} / {duration(np.durationMs)}
                  {np.guestName ? ` · for ${np.guestName}` : !np.requested && !np.itemId ? " · the source's own music" : ""}
                </p>
              </div>
            </div>
          ) : (
            <p className="muted">Nothing is playing.</p>
          )}
          <div className="btn-row">
            {s.can.pause && np && (np.playing ? <button onClick={() => void act(() => api.player("pause"))}>Pause</button> : <button onClick={() => void act(() => api.player("resume"))}>Play</button>)}
            {s.can.skip && np && <button onClick={() => void act(() => api.player("skip"), "Skipped.")}>Skip</button>}
          </div>
          {s.source === "files" && (
            <div className="output-pick">
              <label>
                Speaker
                <select value={s.output} onChange={(e) => void act(() => api.settings({ output: e.target.value }), "Speaker changed.")}>
                  {s.outputs.map((o) => (
                    <option key={o.id} value={o.id} disabled={!o.available && o.id !== s.output}>
                      {o.name}
                      {o.busy ? " (in use)" : ""}
                      {!o.available ? " (not available)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {s.output === "speaker" || !s.outputs.some((o) => o.kind === "box") ? (
                <p className="muted small">
                  {s.speakerConnected ? "Speaker page is open." : "Speaker page not open."}{" "}
                  <a href={bgUrl("/speaker")} target="_blank" rel="noreferrer">
                    Open the speaker page
                  </a>{" "}
                  on the computer wired to the sound system.
                </p>
              ) : (
                np && (
                  <label className="volume">
                    Volume
                    <input type="range" min={0} max={100} defaultValue={s.outputs.find((o) => o.id === s.output)?.volume ?? 60} onChange={(e) => void act(() => api.volume(Number(e.target.value)))} />
                  </label>
                )
              )}
            </div>
          )}
        </section>

        <section className="card">
          <h2>
            Waiting for approval <span className="count">{s.pending.length}</span>
          </h2>
          {s.rules.approval === "auto" && <p className="muted small">Requests go straight on (automatic approval, set in the admin).</p>}
          {s.pending.length === 0 && s.rules.approval === "staff" && <p className="muted">No requests waiting.</p>}
          <ul className="list">
            {s.pending.map((i) =>
              row(
                i,
                <>
                  <button className="primary" onClick={() => void act(() => api.approve(i.id))}>
                    Approve
                  </button>
                  <button onClick={() => void act(() => api.reject(i.id))}>Skip</button>
                </>,
              ),
            )}
          </ul>
        </section>

        <section className="card">
          <h2>
            Queue <span className="count">{s.handed.length + s.queue.length}</span>
          </h2>
          {s.handed.length + s.queue.length === 0 && <p className="muted">The queue is empty.</p>}
          <ol className="list">
            {s.handed.map((i) => row(i, <span className="muted small">Sent to {s.sourceLabel}</span>))}
            {s.queue.map((i, n) =>
              row(
                i,
                <>
                  <button aria-label="Move up" disabled={n === 0} onClick={() => void act(() => api.move(i.id, n - 1))}>
                    ↑
                  </button>
                  <button aria-label="Move down" disabled={n === s.queue.length - 1} onClick={() => void act(() => api.move(i.id, n + 1))}>
                    ↓
                  </button>
                  <button aria-label="Remove" className="danger" onClick={() => void act(() => api.remove(i.id))}>
                    ✕
                  </button>
                </>,
              ),
            )}
          </ol>
          {s.handed.length > 0 && <p className="muted small">Songs already sent to {s.sourceLabel} can't be moved or removed.</p>}
        </section>

        {s.can.search && (
          <section className="card">
            <h2>Add a song</h2>
            <form className="search-row" onSubmit={search}>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song or artist" />
              <button className="primary">Search</button>
            </form>
            <ul className="list">
              {results?.map((t) => (
                <li key={t.sourceId} className="track-row">
                  <Art src={t.art} size={40} />
                  <div className="track-text">
                    <p className="track-title">{t.title}</p>
                    <p className="muted small">
                      {t.artist} · {duration(t.durationMs)}
                    </p>
                  </div>
                  <button onClick={() => void act(() => api.staffAdd(t.sourceId), "Added to the queue.")}>Add</button>
                </li>
              ))}
            </ul>
            <p className="muted small">Staff picks skip the guest rules (but never go in twice).</p>
          </section>
        )}
      </main>
    </>
  );
}

export function HostPage() {
  const venue = useVenue();
  useEffect(() => void (document.title = "Music · staff"), []);
  return (
    <div className="ad-page">
      <VenueAnnouncement ctx={venue} />
      <BoxAdminLink ctx={venue} />
      <StaffGate title="Music · staff">{(signOut, recheck) => <Host signOut={signOut} recheck={recheck} />}</StaffGate>
    </div>
  );
}
