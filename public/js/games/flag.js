// Mini-game: Guess the Flag.
//
// Flow:
//   1. Fetch /api/solo-questions to get a fresh set of N questions.
//   2. Render flag + 4 country options, start a 15s timer.
//   3. Player answers (or times out) → reveal panel with country detail.
//   4. Tap Next → advance to the next round.
//   5. After the last round, jump to the results screen with a tier label
//      and a share card.
//
// Registers itself as `window.Games.flag` so the hub can spawn it.

(function () {
  const ROUND_MS = 15000;

  const POINTS_BASE       = 100;
  const POINTS_TIME_MAX   = 50;
  const POINTS_STREAK_PER = 10;
  const POINTS_STREAK_MAX = 50;

  const state = {
    questions: [],
    index: 0,
    score: 0,
    streak: 0,
    longestStreak: 0,
    results: [],
    roundStartedAt: 0,
    timeoutHandle: null,
  };

  function reset() {
    clearTimers();
    state.questions = [];
    state.index = 0;
    state.score = 0;
    state.streak = 0;
    state.longestStreak = 0;
    state.results = [];
  }

  function clearTimers() {
    if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }
  }

  async function fetchQuestions(count = 10) {
    const continent = window.Menu && window.Menu.continentFromUrl();
    const params = new URLSearchParams({ count: String(count) });
    if (continent) params.set("continent", continent);
    const res = await fetch(`/api/solo-questions?${params}`);
    if (!res.ok) throw new Error("Failed to load questions");
    const data = await res.json();
    return data.questions;
  }

  async function start() {
    reset();
    try {
      state.questions = await fetchQuestions(10);
    } catch (err) {
      window.UI.toast("Couldn't load questions — try again");
      window.Router.go("/");
      return;
    }
    window.App.show("game");
    window.Game.setQuestionStyle("flag");   // tells the engine to show the flag image
    window.Game.updateHud({
      round: 1,
      total: state.questions.length,
      score: 0,
      streak: 0,
    });
    window.Game.onNextClick(() => {
      state.index += 1;
      nextRound();
    });
    nextRound();
  }

  function nextRound() {
    if (state.index >= state.questions.length) return finish();
    const question = state.questions[state.index];
    state.roundStartedAt = Date.now();

    window.Game.updateHud({ round: state.index + 1 });
    window.Game.renderRound(question, {
      deadlineMs: ROUND_MS,
      onAnswer: (picked) => onAnswer(picked),
    });

    state.timeoutHandle = setTimeout(() => onAnswer(null), ROUND_MS);
  }

  function onAnswer(picked) {
    if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }

    const question = state.questions[state.index];
    const elapsed = Date.now() - state.roundStartedAt;
    const correct = picked === question.correct;

    if (picked == null) {
      state.results.push("timeout");
      state.streak = 0;
    } else if (correct) {
      const timeFraction = Math.max(0, 1 - elapsed / ROUND_MS);
      const timeBonus = Math.round(POINTS_TIME_MAX * timeFraction);
      state.streak += 1;
      if (state.streak > state.longestStreak) state.longestStreak = state.streak;
      const streakBonus = Math.min(state.streak * POINTS_STREAK_PER, POINTS_STREAK_MAX);
      state.score += POINTS_BASE + timeBonus + streakBonus;
      state.results.push("correct");
    } else {
      state.streak = 0;
      state.results.push("wrong");
    }

    if (window.Profile) {
      window.Profile.recordRound({
        continent: question.continent,
        correct,
        code: question.flagCode,
      });
    }

    window.Game.updateHud({ score: state.score, streak: state.streak });

    const lastRound = state.index + 1 >= state.questions.length;
    window.Game.revealAnswer(question.correct, picked, {
      nextLabel: lastRound ? "See results →" : "Next →",
    });
  }

  function finish() {
    clearTimers();
    const tier = window.UI.tierForScore(state.score);
    document.getElementById("results-tier").textContent = tier.label;
    document.getElementById("results-score").textContent = `${state.score} pts`;
    document.getElementById("results-scores").hidden = true;

    if (window.Profile) {
      window.Profile.recordGame({
        score: state.score,
        longestStreakInGame: state.longestStreak,
      });
    }
    if (window.Achievements) window.Achievements.evaluate();
    renderShareCard();

    window.App.show("results");
    if (state.score >= 700) {
      window.UI.victoryBurst();
      if (window.Sound) window.Sound.play("victory");
    }
  }

  function renderShareCard() {
    const wrap = document.getElementById("share-card");
    if (!wrap || !window.Share) return;
    wrap.hidden = false;
    wrap.querySelector(".share-grid").textContent = state.results
      .map((r) => ({ correct: "🟩", wrong: "🟥", timeout: "⬛" }[r] || "🟥"))
      .join("");
    const correctCount = state.results.filter((r) => r === "correct").length;
    wrap.querySelector(".share-summary").textContent =
      `Flags · ${correctCount}/${state.results.length} · ${state.score} pts`;
    wrap.querySelector(".share-btn").onclick = () =>
      window.Share.share(window.Share.format({
        mode: "solo",
        title: "Atlas — Flags",
        results: state.results,
        score: state.score,
        streak: state.longestStreak,
      }), "Atlas");
  }

  function leave() {
    clearTimers();
  }

  window.Games = window.Games || {};
  window.Games.flag = {
    id:    "flag",
    title: "Guess the Flag",
    icon:  "🚩",
    start, leave,
  };

  // Back-compat: the old window.Solo namespace is still referenced by app.js.
  // We'll clean those callers up in the same wave.
  window.Solo = { start, leave };
})();
