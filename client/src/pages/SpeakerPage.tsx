// "/speaker": open in a browser on a PC or tablet wired to the sound system. It plays what
// the app sends over the socket and reports its progress back. Staff only. One tap starts
// it (browsers only play sound after a tap), then it runs on its own.

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { socketPath } from "@bargames/gamekit/client";
import { bgUrl } from "@bargames/sdk/client";
import { getToken } from "../api";
import { StaffGate } from "../components/StaffGate";

interface Load {
  trackId: string;
  url: string;
  title: string;
  artist: string;
  art?: string;
  startAtMs: number;
  playing: boolean;
}

function Speaker() {
  const audio = useRef<HTMLAudioElement>(null);
  const sock = useRef<Socket | null>(null);
  const current = useRef<Load | null>(null);
  const [started, setStarted] = useState(false);
  const [conn, setConn] = useState<"connecting" | "on" | "off" | "standby">("connecting");
  const [err, setErr] = useState("");
  const [song, setSong] = useState<Load | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(() => {
    try {
      return Number(localStorage.getItem("music.speakerVolume") ?? "1") || 1;
    } catch {
      return 1;
    }
  });

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
    try {
      localStorage.setItem("music.speakerVolume", String(volume));
    } catch {
      /* fine */
    }
  }, [volume]);

  useEffect(() => {
    if (!started) return;
    const a = audio.current!;
    const s = io(`${location.origin}/speaker`, { path: socketPath(), auth: { token: getToken() }, transports: ["websocket", "polling"] });
    sock.current = s;
    const report = () => {
      const c = current.current;
      if (c && s.connected) s.emit("state", { trackId: c.trackId, positionMs: Math.round(a.currentTime * 1000), playing: !a.paused });
    };
    s.on("connect", () => (setConn("on"), setErr("")));
    s.on("disconnect", () => setConn("off"));
    s.on("connect_error", (e) => (setConn("off"), setErr(e.message)));
    s.on("standby", () => {
      setConn("standby");
      a.pause();
      current.current = null;
      setSong(null);
      s.disconnect();
    });
    s.on("load", (m: Load) => {
      current.current = m;
      setSong(m);
      a.src = bgUrl(m.url);
      a.currentTime = m.startAtMs / 1000;
      if (m.playing) void a.play().catch((e: Error) => s.emit("failed", { trackId: m.trackId, message: e.message }));
    });
    s.on("pause", () => a.pause());
    s.on("resume", () => void a.play().catch(() => undefined));
    s.on("stop", () => {
      a.pause();
      a.removeAttribute("src");
      a.load();
      current.current = null;
      setSong(null);
    });
    const onEnded = () => {
      const c = current.current;
      current.current = null;
      setSong(null);
      if (c) s.emit("ended", { trackId: c.trackId });
    };
    const onError = () => {
      const c = current.current;
      if (!c) return;
      current.current = null;
      s.emit("failed", { trackId: c.trackId, message: a.error?.message || "the browser couldn't play the file" });
    };
    const onPlay = () => (setPlaying(true), report());
    const onPause = () => (setPlaying(false), report());
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    const t = setInterval(report, 2000);

    // Keep the screen (and so the tab) awake where the browser allows it.
    let lock: { release: () => Promise<void> } | null = null;
    const wake = () => {
      const wl = (navigator as unknown as { wakeLock?: { request: (k: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      void wl?.request("screen").then((l) => (lock = l)).catch(() => undefined);
    };
    wake();
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", wake);
      void lock?.release().catch(() => undefined);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      s.close();
    };
  }, [started]);

  return (
    <div className="speaker-page">
      <audio ref={audio} preload="auto" />
      {!started ? (
        <div className="card speaker-start">
          <h1>Speaker</h1>
          <p>Use this on the computer or tablet wired to the sound system. Leave this page open: the music plays here.</p>
          <button className="primary big" onClick={() => setStarted(true)}>
            Start the speaker
          </button>
        </div>
      ) : (
        <div className="card speaker-on">
          <p className={`status-line state-${conn === "on" ? "ok" : "warn"}`}>
            {conn === "on" ? "Connected. Waiting for songs from the queue." : conn === "standby" ? "Another speaker page took over. Reload to use this one again." : conn === "off" ? `Reconnecting…${err ? ` (${err})` : ""}` : "Connecting…"}
          </p>
          {song ? (
            <div className="speaker-song">
              {song.art ? <img src={song.art} alt="" /> : <div className="art art-none">♪</div>}
              <div>
                <p className="eyebrow">{playing ? "Playing" : "Paused"}</p>
                <p className="np-title">{song.title}</p>
                <p className="muted">{song.artist}</p>
              </div>
            </div>
          ) : (
            <p className="muted">Nothing playing.</p>
          )}
          <label className="volume">
            Volume here
            <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
          <p className="muted small">Skip and pause from the staff page.</p>
        </div>
      )}
    </div>
  );
}

export function SpeakerPage() {
  useEffect(() => void (document.title = "Music · speaker"), []);
  return <StaffGate title="Music · speaker">{() => <Speaker />}</StaffGate>;
}
