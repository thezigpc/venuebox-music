# Music Requests

Guests scan a QR code, search for a song and request it. Staff approve or skip requests
(or let them through automatically, within limits). The songs play from whichever music
source the venue connects, and the TVs can show what's playing, what's next, and the QR
code.

It's an app for the Bar Games box, and it also runs on its own (Docker or Node).

## Pages

| Page | For |
|---|---|
| `/` | Guests: search, request, "your requests", the queue. No login: one device = one cookie. |
| `/tv` | The TVs: big album art, title and artist, the next 3 songs, "Scan to request". |
| `/host` | Staff: approve or skip requests, reorder or remove the queue, skip and pause, requests on/off. |
| `/admin` | Setup: the music source and its wizard, the rules, the library, what played. |
| `/speaker` | A browser on a PC or tablet wired to the sound system (files source). |

## Music sources (0.1.0)

- **Spotify**, for home and personal use. Plays on your own Spotify device (phone, PC,
  speaker). You create your own free Spotify developer app (the account needs Premium) and
  paste its client id in the admin; the wizard walks you through it. This app ships no
  Spotify credentials and has no client secret (it signs in with PKCE).
- **Music files** you upload (MP3, M4A). They play on the box's speakers (box 0.15.0: its
  jack or HDMI, Bluetooth speakers, AirPlay TVs, set up under Settings → Connected devices),
  or on the speaker page.

The app keeps the queue itself and hands songs to the source one at a time, shortly before
the current one ends, so staff can reorder or remove anything that hasn't gone over yet.
Business music services are compared in [docs/SOURCES.md](docs/SOURCES.md).

## Rules (all in the admin)

Requests per guest per N minutes; most songs waiting per guest; no repeats within N
minutes; explicit songs blocked (on by default); blocked artists and words; longest song;
the longest queue; and approval by staff or automatic. When a rule blocks a request, the
guest sees which one, in plain words.

## Licensing

Spotify's terms allow personal, non-commercial use. You're responsible for how you use your
Spotify account and developer app. In a business, use a music service licensed for
businesses.

Playing music in public (a bar, a shop) also needs public performance licences, in the US
from ASCAP, BMI and SESAC. That's the responsibility of whoever runs the venue. This app
doesn't provide or include any licence.

## Running it

```bash
npm install
npm run build
npm start                 # http://localhost:3009 (PORT, DATA_DIR, ADMIN_PASSWORD, PUBLIC_URL, BASE_PATH)
npm test
npm run dev               # server on :3009, client on :5179
```

With Docker: `cp .env.example .env`, then `docker compose up -d --build`. It listens on
`127.0.0.1:3009`; put a tunnel or reverse proxy in front for guests.

**Spotify's redirect address** must be https, or `http://127.0.0.1:<port>`. Behind a tunnel
the wizard shows `https://<your host>/admin/spotify/callback`. At home with no tunnel, it
uses `http://127.0.0.1:8909/callback`: after you sign in the browser shows an error page,
and you paste that page's address into the admin.

On a Bar Games box: `npx bargames mock-box .` runs a pretend box for development.

## Data

Everything lives in `DATA_DIR` (`/data` in the container): settings and rules, the queue,
the history, the uploaded music (`music/`), and the Spotify sign-in (`spotify.json`, owner
only). Credentials are never logged or sent to a browser.
