// Daily challenge controller.
//
// Re-uses the solo game UI (Game.renderRound + reveal panel + scoring)
// but pulls its question set from /api/daily-questions and persists the
// per-round outcome in localStorage so the player can't replay today.
//
// Three states are surfaced to the menu card:
//   - idle:      not played today  → "Play"
//   - inProgress: started but not finished (we just resume from the start;
//                no real per-round resume since the daily is short)
//   - done:      already played today  → result + share button

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
  }

  // --- Local persistence -------------------------------------------

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function storeFinal(payload) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) {}
  }

  // --- Menu card rendering -----------------------------------------

  // Update the daily card in the main menu — called on app load and after
  // the user finishes a daily.
  async function refreshMenuCard() {
    const card = document.getElementById("menu-daily");
    if (!card) return;
    const sub = card.querySelector(".menu-sub");
    const right = card.querySelector(".menu-arrow");

    let info;
    try {
      info = await fetchInfo();   // { dayNumber, date }
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
    } else {
      sub.textContent = `Daily #${info.dayNumber} — same flags for everyone today`;
      right.textContent = "→";
      card.dataset.state = "idle";
    }
  }

  // --- API ---------------------------------------------------------

  async function fetchInfo() {
    // Tiny endpoint hit just to learn the day number; results aren't
    // exposed to the client until they actually start playing (so they
    // can't peek at answers).
    const res = await fetch("/api/daily-questions");
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();   // { dayNumber, date, questions }
  }

  async function fetchQuestions() {
    const data = await fetchInfo();
    state.dayNumber = data.dayNumber;
    state.date = data.date;
    return data.questions;
  }

  // --- Game flow ---------------------------------------------------

  async function start() {
    reset();

    // Hard-block if the user already finished today's daily.
    let info;
    try { info = await fetchInfo(); } catch (e) {
      if (window.UI) window.UI.toast("Couldn't load today's challenge");
      window.App.show("menu");
      return;
    }

    const stored = loadStored();
    if (stored && stored.dayNumber === info.dayNumber && stored.completed) {
      // Jump to results with the existing data.
      showResults({
        score:    stored.score,
        results:  stored.results,
        streak:   stored.longestStreak || 0,
        dayNumber: info.dayNumber,
        replay:   true,
      });
      return;
    }

    state.questions = info.questions;
    state.dayNumber = info.dayNumber;
    state.date = info.date;

    window.App.show("game");
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

    if (window.Profile) window.Profile.recordRound({ continent: q.continent, correct });

    window.Game.updateHud({ score: state.score, streak: state.streak });

    const lastRound = state.index + 1 >= state.questions.length;
    window.Game.revealAnswer(q.correct, picked, {
      nextLabel: lastRound ? "See results →" : "Next →",
    });
  }

  function finish() {
    clearTimers();

    // Persist + bump global profile.
    storeFinal({
      dayNumber: state.dayNumber,
      date:      state.date,
      results:   state.results,
      score:     state.score,
      longestStreak: state.longestStreak,
      completed: true,
      at:        Date.now(),
    });
    if (window.Profile) {
      window.Profile.recordGame({ score: state.score, longestStreakInGame: state.longestStreak });
      window.Profile.recordDailyComplete({
        dayNumber: state.dayNumber,
        score: state.score,
        correct: state.results.filter((r) => r === "correct").length,
      });
    }

    showResults({
      score:    state.score,
      results:  state.results,
      streak:   state.longestStreak,
      dayNumber: state.dayNumber,
      replay:   false,
    });
    refreshMenuCard();
  }

  function showResults({ score, results, streak, dayNumber, replay }) {
    const tier = window.UI.tierForScore(score);
    document.getElementById("results-tier").textContent = replay
      ? `Daily #${dayNumber} — done`
      : tier.label;
    document.getElementById("results-score").textContent = `${score} pts`;
    document.getElementById("results-scores").hidden = true;

    // Render the share card section.
    renderShareCard({ mode: "daily", day: dayNumber, results, score, streak });

    window.App.show("results");
    if (!replay && score >= 700) {
      window.UI.victoryBurst();
      if (window.Sound) window.Sound.play("victory");
    }
  }

  function renderShareCard(opts) {
    const wrap = document.getElementById("share-card");
    if (!wrap) return;
    const text = window.Share.format(opts);
    wrap.hidden = false;
    wrap.querySelector(".share-grid").textContent = opts.results
      .map((r) => ({ correct: "🟩", wrong: "🟥", timeout: "⬛" }[r] || "🟥"))
      .join("");
    wrap.querySelector(".share-summary").textContent = (() => {
      const correctCount = opts.results.filter((r) => r === "correct").length;
      return `Daily #${opts.day} · ${correctCount}/${opts.results.length} · ${opts.score} pts`;
    })();
    const shareBtn = wrap.querySelector(".share-btn");
    shareBtn.onclick = () => window.Share.share(text, "Guess the Flag");
  }

  function leave() { clearTimers(); }

  document.addEventListener("DOMContentLoaded", () => {
    refreshMenuCard();
  });

  window.Daily = { start, leave, refreshMenuCard };
})();
