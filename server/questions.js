// Question generator. Picks N random countries and builds plausible
// multiple-choice options around each one (same continent when possible,
// to keep the difficulty believable).
//
// All randomness is funneled through a `rng` parameter (a function that
// returns 0..1) so the daily-challenge code can pass a deterministic
// seeded RNG and get the same questions for everyone on a given date.

const { COUNTRIES } = require("./countries");

const OPTIONS_PER_QUESTION = 4;

// Daily challenge epoch — used to compute "Daily #N" identifiers.
// Pinned to 2026-01-01 UTC so day numbers are stable.
const DAILY_EPOCH_MS = Date.UTC(2026, 0, 1);

// --- Seedable PRNG --------------------------------------------------

// Mulberry32 — short, fast, well-distributed for our small payloads.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tiny string-hash → 32-bit int. Good enough to seed a PRNG from a date.
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- Sampling -------------------------------------------------------

function shuffle(array, rng = Math.random) {
  // Fisher–Yates shuffle, in-place; returns a fresh shuffled copy.
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDistractors(correct, count, rng) {
  // Prefer same-continent countries — wrong answers feel fairer that way.
  // Falls back to the global pool if we run out of same-continent options.
  const sameContinent = COUNTRIES.filter(
    (c) => c.continent === correct.continent && c.code !== correct.code,
  );
  const others = COUNTRIES.filter(
    (c) => c.continent !== correct.continent && c.code !== correct.code,
  );

  const pool = shuffle(sameContinent, rng).slice(0, count);
  while (pool.length < count) pool.push(...shuffle(others, rng).slice(0, count - pool.length));
  return pool.slice(0, count);
}

function buildQuestion(country, rng = Math.random) {
  const distractors = pickDistractors(country, OPTIONS_PER_QUESTION - 1, rng);
  const options = shuffle([country, ...distractors], rng).map((c) => c.name);
  return {
    flagCode:  country.code,
    options,
    correct:   country.name,
    continent: country.continent,
    fact:      country.fact,
  };
}

function buildQuestionSet(count = 10, rng = Math.random) {
  const picks = shuffle(COUNTRIES, rng).slice(0, count);
  return picks.map((c) => buildQuestion(c, rng));
}

// --- Daily challenge ------------------------------------------------

function dailyDateString(now = new Date()) {
  // YYYY-MM-DD in UTC. Same value across timezones for a given UTC day.
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dailyDayNumber(now = new Date()) {
  // Days since the epoch — used for the "Daily #N" label.
  const startOfDayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((startOfDayUTC - DAILY_EPOCH_MS) / 86_400_000) + 1;
}

function buildDailyQuestionSet(dateStr, count = 10) {
  // The seed is `hash("daily:" + date)` — adding a namespace prevents the
  // unlikely collision where someone reuses `hashString(date)` elsewhere.
  const seed = hashString("daily:" + dateStr);
  const rng = mulberry32(seed);
  return buildQuestionSet(count, rng);
}

module.exports = {
  buildQuestionSet,
  buildQuestion,
  buildDailyQuestionSet,
  dailyDateString,
  dailyDayNumber,
  OPTIONS_PER_QUESTION,
};
