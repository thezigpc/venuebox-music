// Staff sign-in for /host, /admin and /speaker. On a box, staff signed in to the box admin go
// straight in (staffSignIn); the box's admin password also works here.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { basePath, staffSignIn } from "@bargames/gamekit/client";
import { api, ApiError, getToken, setToken, type AuthStatus } from "../api";

type Phase = { kind: "loading" } | { kind: "auth"; status: AuthStatus } | { kind: "ready" } | { kind: "offline"; message: string };

function AuthForm({ title, status, onDone }: { title: string; status: AuthStatus; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wantSetup, setWantSetup] = useState(false);
  const setup = status.venueLogin ? wantSetup && status.setupAllowed : status.setupNeeded;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      const r = setup ? await api.setup(password) : await api.login(password);
      setToken(r.token);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && status.venueLogin) setError("That isn't the venue box's admin password.");
      else setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  if (status.broken && !status.venueLogin) {
    return (
      <div className="auth card">
        <h1>{title}</h1>
        <p className="error">The admin password file on the server is damaged. Ask whoever runs the server to fix or delete admin.json in the data folder.</p>
      </div>
    );
  }
  return (
    <form className="auth card" onSubmit={submit}>
      <h1>{title}</h1>
      <p className="muted">
        {setup
          ? status.venueLogin
            ? `Choose a separate password for this app (the box's admin password keeps working too). At least ${status.minPasswordLength} characters.`
            : `Choose the staff password. Whoever sets it first becomes the admin, so do this now. At least ${status.minPasswordLength} characters.`
          : status.venueLogin
            ? `Sign in with the venue box's admin password${status.configured ? " (or this app's own password)" : ""}.`
            : "Staff sign-in."}
      </p>
      <label>
        Password
        <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
      </label>
      {setup && (
        <label>
          Password again
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !password}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {status.venueLogin && status.setupAllowed && (
        <button type="button" className="link" onClick={() => (setWantSetup((v) => !v), setError(""))}>
          {wantSetup ? "Sign in with the box's password instead" : "Set a separate password for this app"}
        </button>
      )}
    </form>
  );
}

/** Renders `children(signOut, recheck)` once signed in. */
export function StaffGate({ title, children }: { title: string; children: (signOut: () => void, recheck: () => void) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const check = useCallback(async () => {
    try {
      const status = await api.status();
      if (status.authenticated && getToken()) return setPhase({ kind: "ready" });
      const staffToken = await staffSignIn(basePath());
      if (staffToken) {
        setToken(staffToken);
        return setPhase({ kind: "ready" });
      }
      setToken("");
      setPhase({ kind: "auth", status });
    } catch (err) {
      setPhase({ kind: "offline", message: err instanceof Error ? err.message : "Can't reach the server." });
    }
  }, []);

  useEffect(() => void check(), [check]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setToken("");
    void check();
  }, [check]);

  if (phase.kind === "loading") return <p className="muted center-page">Loading…</p>;
  if (phase.kind === "offline")
    return (
      <div className="auth card">
        <h1>{title}</h1>
        <p className="error">{phase.message}</p>
        <button onClick={() => void check()}>Try again</button>
      </div>
    );
  if (phase.kind === "auth") return <AuthForm title={title} status={phase.status} onDone={() => void check()} />;
  return <>{children(() => void signOut(), () => void check())}</>;
}

/** Runs an action and reports its error in a notice; 401 sends the page back to sign-in. */
export function useAct(reload: () => Promise<void>, recheck: () => void) {
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);
  const act = useCallback(
    async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
      try {
        await fn();
        if (ok) setNotice({ text: ok, error: false });
        await reload();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          recheck();
          return false;
        }
        setNotice({ text: err instanceof Error ? err.message : "That didn't work.", error: true });
        await reload();
        return false;
      }
    },
    [reload, recheck],
  );
  return { act, notice, setNotice };
}

export function Notice({ notice, onClose }: { notice: { text: string; error: boolean } | null; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div className={`notice${notice.error ? " is-error" : ""}`} role="status">
      <span>{notice.text}</span>
      <button className="link" onClick={onClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function Art({ src, size = 56 }: { src?: string; size?: number }) {
  return src ? (
    <img className="art" src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <div className="art art-none" style={{ width: size, height: size }} aria-hidden>
      ♪
    </div>
  );
}
