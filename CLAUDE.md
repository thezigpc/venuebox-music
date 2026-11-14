# Venuebox Music Requests: project notes

An **app** for the Bar Games box ("Venuebox"): guests scan a QR code, search and request a
song; staff approve or skip (or requests go straight on, within rules); the songs play from
whichever **music source** the venue connects. The TVs show what's playing, what's next and
the QR code. Runs standalone too. Repo: https://github.com/thezigpc/venuebox-music, image
`ghcr.io/thezigpc/venuebox-music`.

## Design rules (decided)
- **The app owns requests, rules, the queue and the pages.** Each music service is a
  source connector behind `MusicSource` (`server/src/sources/types.ts`); `can` tells the
  pages what to hide.
- **The app owns the queue** because Spotify can't remove or reorder its own queue. Songs
  go to the source **one at a time**, `leadMs` before the current one ends (Spotify 15 s,
  files 10 s), or at once when nothing plays. Until then staff can reorder or remove them;
  after ("handed") they're locked. `server/src/player.ts` does this for every source.
- **Licensing is built in, not a note:** no Spotify credentials in the app (no operator
  fallback client, unlike the YouTube app). Each user makes their own Spotify developer app
  and pastes its client id; PKCE, no secret. The setup screen shows the personal-use notice
  and stores when it was confirmed (`spotify.consentAt`). Never call the app "licensed" or
  "approved". README has the Licensing section.
- **Speakers belong to the box.** Files play through `bg.audio` (SDK 0.13.1, box 0.15.0+)
  or the speaker page. Never pair Bluetooth, open sound devices, ask for host access, or use
  librespot or any unofficial Spotify player.
- **Don't play sound on the user's real TVs or speakers without asking them** (the box
  session's request; AirPlay/Bluetooth playback isn't proven on the real box yet).

## How a box song ends (0.1.1, SDK 0.13.1 `endReason`, box 0.15.4+)
`BoxOutput` passes `endReason` on its events; `FilesSource.onOutput` decides:
- `finished`: the next song starts. `error`: move on, and staff see a note for 2 min
  (`files.notice()`, host state `notice`).
- `stopped` / `replaced` / `disconnected`: **hold** (`MusicSource.hold()`). The player hands
  nothing over and puts a handed song back in the queue; staff see why (host `held`) and
  press "Carry on with the queue" (`player/resume` → `release()`), or for `replaced`, also
  "Take the speaker over".
- No `endReason` (older boxes, the speaker page): the 0.1.0 behaviour (ended → next;
  error → stop with the problem shown).
Our own skip/stop forgets the session first, so it never looks like a hold.

## Code map (0.1.0, built 2026-11-13)
- `shared/src/rules.ts`: `checkRequest()` (one pure function: closed, full, explicit,
  artist, word, length, repeat, pending, rate; plain-word messages), `cleanRules`,
  `describeRules`. `shared/src/links.ts`: redirect URI choice and `parseRedirect` (pasted
  address).
- `server/src/queue.ts`: `RequestQueue` (pending → queued → handed → playing → played /
  skipped / failed; rejected, removed). Request and play logs for the rate and repeat rules.
- `server/src/player.ts`: polls the source (`pollMs`), notices a handed song starting or the
  current one ending (incl. Spotify stopping *on* the last song), hands over the next,
  drops a handed song that never starts (90 s grace), skip = hand next first then skip,
  staff pause isn't mistaken for "queue ended". The source's own music (a Spotify
  playlist between requests) goes to history and counts for "no repeats".
- `server/src/sources/spotify.ts`: Web API, PKCE, scopes `user-read-playback-state` +
  `user-modify-playback-state` only (search needs none). play = `PUT /me/player/play`
  with `uris` when idle, else `POST /me/player/queue`. 429 → back off for Retry-After.
  `NO_ACTIVE_DEVICE`, Premium and an expired sign-in come back in plain words.
- `server/src/sources/files.ts`: `Library` (streamed upload into `/data/music`, tags and
  cover art via music-metadata, word-prefix search) and `FilesSource` (one current song +
  one "next" slot on an `Output`).
- `server/src/outputs/`: `BoxOutput` (`bg.audio.play` of `/box-audio/<file>`, served only
  to `bg.fromBox`; `watch` for ended/error; 409 → "take over" on the staff page, which
  passes `replace: true` once) and `SpeakerOutput` (socket.io namespace `/speaker`, staff
  only; newest page plays, older ones stand by; signed, expiring `/speaker-audio` links;
  15 s grace for a reload).
- `server/src/app.ts`: all routes. Guests: `/api/now`, `/api/me`, `/api/search`,
  `/api/request` (by `sourceId` the server has seen in a search; the browser never says
  how long or explicit a song is). Staff/admin under `/api/admin` (kit `adminRouter`, box
  staff trusted). Guest id = `music_guest` cookie (httpOnly, path = base path).
- Client pages: `GuestPage` (/), `TvPage` (/tv, `tableMode`, client-side QR), `HostPage`
  (/host), `AdminPage` (/admin, Spotify wizard, rules, library, history; also handles
  `/admin/spotify/callback`), `SpeakerPage` (/speaker).

## Data (DATA_DIR = /data)
`settings.json`, `rules.json`, `queue.json`, `history.json`, `library.json`, `music/`
(files + `art/`), `spotify.json` (0600: client id, tokens, consent time, device),
`admin.json` (kit). umask 077.

## Spotify facts (checked 2026-11-13)
- Feb 2026 dev-mode changes: owner needs Premium; 5 users per app; search `limit` max 10
  (default 5). Search, player state, devices, queue, next, pause/play and transfer still
  work. Batch `GET /tracks` was removed (single lookups weren't), so we don't use it.
- Redirect URIs: https, or loopback `http://127.0.0.1:<port>` (not `localhost`). The
  wizard picks `https://<host>/<base>/admin/spotify/callback`, the app's own address when
  opened at 127.0.0.1, else `http://127.0.0.1:8909/callback` + paste the error page's
  address.

## Platform
- `bargames.json`: id `music`, port 3009, `kind: app`, SDK 0.13.1 level 2 (events, no
  commands), routes player `/`, table `/tv`, host `/host`, admin `/admin`, `basePath`,
  `audio.play`, `network.internet`, 384m.
- Vendored: `vendor/bargames-sdk-0.13.1.tgz` (GameBroker/integration),
  `vendor/bargames-gamekit-0.7.3.tgz` (GameKit/dist-pack, or the kit's GitHub release).
  When changing them: update both package.json files and run `npm install` (lockfile).
- The TV prints the guest address under the QR with kit `JoinAddress` (left-aligned, width
  set by `.tv-qr`). Check long ones with `mock-box --public-url https://<long>/music`.
- **Mock box on this PC:** other sessions run mock boxes too (7080/7199 is often taken) and
  something kills `node server/dist/index.js` started by a relative path. Use
  `--port 7381 --core-port 7399` (and `MSYS_NO_PATHCONV=1` in Git Bash for `--base`), set
  `BG_BASE_PATH=/music`, and start the app with the absolute path.
  `server/test/tools/mock-box-endreason.ts` drives finished → stopped → carry on.
- Don't edit `C:\CodeProjects\GameBroker` or other modules; platform needs go to the
  GameBroker session (ListAgents, name starts with "GameBroker") as "SDK requests".

## Conventions
npm workspaces (`shared`, `server`, `client`), TypeScript, Express 4, React 18 + Vite 5,
socket.io 4, Node 22, `node:test` via tsx (`npm test`). Commit when it makes sense; push
and publish when the user or the box session asks. Never put tokens, client ids or account
names in the repo.

## Box status (2026-11-13)
- 0.1.0 installed on the dev box (box 0.15.2): healthy at /music/, no source chosen yet,
  nothing played on real speakers or TVs.
- The box forwards an app's room-less events to integrations (Home Assistant) like a
  game's. SDK 0.13.1's `validate` no longer warns about it.
- 0.1.1 (SDK 0.13.1, kit 0.7.3, `endReason`) published and installed on the dev box
  2026-11-14. The box is still 0.15.3 (no `endReason` yet; the state fallback runs) until
  the user approves 0.15.4. Queued for the next SDK/kit patch: `AudioEndReason` exported
  from `/server`, mock-box controls to end a session as replaced/disconnected/error, the
  `mock-box --help` bug, a `JoinAddress` align prop (then drop our style override).

## Not yet verified against the real thing
- Real Spotify (the user's account and developer app): the wizard, PKCE sign-in, devices,
  and the handover timing on a real player. Only tested against a fake Spotify.
- The real box's audio and its `endReason` (box 0.15.4): tested with unit fakes and
  `bargames mock-box` (finished, stopped).
- The speaker page in a real browser playing real audio (the socket protocol is tested).
- The Docker image (no Docker on the dev PC; the GitHub Actions publish builds it).
