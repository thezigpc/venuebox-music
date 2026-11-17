import React from "react";
import ReactDOM from "react-dom/client";
import { basePath, ErrorBoundary, OnScreenKeyboard } from "@bargames/gamekit/client";
import { GuestPage } from "./pages/GuestPage";
import { TvPage } from "./pages/TvPage";
import { HostPage } from "./pages/HostPage";
import { AdminPage } from "./pages/AdminPage";
import { SpeakerPage } from "./pages/SpeakerPage";
import "./index.css";

// bargames.json routes: player "/", table "/tv", host "/host", admin "/admin". Plus
// "/speaker" (not a declared route) and "/admin/spotify/callback" (Spotify's redirect).
// Under path routing the page is at /music/tv: drop the prefix first.
const prefix = basePath();
const here = prefix && location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : location.pathname;
const path = here.replace(/\/+$/, "") || "/";
const Page = path === "/tv" ? TvPage : path === "/host" ? HostPage : path.startsWith("/admin") ? AdminPage : path === "/speaker" ? SpeakerPage : GuestPage;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary
      fallback={(_error, reload) => (
        <div className="center-page">
          <h1>Something broke</h1>
          <p className="muted">Reloading usually fixes it.</p>
          <button className="primary" onClick={reload}>
            Reload
          </button>
        </div>
      )}
    >
      <Page />
    </ErrorBoundary>
    {/* Kit 0.10: big keys on touch screens with no keyboard of their own (the box's touch
        screens); hidden on phones, tablets and PCs. */}
    <OnScreenKeyboard />
  </React.StrictMode>,
);
