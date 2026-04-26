// Mini-game: Guess the Capital.
//
// Same skeleton as Flag — fetch 10 questions, render rounds, reveal panel
// with the country detail, share card. Difference: the stimulus is the
// capital city name (text), not a flag image. Engine.setQuestionStyle()
// switches the rendering.

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
    const res = await fetch(`/api/capital-questions?count=${count}`);
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
    window.Game.setQuestionStyle("capital");   // engine swaps to text stimulus
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
    const q = state.questions[state.index];
    state.roundStartedAt = Date.now();

    window.Game.updateHud({ round: state.index + 1 });
    window.Game.renderRound(q, {
      deadlineMs: ROUND_MS,
      onAnswer: (picked) => onAnswer(picked),
    });

    state.timeoutHandle = setTimeout(() => onAnswer(null), ROUND_MS);
  }

  function onAnswer(picked) {
    if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }

    const q = state.questions[state.index];
    const elapsed = Date.now() - state.roundStartedAt;
    const correct = picked === q.correct;

    if (picked == null) {
      state.results.push("timeout"); state.streak = 0;
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
        continent: q.continent,
        correct,
        code: q.flagCode,
      });
    }

    window.Game.updateHud({ score: state.score, streak: state.streak });

    const lastRound = state.index + 1 >= state.questions.length;
    window.Game.revealAnswer(q.correct, picked, {
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
      `Capitals · ${correctCount}/${state.results.length} · ${state.score} pts`;
    wrap.querySelector(".share-btn").onclick = () =>
      window.Share.share(window.Share.format({
        mode: "solo",
        title: "Atlas — Capitals",
        results: state.results,
        score: state.score,
        streak: state.longestStreak,
      }), "Atlas");
  }

  function leave() { clearTimers(); }

  window.Games = window.Games || {};
  window.Games.capital = {
    id:    "capital",
    title: "Guess the Capital",
    icon:  "🏛",
    start, leave,
  };
})();
