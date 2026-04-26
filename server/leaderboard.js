// Daily-challenge leaderboard.
//
// Tiny SQLite store: one row per (day, player). On submit we UPSERT so a
// player can't double-submit. On read we compute rank, total, score
// distribution, and top 5.
//
// Players identify themselves with a stable random id stored in
// localStorage (gtf-profile.playerId). No auth, no email — anonymous
// by design. Anti-cheat is light: server validates that score and
// duration are physically plausible.
//
// DB lives at $DATA_DIR/leaderboard.db (or ./data/leaderboard.db by default).

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "leaderboard.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_results (
    day            INTEGER NOT NULL,
    player_id      TEXT    NOT NULL,
    player_name    TEXT,
    score          INTEGER NOT NULL,
    correct        INTEGER NOT NULL,
    duration_ms    INTEGER NOT NULL,
    submitted_at   INTEGER NOT NULL,
    PRIMARY KEY (day, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_day_score
    ON daily_results(day, score DESC);
`);

// --- Insert / upsert ----------------------------------------------------

const upsertStmt = db.prepare(`
  INSERT INTO daily_results (day, player_id, player_name, score, correct, duration_ms, submitted_at)
  VALUES (@day, @playerId, @playerName, @score, @correct, @durationMs, @submittedAt)
  ON CONFLICT(day, player_id) DO UPDATE SET
    -- Keep the *better* of the two attempts. In practice a clean client
    -- only submits once per day, but if something double-fires we'd
    -- rather keep the higher-scoring submission.
    player_name  = excluded.player_name,
    score        = MAX(score, excluded.score),
    correct      = MAX(correct, excluded.correct),
    duration_ms  = CASE WHEN excluded.score > score THEN excluded.duration_ms ELSE duration_ms END,
    submitted_at = excluded.submitted_at
`);

// Light anti-cheat: bound `score` and `duration` to physically achievable
// values for the given `correct` count.
const MAX_POINTS_PER_ROUND = 200;        // 100 base + 50 time + 50 streak
const MIN_MS_PER_ROUND     = 350;        // even faster than a tap is suspicious

function isPlausible({ score, correct, durationMs }) {
  if (typeof score      !== "number" || score      < 0) return false;
  if (typeof correct    !== "number" || correct    < 0 || correct > 10) return false;
  if (typeof durationMs !== "number" || durationMs < 0) return false;
  if (score      > correct * MAX_POINTS_PER_ROUND + 10) return false;
  if (durationMs < correct * MIN_MS_PER_ROUND)          return false;
  return true;
}

function submit({ day, playerId, playerName, score, correct, durationMs }) {
  if (!Number.isInteger(day))                               throw new Error("bad day");
  if (typeof playerId !== "string" || playerId.length < 8)  throw new Error("bad playerId");
  if (!isPlausible({ score, correct, durationMs }))         throw new Error("implausible");
  upsertStmt.run({
    day,
    playerId,
    playerName: (typeof playerName === "string" ? playerName.slice(0, 24) : null),
    score, correct, durationMs,
    submittedAt: Date.now(),
  });
}

// --- Read ---------------------------------------------------------------

const totalStmt = db.prepare(`SELECT COUNT(*) AS n FROM daily_results WHERE day = ?`);
const rankStmt  = db.prepare(`
  SELECT COUNT(*) AS rank
  FROM daily_results
  WHERE day = ? AND score > ?
`);
const myRowStmt = db.prepare(`
  SELECT score, correct, duration_ms FROM daily_results
  WHERE day = ? AND player_id = ?
`);
const topStmt   = db.prepare(`
  SELECT player_name AS name, score, correct
  FROM daily_results
  WHERE day = ?
  ORDER BY score DESC, duration_ms ASC
  LIMIT 10
`);
const histStmt  = db.prepare(`
  SELECT
    CAST(score / 200 AS INTEGER) AS bucket,
    COUNT(*) AS count
  FROM daily_results
  WHERE day = ?
  GROUP BY bucket
  ORDER BY bucket
`);

function snapshot(day, playerId) {
  const total = totalStmt.get(day).n;
  if (total === 0) {
    return { total: 0, rank: null, percentile: null, top: [], distribution: [], me: null };
  }
  const me = playerId ? myRowStmt.get(day, playerId) : null;

  let rank = null, percentile = null;
  if (me) {
    // Rank = number of players strictly above + 1.
    rank = rankStmt.get(day, me.score).rank + 1;
    percentile = Math.max(1, Math.round((1 - (rank - 1) / total) * 100));
  }

  const top = topStmt.all(day);

  // Histogram: buckets of 200pts (max score is 2000), so 0..10 buckets.
  const distMap = new Map();
  for (let i = 0; i <= 10; i++) distMap.set(i, 0);
  histStmt.all(day).forEach((r) => distMap.set(r.bucket, r.count));
  const distribution = [...distMap.entries()].map(([bucket, count]) => ({
    from: bucket * 200,
    to:   (bucket + 1) * 200 - 1,
    count,
  }));

  return { total, rank, percentile, top, distribution, me };
}

module.exports = { submit, snapshot };
