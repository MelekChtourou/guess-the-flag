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

const { buildQuestionSet, buildDailyQuestionSet, dailyDateString, dailyDayNumber } = require("./questions");
const { registerSocketHandlers } = require("./gameManager");
const { loadDetails } = require("./countryDetails");
const { COUNTRIES } = require("./countries");

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

// Static frontend.
app.use(express.static(path.join(__dirname, "..", "public")));

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

// Solo question set. Client controls its own timer and scoring.
app.get("/api/solo-questions", (req, res) => {
  const requested = parseInt(req.query.count, 10);
  const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 20) : 10;
  res.json({ questions: buildQuestionSet(count) });
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

// Wire up multiplayer.
registerSocketHandlers(io);

server.listen(PORT, () => {
  console.log(`Guess the Flag listening on http://localhost:${PORT}`);
});
