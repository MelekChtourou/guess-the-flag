// Achievement definitions + evaluation.
//
// Each achievement is a pure function over the current profile (and the
// last game's outcome) that returns true if it's earned. We re-evaluate
// the whole list after every game-end and unlock anything new — fires
// a toast for each. Idempotent: already-unlocked achievements are
// skipped via Profile.unlockAchievement.

(function () {
  // --- Definitions --------------------------------------------------

  const TOTAL_COUNTRIES = 150;  // matches the countries.js dataset

  const ACHIEVEMENTS = [
    // Onboarding wins — quick early dopamine.
    { id: "first-game",      icon: "◐", title: "First Step",        desc: "Complete your first game.",
      check: (p) => p.totalGames >= 1 },
    { id: "first-correct",   icon: "✓", title: "Got One Right",     desc: "Guess your first flag correctly.",
      check: (p) => p.totalCorrect >= 1 },

    // Volume milestones.
    { id: "ten-games",       icon: "◇", title: "Coming Back",       desc: "Play 10 games.",
      check: (p) => p.totalGames >= 10 },
    { id: "fifty-games",     icon: "◆", title: "Regular",           desc: "Play 50 games.",
      check: (p) => p.totalGames >= 50 },
    { id: "hundred-correct", icon: "✦", title: "Centurion",         desc: "Get 100 correct answers.",
      check: (p) => p.totalCorrect >= 100 },

    // Skill — single-game.
    { id: "streak-5",        icon: "⥏", title: "On a Roll",         desc: "Hit a 5-streak.",
      check: (p) => p.longestStreak >= 5 },
    { id: "streak-10",       icon: "⚡", title: "Unstoppable",       desc: "Hit a 10-streak.",
      check: (p) => p.longestStreak >= 10 },
    { id: "score-1200",      icon: "★", title: "Big Score",         desc: "Score 1200+ in a game.",
      check: (p) => p.bestScore >= 1200 },

    // Daily habits.
    { id: "daily-streak-3",  icon: "☀", title: "Three in a Row",    desc: "Complete the daily 3 days running.",
      check: (p) => p.daily.bestStreak >= 3 },
    { id: "daily-streak-7",  icon: "✷", title: "Week Strong",       desc: "Complete the daily 7 days running.",
      check: (p) => p.daily.bestStreak >= 7 },
    { id: "perfect-daily",   icon: "♛", title: "Flawless Daily",    desc: "10/10 on a daily challenge.",
      check: (p) => Object.values(p.daily.completed).some((d) => d.correct === 10) },

    // Collection — unique countries seen.
    { id: "seen-50",         icon: "✈", title: "Globetrotter",      desc: "See flags from 50 different countries.",
      check: (p) => Object.keys(p.seenCodes).length >= 50 },
    { id: "seen-100",        icon: "⌖", title: "World Traveler",    desc: "See flags from 100 different countries.",
      check: (p) => Object.keys(p.seenCodes).length >= 100 },
    { id: "seen-all",        icon: "✺", title: "Every Flag",        desc: "See every flag in the dataset.",
      check: (p) => Object.keys(p.seenCodes).length >= TOTAL_COUNTRIES },

    // Continent mastery — high accuracy with enough sample size.
    { id: "africa-expert",   icon: "▲", title: "Africa Expert",
      desc: "75%+ accuracy on Africa with 10+ flags seen.",
      check: (p) => continentMastery(p, "Africa") },
    { id: "asia-expert",     icon: "▲", title: "Asia Expert",
      desc: "75%+ accuracy on Asia with 10+ flags seen.",
      check: (p) => continentMastery(p, "Asia") },
    { id: "europe-expert",   icon: "▲", title: "Europe Expert",
      desc: "75%+ accuracy on Europe with 10+ flags seen.",
      check: (p) => continentMastery(p, "Europe") },
    { id: "americas-expert", icon: "▲", title: "Americas Expert",
      desc: "75%+ accuracy on the Americas with 10+ flags seen.",
      check: (p) => combinedMastery(p, ["North America", "South America"]) },
    { id: "oceania-expert",  icon: "▲", title: "Oceania Expert",
      desc: "75%+ accuracy on Oceania with 6+ flags seen.",
      check: (p) => continentMastery(p, "Oceania", 6) },
  ];

  function continentMastery(p, continent, minSeen = 10) {
    const c = p.perContinent[continent];
    if (!c) return false;
    return c.total >= minSeen && (c.correct / c.total) >= 0.75;
  }

  function combinedMastery(p, continents, minSeen = 10) {
    let correct = 0, total = 0;
    for (const c of continents) {
      const stat = p.perContinent[c];
      if (stat) { correct += stat.correct; total += stat.total; }
    }
    return total >= minSeen && (correct / total) >= 0.75;
  }

  // --- Evaluation ---------------------------------------------------

  function evaluate() {
    if (!window.Profile) return [];
    const p = window.Profile.get();
    const newlyUnlocked = [];
    for (const a of ACHIEVEMENTS) {
      if (p.achievements[a.id]) continue;
      try {
        if (a.check(p)) {
          if (window.Profile.unlockAchievement(a.id)) newlyUnlocked.push(a);
        }
      } catch (e) { /* defensive: bad data shouldn't break game flow */ }
    }
    // Stagger toasts so they don't all blast at once.
    newlyUnlocked.forEach((a, i) => {
      setTimeout(() => {
        if (window.UI) window.UI.toast(`🏆 Achievement: ${a.title}`);
      }, 600 + i * 1200);
    });
    return newlyUnlocked;
  }

  function list() { return ACHIEVEMENTS.slice(); }

  function isUnlocked(id) {
    if (!window.Profile) return false;
    const p = window.Profile.get();
    return !!p.achievements[id];
  }

  window.Achievements = { list, evaluate, isUnlocked, TOTAL_COUNTRIES };
})();
