# Bar Games integration: Music Requests (app)

**Level 2, `kind: "app"`, SDK 0.13.1, game kit 0.7.3.** No rooms or commands; `x-music-*`
events; plays files on the box's speakers (`audio.play`).

## Manifest
`bargames.json`: id `music`, port 3009, routes player `/` (guests), table `/tv` (now
playing, up next, QR), host `/host` (staff queue), admin `/admin` (setup),
`routing.basePath`, `audio: { play: true }`, `network.internet: true` (Spotify's Web API),
brandable `displayName` and `accent`, 384m.

`npx bargames validate .` passes with one expected warning: the image isn't pinned by
digest. The events carry no room; the mock box accepts and prints them (see below).

## Events
| Event | Data |
|---|---|
| `x-music-requested` | `title`, `artist`, `guestName`, `needsApproval` |
| `x-music-approved` | `title`, `artist`, `guestName` |
| `x-music-rejected` | `title`, `artist` |
| `x-music-now-playing` | `title`, `artist`, `guestName`, `requested` (false: the source's own music) |
| `x-music-skipped` | `title`, `artist` |
| `x-music-requests-open` / `x-music-requests-closed` | none |

## `npx bargames check` (SDK 0.13.1 mock box, `--base /music`)
```
music@0.1.1 · level 2 · http://127.0.0.1:3009
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Music Requests (mock)")
✓ /__bargames/theme.css served
✓ phone page (routes.player) / → 200
✓ TV view (routes.table) /tv → 200
all checks passed
```

## Audio through the mock box (2026-11-13)
`server/test/tools/mock-box-drive.ts` against `npx bargames mock-box . --base /music`:
upload two generated MP3s, request both as a guest (automatic approval). The mock box
fetched `/box-audio/<file>` with its token, "played" each on the box jack, `watch` saw
`ended`, and the second song followed; history and the guest's "your requests" show both
as played. Events printed: `x-music-requested` ×2, `x-music-now-playing` ×2. The admin and
staff pages list the mock's outputs (jack, Bluetooth, AirPlay TV) by the venue's names.
Staff sign-in through the gateway (`/__bargames/staff?next=/host`) opens /host and /admin
without a password.

## endReason through the mock box (SDK 0.13.1, 2026-11-14)
`server/test/tools/mock-box-endreason.ts` (mock box on `--port 7381 --core-port 7399`):
three 4 s songs. Song 1 ended `finished` and song 2 followed; song 2 stopped through the
box's API (`stopped`): nothing started, song 3 waited in the queue and staff saw "The music
was stopped on The box's default speaker (Stopped). The queue is waiting until you carry
on."; "Carry on" started song 3. `replaced`, `disconnected` and `error` are covered by unit
tests (`server/test/files.test.ts`).

With `--public-url https://requests.the-longest-bar-name-in-town.example.net/music` the TV
prints the address under the QR (kit `JoinAddress`), wrapped at "." and "/" inside the QR
box at 1920x1080 and 1280x720.

## Server
- `createBarGames({ gameId: "music" })`, middleware before `/api` and the SPA; status
  `{ rooms: [] }`.
- Name: the venue's name for the app on a box, else the admin's setting, `GAME_NAME`,
  "Music Requests".
- Staff sign-in: `adminRouter({ trusted: bg.isStaff })`, `createAdminAuth({ venuePassword:
  bg.checkVenuePassword, onBox: bg.connected })`, `staffSignIn()` on /host, /admin and
  /speaker. The speaker socket accepts an admin session token or `bg.isStaff`.
- Audio: `/box-audio/*` only for `bg.fromBox(req)` (`express.static`, so Range works);
  `bg.audio.play({ path, output?, title, artist, album, durationMs, replace? })`; `watch`
  for ended/error and its `endReason` (see CLAUDE.md "How a box song ends"); staff pick the output (default: the venue's); `replace: true` only when
  staff press "Take the speaker over"; volume only while playing there.
- QR code and the address under it: `bg.publicUrl("/")` on a box; `PUBLIC_URL` standalone; else the TV page uses
  its own address.

## Path routing
Vite `base: "./"`, `serveSpa` injects the base, every fetch through `bgUrl()`, socket.io
with `socketPath()`, the guest cookie's path is the base path, local storage keys
`music.*`. Checked under `--base /music` with the mock gateway; tests run at the root.

## Container
Writes only under `/data`. Multi-stage `Dockerfile` on `node:22-slim`, `USER node`,
`/data` chowned; `docker-compose.yml` runs it `read_only` with a `/tmp` tmpfs. Not built
locally (no Docker on the dev PC): the publish workflow builds it.
