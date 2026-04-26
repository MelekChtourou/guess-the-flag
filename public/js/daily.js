// Daily challenge controller.
//
// Re-uses the solo game UI (Game.renderRound + reveal panel + scoring)
// but pulls its question set from /api/daily-questions and persists
// per-round state in localStorage so:
//   - the player can't replay today after finishing
//   - if they refresh mid-game, they resume from the next unanswered round
//     (no longer lose their single attempt)
//
// After finishing, the score is submitted to the global leaderboard
// (POST /api/daily-result) and the response is rendered: rank, total
// players, score distribution, top 5.

(function () {
  const STORAGE_KEY = "gtf-daily";

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
    results: [],     // "correct" | "wrong" | "timeout" per round
    dayNumber: null,
    date: null,
    startedAt: 0,    // for total duration → leaderboard anti-cheat sanity
    roundStartedAt: 0,
    timeoutHandle: null,
  };

  function clearTimers() {
    if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }
  }

  function reset() {
    clearTimers();
    state.questions = [];
    state.index = 0;
    state.score = 0;
    state.streak = 0;
    state.longestStreak = 0;
    state.results = [];
    state.dayNumber = null;
    state.date = null;
    state.startedAt = 0;
  }

  // --- Local persistence -------------------------------------------

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function storeProgress() {
    // Snapshot just enough to resume on refresh. Updated every round.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        dayNumber: state.dayNumber,
        date:      state.date,
        results:   state.results,
        score:     state.score,
        streak:    state.streak,
        longestStreak: state.longestStreak,
        index:     state.index,
        startedAt: state.startedAt,
        completed: false,
        at:        Date.now(),
      }));
    } catch (e) {}
  }

  function storeFinal(extra = {}) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        dayNumber: state.dayNumber,
        date:      state.date,
        results:   state.results,
        score:     state.score,
        longestStreak: state.longestStreak,
        startedAt: state.startedAt,
        completed: true,
        at:        Date.now(),
        ...extra,
      }));
    } catch (e) {}
  }

  // --- Menu card rendering -----------------------------------------

  async function refreshMenuCard() {
    const card = document.getElementById("menu-daily");
    if (!card) return;
    const sub = card.querySelector(".menu-sub");
    const right = card.querySelector(".menu-arrow");

    let info;
    try {
      info = await fetchInfo();
    } catch (e) {
      sub.textContent = "Today's challenge — couldn't load";
      return;
    }
    state.dayNumber = info.dayNumber;
    state.date = info.date;

    const stored = loadStored();
    if (stored && stored.dayNumber === info.dayNumber && stored.completed) {
      const correctCount = stored.results.filter((r) => r === "correct").length;
      sub.textContent = `Daily #${info.dayNumber} — done · ${correctCount}/${stored.results.length}`;
      right.textContent = "✓";
      card.dataset.state = "done";
    } else if (stored && stored.dayNumber === info.dayNumber && stored.results && stored.results.length > 0) {
      sub.textContent = `Daily #${info.dayNumber} — resume · ${stored.results.length}/10`;
      right.textContent = "↻";
      card.dataset.state = "in-progress";
    } else {
      sub.textContent = `Daily #${info.dayNumber} — same flags for everyone today`;
      right.textContent = "→";
      card.dataset.state = "idle";
    }
  }

  // --- API ---------------------------------------------------------

  async function fetchInfo() {
    const res = await fetch("/api/daily-questions");
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  // --- Game flow ---------------------------------------------------

  async function start() {
    reset();

    let info;
    try { info = await fetchInfo(); } catch (e) {
      if (window.UI) window.UI.toast("Couldn't load today's challenge");
      window.Router.go("/");
      return;
    }

    const stored = loadStored();
    // Already finished today → jump straight to results.
    if (stored && stored.dayNumber === info.dayNumber && stored.completed) {
      state.dayNumber = info.dayNumber;
      state.date = info.date;
      state.results = stored.results;
      state.score = stored.score;
      state.longestStreak = stored.longestStreak || 0;
      showResults({ replay: true });
      return;
    }

    state.questions = info.questions;
    state.dayNumber = info.dayNumber;
    state.date = info.date;

    // Resume from a partial save if it matches today's day.
    if (stored && stored.dayNumber === info.dayNumber && stored.results && stored.results.length > 0 && !stored.completed) {
      state.results       = stored.results.slice();
      state.score         = stored.score || 0;
      state.streak        = stored.streak || 0;
      state.longestStreak = stored.longestStreak || 0;
      state.index         = state.results.length;
      state.startedAt     = stored.startedAt || Date.now();
      if (window.UI) window.UI.toast(`Resumed at round ${state.index + 1}`);
    } else {
      state.startedAt = Date.now();
    }

    window.App.show("game");
    window.Game.updateHud({
      round: state.index + 1,
      total: state.questions.length,
      score: state.score,
      streak: state.streak,
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
      state.results.push("timeout");
      state.streak = 0;
    } else if (correct) {
      const timeFraction = Math.max(0, 1 - elapsed / ROUND_MS);
      const timeBonus    = Math.round(POINTS_TIME_MAX * timeFraction);
      state.streak += 1;
      if (state.streak > state.longestStreak) state.longestStreak = state.streak;
      const streakBonus  = Math.min(state.streak * POINTS_STREAK_PER, POINTS_STREAK_MAX);
      state.score += POINTS_BASE + timeBonus + streakBonus;
      state.results.push("correct");
    } else {
      state.streak = 0;
      state.results.push("wrong");
    }

    if (window.Profile) {
      window.Profile.recordRound({ continent: q.continent, correct, code: q.flagCode });
    }

    // Persist progress so a refresh resumes from here.
    storeProgress();

    window.Game.updateHud({ score: state.score, streak: state.streak });

    const lastRound = state.index + 1 >= state.questions.length;
    window.Game.revealAnswer(q.correct, picked, {
      nextLabel: lastRound ? "See results →" : "Next →",
    });
  }

  async function finish() {
    clearTimers();

    // Persist locally first — we never want to depend on the network
    // for the daily lock-out.
    const durationMs = state.startedAt ? (Date.now() - state.startedAt) : 0;
    storeFinal({ durationMs });

    if (window.Profile) {
      window.Profile.recordGame({
        score: state.score,
        longestStreakInGame: state.longestStreak,
      });
      window.Profile.recordDailyComplete({
        dayNumber: state.dayNumber,
        score: state.score,
        correct: state.results.filter((r) => r === "correct").length,
      });
    }
    if (window.Achievements) window.Achievements.evaluate({ trigger: "daily-finish" });

    showResults({ replay: false });
    refreshMenuCard();

    // Submit to global leaderboard (best-effort) and render the panel.
    if (window.Leaderboard) {
      window.Leaderboard.submitAndShow({
        dayNumber:  state.dayNumber,
        score:      state.score,
        correct:    state.results.filter((r) => r === "correct").length,
        durationMs,
      });
    }
  }

  function showResults({ replay }) {
    const tier = window.UI.tierForScore(state.score);
    document.getElementById("results-tier").textContent = replay
      ? `Daily #${state.dayNumber} — done`
      : tier.label;
    document.getElementById("results-score").textContent = `${state.score} pts`;
    document.getElementById("results-scores").hidden = true;

    renderShareCard();

    window.App.show("results");
    if (!replay && state.score >= 700) {
      window.UI.victoryBurst();
      if (window.Sound) window.Sound.play("victory");
    }

    // For replays, re-show the leaderboard with last-known data (no resubmit).
    if (replay && window.Leaderboard) {
      window.Leaderboard.showLast(state.dayNumber);
    }
  }

  function renderShareCard() {
    const wrap = document.getElementById("share-card");
    if (!wrap) return;
    wrap.hidden = false;
    wrap.querySelector(".share-grid").textContent = state.results
      .map((r) => ({ correct: "🟩", wrong: "🟥", timeout: "⬛" }[r] || "🟥"))
      .join("");
    const correctCount = state.results.filter((r) => r === "correct").length;
    wrap.querySelector(".share-summary").textContent =
      `Daily #${state.dayNumber} · ${correctCount}/${state.results.length} · ${state.score} pts`;
    wrap.querySelector(".share-btn").onclick = () =>
      window.Share.share(window.Share.format({
        mode:    "daily",
        day:     state.dayNumber,
        results: state.results,
        score:   state.score,
        streak:  state.longestStreak,
      }), "Guess the Flag");
  }

  function leave() { clearTimers(); }

  document.addEventListener("DOMContentLoaded", () => {
    refreshMenuCard();
  });

  window.Daily = { start, leave, refreshMenuCard };
})();
