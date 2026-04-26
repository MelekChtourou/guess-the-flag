// Entry point: serves the static frontend and runs the multiplayer server.
//
// One Node process does both jobs:
//   - Express serves /public (the playable game).
//   - Socket.IO runs alongside on the same HTTP server for multiplayer rooms.
//
// Solo mode is a single GET /api/solo-questions call — no socket needed.

const path = require("path");
const http = require("http");
const express = require("express");
const { Server: SocketServer } = require("socket.io");

const {
  buildQuestionSet,
  buildDailyQuestionSet,
  buildCapitalQuestionSet,
  buildPopulationQuestionSet,
  dailyDateString,
  dailyDayNumber,
} = require("./questions");
const { registerSocketHandlers } = require("./gameManager");
const { loadDetails } = require("./countryDetails");
const { COUNTRIES } = require("./countries");
const Leaderboard = require("./leaderboard");
const { COUNTRY_DATA } = require("./countryData");

// Quick lookup for code → display name, used by the country-details endpoint.
const NAME_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  // Keep CORS open — this app serves its own frontend, but during local
  // dev (e.g. opening from a phone over LAN) the host header may differ.
  cors: { origin: "*" },
});

// JSON parsing for the leaderboard submit endpoint.
app.use(express.json({ limit: "8kb" }));

// Static frontend.
app.use(express.static(path.join(__dirname, "..", "public")));

// Favicon: browsers ask for /favicon.ico on first load even though we use
// an inline SVG. Returning 204 stops the noisy 404 in DevTools.
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Full country list — used by the menu's country picker (search + select).
// Returns just enough to render a row per country; no heavy data.
app.get("/api/countries", (req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.json({
    countries: COUNTRIES.map((c) => ({
      code: c.code,
      name: c.name,
      continent: c.continent,
    })),
  });
});

// Country summary — synchronous, lightweight version of /api/country/:code
// that reads only from the in-memory dataset (server/countries.js +
// server/countryData.js). No Wikipedia / REST Countries calls. Used by
// the globe menu when the user taps a country, where we want instant
// data, not the full cinematic panel.
app.get("/api/country-summary/:code", (req, res) => {
  const code = String(req.params.code || "").toLowerCase();
  const country = COUNTRIES.find((c) => c.code === code);
  if (!country) return res.status(404).json({ error: "unknown" });
  const data = COUNTRY_DATA[code] || {};
  res.set("Cache-Control", "public, max-age=86400");
  res.json({
    code,
    name:       country.name,
    continent:  country.continent,
    fact:       country.fact,
    capital:    data.capital    || null,
    population: data.population || null,
  });
});

// Country details (capital, population, languages, currencies, intro paragraph,
// thumbnail photo). Lazily fetched from REST Countries + Wikipedia and cached
// in memory so each country is loaded at most once per process lifetime.
app.get("/api/country/:code", async (req, res) => {
  const code = String(req.params.code || "").toLowerCase();
  const name = NAME_BY_CODE.get(code);
  if (!name) return res.status(404).json({ error: "Unknown country code" });
  try {
    const details = await loadDetails(code, name);
    // Cache aggressively at the edge — country data changes very slowly.
    res.set("Cache-Control", "public, max-age=86400");
    res.json(details);
  } catch (err) {
    // Don't leak the error; clients should still render the basics they have.
    res.status(502).json({ code, name, error: "upstream-failure" });
  }
});

// Whitelist of continents we accept as a filter — protects the server
// from arbitrary strings making their way into our pool filters.
const VALID_CONTINENTS = new Set(["Africa", "Asia", "Europe", "North America", "South America", "Oceania"]);
function continentParam(req) {
  const c = typeof req.query.continent === "string" ? req.query.continent : null;
  return c && VALID_CONTINENTS.has(c) ? c : null;
}

// Solo question set. Client controls its own timer and scoring.
app.get("/api/solo-questions", (req, res) => {
  const requested = parseInt(req.query.count, 10);
  const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 20) : 10;
  const continent = continentParam(req);
  res.json({ questions: buildQuestionSet(count, Math.random, { continent }) });
});

// Capital-game question set: capital city → 4 country options.
app.get("/api/capital-questions", (req, res) => {
  const requested = parseInt(req.query.count, 10);
  const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 20) : 10;
  const continent = continentParam(req);
  res.json({ questions: buildCapitalQuestionSet(count, Math.random, { continent }) });
});

// Population Showdown question set: pairs of countries to compare.
app.get("/api/population-questions", (req, res) => {
  const requested = parseInt(req.query.count, 10);
  const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 20) : 10;
  const continent = continentParam(req);
  res.json({ questions: buildPopulationQuestionSet(count, Math.random, { continent }) });
});

// Daily challenge. Same 10 questions for everyone on a given UTC day.
// Cache for a few minutes — the date rolls over rarely, but we don't
// want a 24h cache in case we ship a fix to the question generator.
app.get("/api/daily-questions", (req, res) => {
  const now = new Date();
  const date = dailyDateString(now);
  const dayNumber = dailyDayNumber(now);
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    date,
    dayNumber,
    questions: buildDailyQuestionSet(date, 10),
  });
});

// Submit a daily-challenge result. Server validates the day matches
// today and that the score is physically plausible (cheap anti-cheat).
app.post("/api/daily-result", (req, res) => {
  const { dayNumber, playerId, playerName, score, correct, durationMs } = req.body || {};
  const today = dailyDayNumber(new Date());
  // Allow only "today" submissions. Yesterday's daily is locked once UTC rolls.
  if (dayNumber !== today) return res.status(400).json({ error: "wrong day" });
  try {
    Leaderboard.submit({ day: dayNumber, playerId, playerName, score, correct, durationMs });
  } catch (e) {
    return res.status(400).json({ error: e.message || "invalid" });
  }
  res.json(Leaderboard.snapshot(dayNumber, playerId));
});

// Read-only leaderboard snapshot for the current day (or a specific
// past day via ?day=N — useful for replays of the locked-out daily).
app.get("/api/daily-leaderboard", (req, res) => {
  const requested = parseInt(req.query.day, 10);
  const day = Number.isFinite(requested) ? requested : dailyDayNumber(new Date());
  const playerId = typeof req.query.playerId === "string" ? req.query.playerId : null;
  res.set("Cache-Control", "no-store");
  res.json(Leaderboard.snapshot(day, playerId));
});

// SPA catchall — any unmatched GET that isn't an API call or static
// asset gets index.html so the History API router can pick it up.
// (This is what makes refreshing /stats or hitting /r/ABCD directly
// actually work.) The static middleware above handles real files; this
// runs for everything that fell through.
app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res, next) => {
  // Don't serve HTML for paths that look like a missing static file
  // (i.e. they have a file extension). Let the 404 chain handle them.
  if (/\.[a-z0-9]{1,5}$/i.test(req.path)) return next();
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Wire up multiplayer.
registerSocketHandlers(io);

server.listen(PORT, () => {
  console.log(`Guess the Flag listening on http://localhost:${PORT}`);
});
