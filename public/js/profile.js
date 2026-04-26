// Persistent player profile. Stored in localStorage under `gtf-profile`.
// No backend, no auth — purely a "play more, see your numbers grow" loop.
//
// Tracked stats:
//   - totalGames, totalRounds, totalCorrect, bestScore, longestStreak
//   - xp + level (XP = sum of all points scored; level = floor(sqrt(xp/200)))
//   - perContinent: { Africa: { correct, total }, ... }
//   - daily: { currentStreak, bestStreak, completed: { dayNum: { score, correct } } }

(function () {
  const STORAGE_KEY = "gtf-profile";

  const DEFAULT = () => ({
    totalGames: 0,
    totalRounds: 0,
    totalCorrect: 0,
    bestScore: 0,
    longestStreak: 0,
    xp: 0,
    perContinent: {},
    daily: {
      currentStreak: 0,
      bestStreak: 0,
      lastDay: null,         // most recent dayNumber that was completed
      completed: {},         // { 117: { score, correct }, 116: {...} }
    },
  });

  function read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT();
      const parsed = JSON.parse(raw);
      // Defensive merge in case we add fields later.
      return Object.assign(DEFAULT(), parsed, {
        perContinent: Object.assign({}, parsed.perContinent || {}),
        daily: Object.assign(DEFAULT().daily, parsed.daily || {}),
      });
    } catch (e) {
      return DEFAULT();
    }
  }

  function write(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function level(xp) {
    return Math.floor(Math.sqrt(xp / 200));
  }

  // Ensure perContinent has both keys; create lazily so old saves migrate.
  function bumpContinent(profile, continent, correct) {
    if (!continent) return;
    const c = profile.perContinent[continent] || (profile.perContinent[continent] = { correct: 0, total: 0 });
    c.total += 1;
    if (correct) c.correct += 1;
  }

  function recordRound({ continent, correct }) {
    const p = read();
    p.totalRounds += 1;
    if (correct) p.totalCorrect += 1;
    bumpContinent(p, continent, correct);
    write(p);
  }

  function recordGame({ score, longestStreakInGame = 0 }) {
    const p = read();
    p.totalGames += 1;
    p.xp += Math.max(0, score | 0);
    if (score > p.bestScore) p.bestScore = score;
    if (longestStreakInGame > p.longestStreak) p.longestStreak = longestStreakInGame;
    write(p);
    return { newBest: score === p.bestScore && score > 0 };
  }

  function recordDailyComplete({ dayNumber, score, correct }) {
    const p = read();
    if (p.daily.completed[dayNumber]) return p.daily; // idempotent

    p.daily.completed[dayNumber] = { score, correct, at: Date.now() };

    // Streak logic: if we played yesterday's daily, extend the streak;
    // otherwise reset to 1.
    if (p.daily.lastDay != null && p.daily.lastDay === dayNumber - 1) {
      p.daily.currentStreak += 1;
    } else {
      p.daily.currentStreak = 1;
    }
    if (p.daily.currentStreak > p.daily.bestStreak) p.daily.bestStreak = p.daily.currentStreak;
    p.daily.lastDay = dayNumber;
    write(p);
    return p.daily;
  }

  function dailyCompleted(dayNumber) {
    const p = read();
    return !!p.daily.completed[dayNumber];
  }

  function dailyResult(dayNumber) {
    const p = read();
    return p.daily.completed[dayNumber] || null;
  }

  // Convenience formatter for the menu badge.
  function summary() {
    const p = read();
    return {
      level:        level(p.xp),
      xp:           p.xp,
      totalCorrect: p.totalCorrect,
      bestScore:    p.bestScore,
      dailyStreak:  p.daily.currentStreak,
    };
  }

  function reset() {
    write(DEFAULT());
  }

  window.Profile = {
    get: read,
    recordRound,
    recordGame,
    recordDailyComplete,
    dailyCompleted,
    dailyResult,
    summary,
    level,
    reset,
  };
})();
