// "/tv": the venue TVs. Big album art, title and artist, the next 3 songs, and "Scan to
// request" with a QR code to the guest page. Built for 1920x1080 seen across a bar: no
// pointer, no buttons, recovers on its own from a restart or a network blip.

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { basePath, JoinAddress } from "@bargames/gamekit/client";
import { activeAnnouncement, tableMode } from "@bargames/sdk/client";
import type { PublicState } from "@music/shared";
import { api } from "../api";
import { useVenue } from "../useVenue";

export function TvPage() {
  const venue = useVenue();
  const [pub, setPub] = useState<PublicState | null>(null);
  const [offline, setOffline] = useState(false);
  const [qr, setQr] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    const tm = tableMode(venue);
    return () => tm.stop();
  }, [venue]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        setPub(await api.now());
        setOffline(false);
      } catch {
        setOffline(true);
      }
      if (!stop) timer = setTimeout(load, 3000);
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  // The progress bar moves once a second between polls.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const guestUrl = useMemo(() => pub?.guestUrl || `${location.origin}${basePath()}/`, [pub?.guestUrl]);
  useEffect(() => {
    QRCode.toString(guestUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setQr(""));
  }, [guestUrl]);

  const np = pub?.nowPlaying;
  const progress = np ? Math.min(np.durationMs, np.progressMs + (np.playing ? Date.now() - np.at : 0)) : 0;
  const news = activeAnnouncement(venue);

  return (
    <div className="tv-page">
      {news && <div className="tv-news">{news.text}</div>}
      <main className="tv-main">
        <section className="tv-now">
          {np?.art ? <img className="tv-art" src={np.art} alt="" referrerPolicy="no-referrer" /> : <div className="tv-art tv-art-none">♪</div>}
          <div className="tv-now-text">
            {np ? (
              <>
                <p className="tv-eyebrow">{np.playing ? "Now playing" : "Paused"}</p>
                <h1 className="tv-title">{np.title}</h1>
                <p className="tv-artist">{np.artist}</p>
                {np.guestName && <p className="tv-for">Requested by {np.guestName}</p>}
                {np.durationMs > 0 && (
                  <div className="tv-progress" aria-hidden>
                    <div style={{ width: `${(100 * progress) / np.durationMs}%` }} />
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="tv-eyebrow">{pub?.name ?? ""}</p>
                <h1 className="tv-title">Pick the next song</h1>
                <p className="tv-artist tv-wrap">Scan the code to request one.</p>
              </>
            )}
          </div>
        </section>
        <aside className="tv-side">
          <div className="tv-next">
            <h2>Up next</h2>
            {pub && pub.upNext.length === 0 && <p className="tv-muted">Nothing yet. Be first!</p>}
            <ol>
              {pub?.upNext.slice(0, 3).map((i) => (
                <li key={i.id}>
                  {i.art ? <img src={i.art} alt="" referrerPolicy="no-referrer" /> : <div className="tv-mini-none">♪</div>}
                  <div>
                    <p className="tv-next-title">{i.title}</p>
                    <p className="tv-muted">{i.artist}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          {pub?.requestsOpen ? (
            <div className="tv-qr">
              {qr && <div className="tv-qr-code" dangerouslySetInnerHTML={{ __html: qr }} />}
              <div className="tv-qr-text">
                <p>Scan to request</p>
                <JoinAddress url={guestUrl} label="or go to" className="tv-join" style={{ alignItems: "flex-start", textAlign: "left" }} />
              </div>
            </div>
          ) : (
            pub && <p className="tv-muted tv-closed">Requests are off right now.</p>
          )}
        </aside>
      </main>
      {offline && <div className="tv-offline">Reconnecting…</div>}
    </div>
  );
}
