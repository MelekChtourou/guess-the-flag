// Solo-mode controller.
//
// Flow:
//   1. Fetch /api/solo-questions to get a fresh set of N questions.
//   2. Render flag + options, start a 15s timer.
//   3. Player answers (or times out) -> reveal panel opens (handled by
//      Game.revealAnswer) and stays until the player taps Next.
//   4. Tap Next -> advance to the next round.
//   5. After the last round, jump to the results screen with a tier label.

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
    results: [],   // "correct" | "wrong" | "timeout" — used for the share card
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
    const res = await fetch(`/api/solo-questions?count=${count}`);
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
      window.App.show("menu");
      return;
    }
    window.App.show("game");
    window.Game.updateHud({
      round: 1,
      total: state.questions.length,
      score: 0,
      streak: 0,
    });
    // Wire the Next button for solo: advance immediately.
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

    // Server-style timeout: if no answer in ROUND_MS, score it as a miss.
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

    if (window.Profile) window.Profile.recordRound({ continent: question.continent, correct });

    window.Game.updateHud({ score: state.score, streak: state.streak });

    // Show the reveal panel; it stays open until the player taps Next.
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

    // Update profile + render the share card.
    if (window.Profile) {
      window.Profile.recordGame({
        score: state.score,
        longestStreakInGame: state.longestStreak,
      });
    }
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
      `Solo · ${correctCount}/${state.results.length} · ${state.score} pts`;
    wrap.querySelector(".share-btn").onclick = () =>
      window.Share.share(window.Share.format({
        mode: "solo",
        results: state.results,
        score: state.score,
        streak: state.longestStreak,
      }), "Guess the Flag");
  }

  function leave() {
    clearTimers();
  }

  window.Solo = { start, leave };
})();
