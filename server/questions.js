// Question generator. Picks N random countries and builds plausible
// multiple-choice options around each one (same continent when possible,
// to keep the difficulty believable).
//
// All randomness is funneled through a `rng` parameter (a function that
// returns 0..1) so the daily-challenge code can pass a deterministic
// seeded RNG and get the same questions for everyone on a given date.

const { COUNTRIES }    = require("./countries");
const { COUNTRY_DATA } = require("./countryData");

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

// =====================================================================
// Capital game — show a city name, pick the country.
// =====================================================================

// Pre-filter: only countries we have a capital for (most do).
const COUNTRIES_WITH_CAPITAL = COUNTRIES.filter((c) => COUNTRY_DATA[c.code]?.capital);

function buildCapitalQuestion(country, rng = Math.random) {
  // Same-continent distractors so wrong options feel plausible.
  const distractors = pickDistractors(country, OPTIONS_PER_QUESTION - 1, rng);
  const options = shuffle([country, ...distractors], rng).map((c) => c.name);
  return {
    capital:   COUNTRY_DATA[country.code].capital,
    flagCode:  country.code,
    options,
    correct:   country.name,
    continent: country.continent,
    fact:      country.fact,
  };
}

function buildCapitalQuestionSet(count = 10, rng = Math.random) {
  const picks = shuffle(COUNTRIES_WITH_CAPITAL, rng).slice(0, count);
  return picks.map((c) => buildCapitalQuestion(c, rng));
}

// =====================================================================
// Population Showdown — pick the more-populous of two countries.
// =====================================================================

const COUNTRIES_WITH_POP = COUNTRIES.filter(
  (c) => Number.isFinite(COUNTRY_DATA[c.code]?.population),
);

// We want the two countries to have an "interesting" ratio — not too
// close (frustrating coin flip) and not absurdly far (boring obvious
// answer). Empirically 1.3x → 6x feels right.
const POP_RATIO_MIN = 1.3;
const POP_RATIO_MAX = 6.0;

function pickPopulationPair(rng) {
  // Try a handful of times to find a pair within the target ratio band;
  // fall back to whatever we drew last if nothing fits.
  let pair = null;
  for (let i = 0; i < 30; i++) {
    const shuffled = shuffle(COUNTRIES_WITH_POP, rng);
    const a = shuffled[0];
    const b = shuffled[1];
    const popA = COUNTRY_DATA[a.code].population;
    const popB = COUNTRY_DATA[b.code].population;
    const ratio = Math.max(popA, popB) / Math.min(popA, popB);
    pair = { a, b };
    if (ratio >= POP_RATIO_MIN && ratio <= POP_RATIO_MAX) break;
  }
  return pair;
}

function buildPopulationQuestion(rng = Math.random) {
  const { a, b } = pickPopulationPair(rng);
  const popA = COUNTRY_DATA[a.code].population;
  const popB = COUNTRY_DATA[b.code].population;
  // We send populations to the client so it can reveal them after the
  // answer; the "correct" field tells us the bigger one.
  return {
    a: { code: a.code, name: a.name, population: popA, continent: a.continent },
    b: { code: b.code, name: b.name, population: popB, continent: b.continent },
    correct: popA >= popB ? "a" : "b",
  };
}

function buildPopulationQuestionSet(count = 10, rng = Math.random) {
  return Array.from({ length: count }, () => buildPopulationQuestion(rng));
}

module.exports = {
  buildQuestionSet,
  buildQuestion,
  buildDailyQuestionSet,
  buildCapitalQuestionSet,
  buildPopulationQuestionSet,
  dailyDateString,
  dailyDayNumber,
  OPTIONS_PER_QUESTION,
};
