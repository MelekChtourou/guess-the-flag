// Question generator. Picks N random countries and builds plausible
// multiple-choice options around each one (same continent when possible,
// to keep the difficulty believable).

const { COUNTRIES } = require("./countries");

const OPTIONS_PER_QUESTION = 4;

function shuffle(array) {
  // Fisher–Yates shuffle, in-place; returns the same array for convenience.
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDistractors(correct, count) {
  // Prefer same-continent countries — wrong answers feel fairer that way.
  // Falls back to the global pool if we run out of same-continent options.
  const sameContinent = COUNTRIES.filter(
    (c) => c.continent === correct.continent && c.code !== correct.code,
  );
  const others = COUNTRIES.filter(
    (c) => c.continent !== correct.continent && c.code !== correct.code,
  );

  const pool = shuffle(sameContinent).slice(0, count);
  while (pool.length < count) pool.push(...shuffle(others).slice(0, count - pool.length));
  return pool.slice(0, count);
}

function buildQuestion(country) {
  const distractors = pickDistractors(country, OPTIONS_PER_QUESTION - 1);
  const options = shuffle([country, ...distractors]).map((c) => c.name);
  return {
    flagCode: country.code,
    options,
    correct: country.name,
    fact: country.fact,
  };
}

function buildQuestionSet(count = 10) {
  const picks = shuffle(COUNTRIES).slice(0, count);
  return picks.map(buildQuestion);
}

module.exports = { buildQuestionSet, buildQuestion, OPTIONS_PER_QUESTION };
