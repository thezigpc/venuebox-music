// "/": guests search, request a song, and see their requests and the queue. No login: one
// device = one cookie. When a rule blocks a request, the guest sees which, in plain words.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { BackToGames, basePath, useGameName, VenueAnnouncement } from "@bargames/gamekit/client";
import { DEFAULT_NAME, type GuestState, type PublicState, type Track } from "@music/shared";
import { api, ApiError, duration } from "../api";
import { Art } from "../components/StaffGate";
import { useVenue } from "../useVenue";

const NAME_KEY = "music.guestName";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

const STATUS_TEXT: Record<string, string> = {
  pending: "Waiting for staff",
  queued: "In the queue",
  handed: "Up next",
  playing: "Playing now",
  played: "Played",
  skipped: "Skipped",
  rejected: "Not this time",
  removed: "Removed",
  failed: "Couldn't play",
};

export function GuestPage() {
  const venue = useVenue();
  const name = useGameName(basePath(), DEFAULT_NAME);
  const [pub, setPub] = useState<PublicState | null>(null);
  const [me, setMe] = useState<GuestState | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [guestName, setGuestName] = useState(readName);
  const [sent, setSent] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState("");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const [p, m] = await Promise.allSettled([api.now(), api.me()]);
    if (p.status === "fulfilled") setPub(p.value);
    if (m.status === "fulfilled") setMe(m.value);
  }, []);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (!stop) timer = setTimeout(tick, document.hidden ? 30_000 : 6_000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load]);

  const runSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    const query = q.trim();
    if (!query) return setResults(null);
    const n = ++seq.current;
    setSearching(true);
    setSearchError("");
    try {
      const r = await api.search(query);
      if (n === seq.current) setResults(r.tracks);
    } catch (err) {
      if (n === seq.current) setSearchError(err instanceof Error ? err.message : "Search didn't work.");
    } finally {
      if (n === seq.current) setSearching(false);
    }
  };

  const requestSong = async (t: Track) => {
    setBusy(t.sourceId);
    try {
      localStorage.setItem(NAME_KEY, guestName.trim());
    } catch {
      /* fine */
    }
    try {
      const r = await api.request(t.sourceId, guestName);
      setSent((s) => ({ ...s, [t.sourceId]: { ok: true, text: r.status === "pending" ? "Requested! Staff will approve it." : "Added to the queue!" } }));
      void load();
    } catch (err) {
      setSent((s) => ({ ...s, [t.sourceId]: { ok: false, text: err instanceof ApiError || err instanceof Error ? err.message : "That didn't work." } }));
    } finally {
      setBusy("");
    }
  };

  const np = pub?.nowPlaying;
  const open = pub?.requestsOpen ?? false;
  const waiting = me?.requests.filter((r) => ["pending", "queued", "handed", "playing"].includes(r.status)) ?? [];
  const done = me?.requests.filter((r) => !["pending", "queued", "handed", "playing"].includes(r.status)).slice(0, 5) ?? [];

  return (
    <div className="guest-page">
      <VenueAnnouncement ctx={venue} />
      <header className="guest-header">
        <h1>{name}</h1>
        <p className="muted">Request a song</p>
      </header>

      <section className="np-card card" aria-label="Now playing">
        {np ? (
          <>
            <Art src={np.art} size={72} />
            <div className="np-text">
              <p className="eyebrow">{np.playing ? "Now playing" : "Paused"}</p>
              <p className="np-title">{np.title}</p>
              <p className="muted">
                {np.artist}
                {np.guestName && ` · for ${np.guestName}`}
              </p>
            </div>
          </>
        ) : (
          <p className="muted">Nothing is playing right now.</p>
        )}
      </section>

      {pub && !open && <p className="closed card">Requests are turned off right now.</p>}

      {open && pub?.canSearch && (
        <section className="search card">
          <form onSubmit={runSearch} className="search-row" role="search">
            <input type="search" placeholder="Song or artist" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" aria-label="Song or artist" maxLength={100} />
            <button className="primary" disabled={searching || !q.trim()}>
              {searching ? "…" : "Search"}
            </button>
          </form>
          <label className="name-row">
            <span className="muted small">Your name (optional, shown with your song)</span>
            <input value={guestName} onChange={(e) => setGuestName(e.target.value.slice(0, 24))} maxLength={24} autoComplete="nickname" />
          </label>
          {searchError && <p className="error">{searchError}</p>}
          {results?.length === 0 && <p className="muted">No songs found. Try different words.</p>}
          <ul className="results">
            {results?.map((t) => (
              <li key={t.sourceId}>
                <div className="track-row">
                  <Art src={t.art} />
                  <div className="track-text">
                    <p className="track-title">
                      {t.title}
                      {t.explicit && (
                        <span className="pill" title="Explicit">
                          E
                        </span>
                      )}
                    </p>
                    <p className="muted small">
                      {t.artist} · {duration(t.durationMs)}
                    </p>
                  </div>
                  <button className={sent[t.sourceId]?.ok ? "" : "primary"} disabled={busy === t.sourceId || sent[t.sourceId]?.ok} onClick={() => void requestSong(t)}>
                    {sent[t.sourceId]?.ok ? "Sent" : "Request"}
                  </button>
                </div>
                {sent[t.sourceId] && <p className={sent[t.sourceId]!.ok ? "ok small" : "error small"}>{sent[t.sourceId]!.text}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(waiting.length > 0 || done.length > 0) && (
        <section className="card">
          <h2>Your requests</h2>
          <ul className="mine">
            {[...waiting, ...done].map((r) => (
              <li key={r.id} className="track-row">
                <Art src={r.art} size={40} />
                <div className="track-text">
                  <p className="track-title">{r.title}</p>
                  <p className="muted small">{r.artist}</p>
                </div>
                <span className={`status status-${r.status}`}>
                  {STATUS_TEXT[r.status] ?? r.status}
                  {r.position && r.status !== "playing" ? ` · #${r.position}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pub && pub.upNext.length > 0 && (
        <section className="card">
          <h2>Up next</h2>
          <ol className="queue">
            {pub.upNext.slice(0, 10).map((i) => (
              <li key={i.id} className="track-row">
                <Art src={i.art} size={40} />
                <div className="track-text">
                  <p className="track-title">{i.title}</p>
                  <p className="muted small">
                    {i.artist}
                    {i.guestName && ` · for ${i.guestName}`}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {me && me.rulesText.length > 0 && (
        <footer className="rules muted small">
          <p>House rules: {me.rulesText.join(" ")}</p>
        </footer>
      )}
      <footer className="guest-footer">
        <BackToGames ctx={venue} />
      </footer>
    </div>
  );
}
