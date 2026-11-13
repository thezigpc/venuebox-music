// "/admin": the music source and its setup wizard, the request rules, the library (files
// source), what played, and the app's name. Also answers Spotify's redirect
// (/admin/spotify/callback) when the app has an https (or 127.0.0.1) address.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { basePath, BoxAdminLink, VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl } from "@bargames/sdk/client";
import { redirectUriFor, type AdminState, type LibraryTrack, type Rules, type SpotifyDevice } from "@music/shared";
import { api, duration } from "../api";
import { Art, Notice, StaffGate, useAct } from "../components/StaffGate";
import { useVenue } from "../useVenue";

type Tab = "source" | "rules" | "history" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "source", label: "Music source" },
  { id: "rules", label: "Rules" },
  { id: "history", label: "History" },
  { id: "settings", label: "Settings" },
];
type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
interface PanelProps {
  state: AdminState;
  act: Act;
}

const NOTICE =
  "Spotify's terms allow personal, non-commercial use. You're responsible for how you use your Spotify account and developer app. In a business, use a music service licensed for businesses.";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="copy">
      <code>{text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className={`step${done ? " is-done" : ""}`}>
      <h3>
        <span className="step-n">{done ? "✓" : n}</span> {title}
      </h3>
      <div className="step-body">{children}</div>
    </li>
  );
}

// ------------------------------------------------------------------ Spotify wizard

function SpotifySetup({ state, act }: PanelProps) {
  const sp = state.spotify;
  const [clientId, setClientId] = useState("");
  const [pasted, setPasted] = useState("");
  const [devices, setDevices] = useState<SpotifyDevice[] | null>(null);
  // The address this admin is open at decides the redirect (https, 127.0.0.1, or paste).
  const r = redirectUriFor(location.origin, basePath());

  const loadDevices = useCallback(() => act(async () => setDevices((await api.spotifyDevices()).devices)), [act]);
  useEffect(() => {
    if (sp.connected && devices === null) void loadDevices();
  }, [sp.connected, devices, loadDevices]);

  const signIn = async () => {
    await act(async () => {
      const { url } = await api.spotifyLogin(r.uri);
      if (r.paste) window.open(url, "_blank", "noopener");
      else location.href = url;
    });
  };

  return (
    <ol className="wizard">
      <Step n={1} title="Personal use only" done={!!sp.consentAt}>
        <p className="notice-text">{NOTICE}</p>
        {sp.consentAt ? (
          <p className="muted small">Confirmed {new Date(sp.consentAt).toLocaleString()}.</p>
        ) : (
          <button className="primary" onClick={() => void act(() => api.spotifyConsent())}>
            I understand
          </button>
        )}
      </Step>

      <Step n={2} title="Create your own Spotify app" done={sp.clientIdSet}>
        <p>This app comes with no Spotify credentials: you use your own developer app (free; the account needs Spotify Premium).</p>
        <ol className="how">
          <li>
            Open{" "}
            <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
              developer.spotify.com/dashboard
            </a>{" "}
            and sign in with the Spotify account that will play the music.
          </li>
          <li>Press <b>Create app</b>. Any name and description will do.</li>
          <li>
            Under <b>Redirect URIs</b>, add exactly: <Copy text={r.uri} />
          </li>
          <li>Under <b>Which API/SDKs are you planning to use?</b>, tick <b>Web API</b>. Agree to the terms and save.</li>
          <li>If you'll sign in here with a different Spotify account than the one that owns the app, add it under the app's <b>User Management</b>.</li>
        </ol>
        {r.paste && (
          <p className="muted small">
            This admin isn't open on an https address, so Spotify will send you back to {r.uri}, which shows an error page. That's expected: you'll copy that page's address in step 4.
          </p>
        )}
      </Step>

      <Step n={3} title="Paste the client id" done={sp.clientIdSet}>
        <p className="muted small">On your app's page, under Basic Information. There's no client secret to copy: this app signs in with PKCE.</p>
        {sp.clientIdSet && <p className="small">A client id is saved (ends in …{sp.clientIdHint}).</p>}
        <div className="search-row">
          <input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="32 letters and numbers" disabled={!sp.consentAt} spellCheck={false} autoComplete="off" />
          <button className="primary" disabled={!sp.consentAt || !clientId} onClick={() => void act(() => api.spotifyClient(clientId), "Client id saved.").then((ok) => ok && setClientId(""))}>
            Save
          </button>
        </div>
      </Step>

      <Step n={4} title="Sign in with Spotify" done={sp.connected}>
        {sp.connected ? (
          <p>
            Signed in{sp.account ? ` as ${sp.account}` : ""}.{" "}
            <button className="link" onClick={() => void act(() => api.spotifySignOut(), "Signed out of Spotify.")}>
              Sign out
            </button>
          </p>
        ) : (
          <>
            {sp.problem && <p className="error">{sp.problem}</p>}
            <button className="primary" disabled={!sp.clientIdSet} onClick={() => void signIn()}>
              Sign in with Spotify
            </button>
            {r.paste && sp.pending && (
              <div className="paste">
                <p className="small">After you press Agree, the new tab shows an error page. Copy its whole address from the address bar and paste it here:</p>
                <div className="search-row">
                  <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={`${r.uri}?code=…`} spellCheck={false} autoComplete="off" />
                  <button className="primary" disabled={!pasted.trim()} onClick={() => void act(() => api.spotifyCallback({ url: pasted }), "Signed in to Spotify.").then((ok) => ok && setPasted(""))}>
                    Finish
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Step>

      <Step n={5} title="Pick the device that plays" done={!!sp.deviceId}>
        <p className="muted small">The music plays in Spotify on your own device: a phone, a PC or a speaker wired to the sound system. Open Spotify there first and play anything once, so it shows up.</p>
        {sp.deviceName && <p>Plays on {sp.deviceName}.</p>}
        {sp.connected && (
          <>
            <ul className="list">
              {devices?.length === 0 && <li className="muted">No devices. Open Spotify on the device, play a song, then refresh.</li>}
              {devices?.map((d) => (
                <li key={d.id} className="track-row">
                  <div className="track-text">
                    <p className="track-title">{d.name}</p>
                    <p className="muted small">
                      {d.type}
                      {d.active ? " · active" : ""}
                      {d.restricted ? " · can't be controlled" : ""}
                    </p>
                  </div>
                  <button className={d.id === sp.deviceId ? "" : "primary"} disabled={d.id === sp.deviceId || d.restricted} onClick={() => void act(() => api.spotifyDevice({ id: d.id, name: d.name }), `Plays on ${d.name}.`)}>
                    {d.id === sp.deviceId ? "Chosen" : "Use this"}
                  </button>
                </li>
              ))}
            </ul>
            <button onClick={() => void loadDevices()}>Refresh</button>
          </>
        )}
      </Step>
    </ol>
  );
}

// ------------------------------------------------------------------ library

function TrackRow({ t, act }: { t: LibraryTrack; act: Act }) {
  const [title, setTitle] = useState(t.title);
  const [artist, setArtist] = useState(t.artist);
  useEffect(() => (setTitle(t.title), setArtist(t.artist)), [t.title, t.artist]);
  return (
    <li className="track-row lib-row">
      <Art src={t.hasArt ? `art/${t.id}` : undefined} size={40} />
      <div className="track-text lib-edit">
        <input value={title} aria-label="Title" onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== t.title && void act(() => api.updateTrack(t.id, { title }))} />
        <input value={artist} aria-label="Artist" onChange={(e) => setArtist(e.target.value)} onBlur={() => artist !== t.artist && void act(() => api.updateTrack(t.id, { artist }))} />
      </div>
      <span className="muted small">{duration(t.durationMs)}</span>
      <label className="small" title="Explicit songs are blocked when the rule is on">
        <input type="checkbox" checked={t.explicit} onChange={(e) => void act(() => api.updateTrack(t.id, { explicit: e.target.checked }))} /> Explicit
      </label>
      <button className="danger" aria-label="Delete" onClick={() => confirm(`Delete "${t.title}"?`) && void act(() => api.deleteTrack(t.id))}>
        ✕
      </button>
    </li>
  );
}

function Library({ state, act }: PanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState("");
  const [filter, setFilter] = useState("");
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files];
    const failed: string[] = [];
    for (let i = 0; i < list.length; i++) {
      setProgress(`Uploading ${i + 1} of ${list.length}: ${list[i]!.name}`);
      const ok = await act(() => api.upload(list[i]!));
      if (!ok) failed.push(list[i]!.name);
    }
    setProgress(failed.length ? `Done. These didn't upload: ${failed.join(", ")}` : `Uploaded ${list.length} song${list.length === 1 ? "" : "s"}.`);
    if (input.current) input.current.value = "";
  };
  const f = filter.toLowerCase();
  const tracks = state.library.tracks.filter((t) => !f || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(f));
  return (
    <section className="card">
      <h2>
        Library <span className="count">{state.library.tracks.length}</span> <span className="muted small">{(state.library.bytes / 1e6).toFixed(0)} MB</span>
      </h2>
      <p className="muted small">MP3 or M4A files. Titles, artists, albums and cover art are read from the files' tags; fix them here if they're wrong.</p>
      <input ref={input} type="file" multiple accept=".mp3,.m4a,audio/mpeg,audio/mp4,audio/x-m4a" onChange={(e) => void upload(e.target.files)} />
      {progress && <p className="small">{progress}</p>}
      {state.library.tracks.length > 8 && <input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <ul className="list">
        {tracks.map((t) => (
          <TrackRow key={t.id} t={t} act={act} />
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ panels

function SourcePanel(p: PanelProps) {
  const { state, act } = p;
  const src = state.settings.source;
  return (
    <>
      <section className="card">
        <h2>Where the music comes from</h2>
        <div className="choices">
          <label className={`choice${src === "spotify" ? " is-on" : ""}`}>
            <input type="radio" name="src" checked={src === "spotify"} onChange={() => void act(() => api.settings({ source: "spotify" }))} />
            <b>Spotify</b>
            <span className="muted small">For home and personal use. Plays on your own Spotify device. Needs Premium and your own free developer app.</span>
          </label>
          <label className={`choice${src === "files" ? " is-on" : ""}`}>
            <input type="radio" name="src" checked={src === "files"} onChange={() => void act(() => api.settings({ source: "files" }))} />
            <b>Music files</b>
            <span className="muted small">Songs you upload. Plays on {state.onBox ? "the box's speakers (or a speaker page)" : "the speaker page, a browser wired to the sound system"}.</span>
          </label>
        </div>
        <p className={`status-line state-${state.sourceStatus.state}`}>{state.sourceStatus.message}</p>
        <p className="muted small">Playing music in public needs the right licences (in the US: ASCAP, BMI, SESAC). That's the venue's responsibility.</p>
      </section>
      {src === "spotify" && (
        <section className="card">
          <h2>Spotify setup</h2>
          <SpotifySetup {...p} />
        </section>
      )}
      {src === "files" && (
        <>
          <section className="card">
            <h2>Speaker</h2>
            <select value={state.settings.output} onChange={(e) => void act(() => api.settings({ output: e.target.value }), "Speaker changed.")}>
              {state.outputs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.busy ? " (in use)" : ""}
                  {!o.available ? " (not available)" : ""}
                </option>
              ))}
            </select>
            <p className="muted small">
              {state.onBox ? "The box's speakers are set up under the box's Settings → Connected devices. " : ""}
              The{" "}
              <a href={bgUrl("/speaker")} target="_blank" rel="noreferrer">
                speaker page
              </a>{" "}
              plays in any browser: open it on the PC or tablet wired to the sound system and leave it open.
            </p>
          </section>
          <Library {...p} />
        </>
      )}
    </>
  );
}

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function RulesPanel({ state, act }: PanelProps) {
  const [r, setR] = useState<Rules>(state.rules);
  const [artists, setArtists] = useState(state.rules.blockedArtists.join("\n"));
  const [words, setWords] = useState(state.rules.blockedWords.join("\n"));
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => setR((x) => ({ ...x, [k]: v }));
  const save = () => act(() => api.rules({ ...r, blockedArtists: artists.split("\n") as never, blockedWords: words.split("\n") as never }), "Rules saved.");
  const n = (k: "perGuestCount" | "perGuestMinutes" | "maxPendingPerGuest" | "noRepeatMinutes" | "maxSongMinutes" | "maxQueue") => (
    <input type="number" min={0} className="num" value={r[k]} onChange={(e) => set(k, num(e.target.value))} />
  );
  return (
    <section className="card rules-form">
      <h2>Request rules</h2>
      <p className="muted small">0 turns a number rule off. Guests see which rule stopped a request, in plain words.</p>
      <label className="row">
        <input type="checkbox" checked={r.requestsOpen} onChange={(e) => set("requestsOpen", e.target.checked)} /> Requests are on
      </label>
      <fieldset>
        <legend>Approval</legend>
        <label className="row">
          <input type="radio" checked={r.approval === "staff"} onChange={() => set("approval", "staff")} /> Staff approve each request
        </label>
        <label className="row">
          <input type="radio" checked={r.approval === "auto"} onChange={() => set("approval", "auto")} /> Requests go straight on (within the rules)
        </label>
      </fieldset>
      <p className="row">Each guest can request {n("perGuestCount")} songs every {n("perGuestMinutes")} minutes.</p>
      <p className="row">Each guest can have {n("maxPendingPerGuest")} songs waiting at once.</p>
      <p className="row">No repeats within {n("noRepeatMinutes")} minutes.</p>
      <p className="row">Longest song: {n("maxSongMinutes")} minutes.</p>
      <p className="row">Most songs waiting in total: {n("maxQueue")}.</p>
      <label className="row">
        <input type="checkbox" checked={r.blockExplicit} onChange={(e) => set("blockExplicit", e.target.checked)} /> Block explicit songs
      </label>
      <div className="two">
        <label>
          Blocked artists (one per line)
          <textarea rows={5} value={artists} onChange={(e) => setArtists(e.target.value)} />
        </label>
        <label>
          Blocked words (one per line; in titles, artists, albums and guest names)
          <textarea rows={5} value={words} onChange={(e) => setWords(e.target.value)} />
        </label>
      </div>
      <button className="primary" onClick={() => void save()}>
        Save rules
      </button>
    </section>
  );
}

function HistoryPanel({ state, act }: PanelProps) {
  return (
    <section className="card">
      <h2>What played</h2>
      {state.history.length === 0 && <p className="muted">Nothing yet.</p>}
      <table className="history">
        <tbody>
          {state.history.map((h, i) => (
            <tr key={i}>
              <td className="muted small">{new Date(h.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
              <td>
                <b>{h.title}</b> <span className="muted">· {h.artist}</span>
              </td>
              <td className="muted small">{h.requested ? `requested${h.guestName ? ` by ${h.guestName}` : ""}` : h.source === "spotify" ? "Spotify's own" : "staff"}</td>
              <td className="muted small">{h.outcome === "skipped" ? "skipped" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {state.history.length > 0 && (
        <button className="link danger" onClick={() => confirm("Clear the history?") && void act(() => api.clearHistory())}>
          Clear history
        </button>
      )}
    </section>
  );
}

function SettingsPanel({ state, act }: PanelProps) {
  const [name, setName] = useState(state.settings.name);
  return (
    <section className="card">
      <h2>Settings</h2>
      <label>
        Name shown to guests {state.onBox && <span className="muted small">(on a box, the venue's name for the app wins)</span>}
        <div className="search-row">
          <input value={name} maxLength={40} placeholder="Music Requests" onChange={(e) => setName(e.target.value)} />
          <button className="primary" onClick={() => void act(() => api.settings({ name }), "Saved.")}>
            Save
          </button>
        </div>
      </label>
      <p className="muted small">
        Pages: <a href={bgUrl("/")}>guests</a> · <a href={bgUrl("/tv")}>TV</a> · <a href={bgUrl("/host")}>staff</a> · <a href={bgUrl("/speaker")}>speaker</a>
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ page

const tabFromHash = (): Tab => {
  const h = location.hash.slice(1);
  return TABS.some((t) => t.id === h) ? (h as Tab) : "source";
};

function Admin({ signOut, recheck }: { signOut: () => void; recheck: () => void }) {
  const [state, setState] = useState<AdminState | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const reload = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (err) {
      if ((err as { status?: number }).status === 401) recheck();
    }
  }, [recheck]);
  const { act, notice, setNotice } = useAct(reload, recheck);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };

  // Spotify sent the browser back here with a code.
  const handled = useRef(false);
  useEffect(() => {
    const prefix = basePath();
    const here = prefix && location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : location.pathname;
    if (handled.current || !here.startsWith("/admin/spotify/callback")) return;
    handled.current = true;
    const p = new URLSearchParams(location.search);
    history.replaceState(null, "", bgUrl("/admin#source"));
    const code = p.get("code");
    const st = p.get("state");
    void act(() => (code && st ? api.spotifyCallback({ code, state: st }) : api.spotifyCallback({ url: `?${p}` })), "Signed in to Spotify.");
  }, [act]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => !document.hidden && void reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <>
      <header className="ad-header">
        <h1>Music admin</h1>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab is-on" : "tab"} onClick={() => go(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ad-header-links">
          <a href={bgUrl("/host")}>Staff page</a>
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      {!state ? (
        <p className="muted center-page">Loading…</p>
      ) : (
        <main className="ad-main">
          {tab === "source" && <SourcePanel state={state} act={act} />}
          {tab === "rules" && <RulesPanel key={JSON.stringify(state.rules)} state={state} act={act} />}
          {tab === "history" && <HistoryPanel state={state} act={act} />}
          {tab === "settings" && <SettingsPanel state={state} act={act} />}
        </main>
      )}
    </>
  );
}

export function AdminPage() {
  const venue = useVenue();
  useEffect(() => void (document.title = "Music · admin"), []);
  return (
    <div className="ad-page">
      <VenueAnnouncement ctx={venue} />
      <BoxAdminLink ctx={venue} />
      <StaffGate title="Music · admin">{(signOut, recheck) => <Admin signOut={signOut} recheck={recheck} />}</StaffGate>
    </div>
  );
}
