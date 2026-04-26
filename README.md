# Guess the Flag 🚩

A premium-feeling flag-guessing party game for the web. Mobile-first, solo or
multiplayer with a 4-letter room code, dark + light glass UI, an interactive
3D earth on the menu, and cinematic country reveals with photos pulled live
from Wikipedia.

> Live at <https://guess-flag.mohamedmelekchtourou.com>

---

## Highlights

- **3D rotating earth** as the menu hero (Three.js) — drag to spin in any
  direction, momentum on release, auto-resumes its idle drift after you let go
- **Cinematic country reveal** — full-bleed Wikipedia photo with a name +
  region overlay, structured stats (capital, population, languages, currency,
  area, region) from the [REST Countries API](https://restcountries.com/), and
  a one-paragraph intro from Wikipedia
- **Per-country accent color** — the panel subtly tints toward each country's
  primary flag color, sampled in-browser from the flag pixels
- **Synthesized sound design** — five effects built in pure Web Audio (tap,
  correct, wrong, reveal, victory). No audio assets, no licensing
- **Dark + light themes** with frosted-glass surfaces, refined Inter
  typography, and a fixed grain overlay for depth
- **Solo + multiplayer** — solo is fully manual ("Next" when you're ready);
  multiplayer hosts a 4-letter-code room and sees a countdown to auto-advance
- Vanilla HTML / CSS / JS — **no build step, no framework**
- Two npm dependencies: `express` + `socket.io`

---

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:3000>. For LAN testing on your phone, find your
laptop's IP and visit `http://<that-ip>:3000` from your phone on the same
Wi-Fi.

---

## How it plays

### Solo
10 rounds, 15 seconds each, 4-option multiple choice. Score = 100 base +
up to 50 for speed + up to 50 for streak. After each answer, the country
panel slides up — read the facts, look at the photo, tap **Next** when you
want to move on. No auto-advance.

### Multiplayer
- **Create Room** → you get a 4-letter code (e.g. `WXYZ`)
- Friends tap **Join Room**, enter the code, pick a nickname
- Host taps **Start game** when everyone's in
- Everyone sees the same flag at the same time
- After all players answer (or the 15s timer expires) the reveal panel
  opens for everyone simultaneously — the host has a `Next round → (Ns)`
  button with a 12-second auto-fallback so a distracted host can't stall
- Up to 8 players per room. Rooms are in-memory (server restart = gone)

The server is authoritative for scoring and round timing — clients can't
fake scores or peek at answers early.

---

## Architecture

```
server/
  index.js              Express + Socket.IO bootstrap, /api/* endpoints
  gameManager.js        Multiplayer rooms, scoring, round timing
  questions.js          Question-set builder with same-continent distractors
  countries.js          Country dataset (~150 entries)
  countryDetails.js     REST Countries + Wikipedia fetcher with in-mem cache

public/
  index.html            SPA shell with every screen
  css/style.css         Mobile-first glass theme, dark + light variables
  js/
    app.js              Screen routing + menu glue
    theme.js            Dark/light toggle (persisted to localStorage)
    sound.js            Web Audio synthesizer + mute toggle
    ui.js               Confetti, victory burst, shake, toasts, taunts
    colorExtractor.js   Per-country accent color from flag pixels
    country.js          Country-detail panel rendering
    game.js             Shared question rendering (both modes)
    solo.js             Solo mode controller
    multiplayer.js      Socket.IO client + lobby/game wiring
    globe.js            Three.js earth with drag-to-rotate

deploy/                 systemd unit + nginx config examples
```

A single Node process serves the static frontend and the Socket.IO server.
No database — multiplayer rooms live in memory by design (think Kahoot /
Jackbox).

---

## Multiplayer protocol

Socket.IO events. Server is authoritative — it builds the question set,
runs the per-round timer, and stores scores. Clients only know what the
server tells them.

| Client → Server  | Payload         |
|------------------|-----------------|
| `room:create`    | `{ name }`      |
| `room:join`      | `{ code, name }`|
| `room:leave`     | —               |
| `game:start`     | host only       |
| `game:answer`    | `{ choice }`    |
| `game:next`      | host only       |

| Server → Client  | Payload                                                            |
|------------------|--------------------------------------------------------------------|
| `lobby:update`   | `{ code, hostId, players, status }`                                |
| `round:start`    | `{ round, total, flagCode, options, deadline }`                    |
| `round:end`      | `{ round, total, correct, flagCode, fact, scores, deadline }`      |
| `game:end`       | `{ finalScores, winner }`                                          |

---

## External APIs (all free, no keys)

- **flagcdn.com** — flag PNGs at multiple resolutions
- **restcountries.com** — capital, population, languages, currencies, region, area
- **en.wikipedia.org** REST API — country intro paragraph + photo

The server-side fetcher in `countryDetails.js` caches results in memory for
the lifetime of the process, so each country is loaded at most once.

---

## Deploy

Docker container behind Caddy, deployed automatically by GitHub Actions
on every push to `main`.

```
┌──────────┐  push   ┌──────────┐  build+push   ┌──────┐  pull   ┌─────────┐
│ git main │────────▶│  GH CI   │──────────────▶│ GHCR │────────▶│ VPS     │
└──────────┘         └──────────┘                └──────┘         │ docker  │
                                                                  │  ↓      │
                                                              port 3100      │
                                                                  ↑          │
                                                                Caddy ────TLS┘
```

### One-time VPS setup

```bash
# (the VPS already has docker, docker-compose v2, and Caddy)

sudo mkdir -p /opt/guess-the-flag
sudo chown $USER:$USER /opt/guess-the-flag
# Copy the docker-compose.yml from this repo into /opt/guess-the-flag/.

# Append the contents of deploy/Caddyfile.snippet to /etc/caddy/Caddyfile
# and reload:
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

### CI/CD secrets

Add these in **Settings → Secrets and variables → Actions**:

| Secret      | Value                                                 |
|-------------|-------------------------------------------------------|
| `SSH_HOST`  | VPS hostname or IP                                    |
| `SSH_USER`  | login user (e.g. `debian`)                            |
| `SSH_PORT`  | SSH port (usually `22`)                               |
| `SSH_KEY`   | Private key (matching public key in `~/.ssh/authorized_keys` on the VPS) |

Generate a deploy-only key on the VPS to avoid reusing your main key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gha_guess_the_flag -N "" -C "github-actions/guess-the-flag"
cat ~/.ssh/gha_guess_the_flag.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/gha_guess_the_flag       # paste this into the SSH_KEY secret
```

### Deploy

`git push` to `main` runs `.github/workflows/deploy.yml`, which:
1. Builds the Docker image with cache from GHCR.
2. Pushes it to `ghcr.io/<owner>/<repo>:latest` (and a SHA-tagged variant).
3. SSHes into the VPS, runs `docker-compose pull && docker-compose up -d`.

You can also trigger a deploy manually from the **Actions** tab.

### Logs

```bash
ssh <vps>
docker logs -f guess-the-flag           # app
sudo tail -f /var/log/caddy/guess-flag.log   # http access
```

### Rollback

Image tags are SHA-pinned. To roll back, edit `/opt/guess-the-flag/docker-compose.yml`
on the VPS, change `:latest` to the SHA of a known-good build, then
`docker-compose up -d`.

---

## Configuration

The only env var the server reads is `PORT` (defaults to `3000`).

Game balance:
- Multiplayer: `server/gameManager.js` — `TOTAL_ROUNDS`, `ROUND_DURATION_MS`, `REVEAL_DURATION_MS`, scoring constants
- Solo: matching constants at the top of `public/js/solo.js`

---

## Adding more flags / facts

Edit `server/countries.js`:

```js
{ code: "xx", name: "Country Name", continent: "Asia", fact: "Fun fact." }
```

`code` must be an ISO 3166-1 alpha-2 code that flagcdn.com serves. The
panel's structured stats and intro paragraph are fetched live from the
external APIs at runtime, so you only need the code + name + a quirky one-
line fact.

---

## License

MIT.
