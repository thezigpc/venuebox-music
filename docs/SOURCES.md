# Music sources: what's there, and what a business connector could use

Version 0.1.0 has two sources: **Spotify** (personal use) and **Music files** the venue
uploads. This page is for choosing the next connector. Researched 2026-11-13 from each
service's public developer pages; check again before building, since these change.

## Business music services

| Service | Public API? | Queue a specific track? | What access takes |
|---|---|---|---|
| **Soundtrack** (Soundtrack Your Brand, Spotify's partner for businesses) | Yes: one GraphQL API at `api.soundtrackyourbrand.com/v2` (queries, mutations, websocket subscriptions for now playing). | **No.** The documented mutations are control actions: skip, play/pause, volume, and choosing what a sound zone plays (playlists and schedules). Its docs say guests can't control playback and that "a 'jukebox' is not possible to build via our API". | A paying Soundtrack account and an API token you apply for (`soundtrackyourbrand.com/our-api/apply`). The API is free for customers. Rate limit: a 3600-token bucket per client. |
| **Rockbot** | Yes: v3 "Remote" and "Engage" APIs, and a newer v5 API (`developer.rockbot.com`). | **Not a specific song.** Engage's `request_artist` adds *a track by an artist* to the venue's queue; it takes only an `artist_id`. Remote/v5 cover now playing, skip (6 per hour), start/stop, volume, playlist overrides and banning a song. No documented song-request call. | A Rockbot venue (paid plan, or a trial) and the venue's private API key, from the Power-Ups section of the venue dashboard. v5 uses a bearer token; how to get one isn't documented publicly. |
| **Others** (Cloud Cover / Pandora CloudCover, Mood Media, Stingray Business, Jukeboxy, TouchTunes, Vibenomics) | No public developer API found. | n/a | Sales or partner agreements. |
| **Music APIs built for businesses** (Feed.fm, Tuned Global, MassiveMusic) | Yes, as B2B products with SDKs. | Varies; these are catalogues and players you build on, with licensing in the contract. | A commercial contract. |

**In short:** neither of the two business services that matter lets an app put a specific
guest-chosen song next. Soundtrack only switches what plays and skips; Rockbot comes
closest with "request an artist", plus its own guest-request app (Rockbot Request), which
replaces ours rather than plugging into it. A Rockbot connector could map a guest's
request to `request_artist` (with `can.queueTrack: false` and an "artist requests" label),
and a Soundtrack connector could offer now playing, skip and pause only. A licensed
catalogue (Feed.fm, Tuned Global) would allow the full design, but needs a commercial
contract.

## How a connector plugs in

Each source implements `MusicSource` (`server/src/sources/types.ts`): `can` (search,
queueTrack, skip, pause, readQueue), `status()`, `search()`, `play()` (start now, or right
after the current song), `nowPlaying()`, optional `skip`/`pause`/`resume`, and its polling
cadence and hand-over lead time. The app owns requests, rules and the queue, and hands the
source one song at a time shortly before the current one ends (`server/src/player.ts`),
so a new source gets every rule and page for free. The pages hide what `can` says the
source can't do.

## Sources checked

- Spotify Web API, February 2026 development-mode changes:
  https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
  and https://developer.spotify.com/documentation/web-api/references/changes/february-2026
- Soundtrack API docs: https://api.soundtrackyourbrand.com/v2/docs
- Rockbot: https://rockbot.com/docs/engage-api, https://rockbot.com/docs/remote-api,
  https://developer.rockbot.com/api.html
