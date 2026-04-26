// Mini-game: Population Showdown.
//
// Two countries side-by-side, tap the one with more inhabitants. We don't
// use the standard 4-options engine — this is a custom split-screen UI.
// Same scoring philosophy (base + time bonus + streak), same profile
// recording, same share card.

(function () {
  const ROUND_MS = 12000;             // a bit shorter — duels should feel snappy

  const POINTS_BASE       = 100;
  const POINTS_TIME_MAX   = 50;
  const POINTS_STREAK_PER = 10;
  const POINTS_STREAK_MAX = 50;

  const REVEAL_PAUSE_MS = 1400;       // brief pause before auto-advancing

  const state = {
    questions: [],
    index: 0,
    score: 0,
    streak: 0,
    longestStreak: 0,
    results: [],
    roundStartedAt: 0,
    answered: false,
    timeoutHandle: null,
    advanceHandle: null,
  };

  function reset() {
    clearTimers();
    state.questions = [];
    state.index = 0;
    state.score = 0;
    state.streak = 0;
    state.longestStreak = 0;
    state.results = [];
    state.answered = false;
  }
  function clearTimers() {
    if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }
    if (state.advanceHandle) { clearTimeout(state.advanceHandle); state.advanceHandle = null; }
  }

  async function fetchQuestions(count = 10) {
    const continent = window.Menu && window.Menu.continentFromUrl();
    const params = new URLSearchParams({ count: String(count) });
    if (continent) params.set("continent", continent);
    const res = await fetch(`/api/population-questions?${params}`);
    if (!res.ok) throw new Error("Failed to load questions");
    const data = await res.json();
    return data.questions;
  }

  // --- DOM helpers --------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function flagUrl(code) { return `https://flagcdn.com/w320/${code}.png`; }
  function fmt(n) { return n.toLocaleString("en-US"); }

  function renderRound(q) {
    state.answered = false;
    const screen = $("screen-pop");
    const aFlag = $("pop-a-flag");
    const bFlag = $("pop-b-flag");
    const aName = $("pop-a-name");
    const bName = $("pop-b-name");
    const aPop  = $("pop-a-pop");
    const bPop  = $("pop-b-pop");
    const sides = screen.querySelectorAll(".pop-side");

    aFlag.src = flagUrl(q.a.code);
    bFlag.src = flagUrl(q.b.code);
    aName.textContent = q.a.name;
    bName.textContent = q.b.name;
    aPop.textContent = "";
    bPop.textContent = "";

    sides.forEach((side) => {
      side.classList.remove("is-correct", "is-wrong", "is-muted");
    });

    // Hud
    $("pop-round").textContent = state.index + 1;
    $("pop-total").textContent = state.questions.length;
    $("pop-score").textContent = state.score;
    $("pop-streak").textContent = state.streak;

    // Timer bar
    const bar = $("pop-timer");
    bar.style.transition = "none";
    bar.style.transform = "scaleX(1)";
    requestAnimationFrame(() => {
      bar.style.transition = `transform ${ROUND_MS}ms linear`;
      bar.style.transform = "scaleX(0)";
    });
  }

  function start() {
    reset();
    fetchQuestions(10).then((questions) => {
      state.questions = questions;
      window.App.show("pop");
      bindOnce();
      nextRound();
    }).catch(() => {
      window.UI.toast("Couldn't load questions — try again");
      window.Router.go("/");
    });
  }

  let boundOnce = false;
  function bindOnce() {
    if (boundOnce) return;
    boundOnce = true;
    $("pop-side-a").addEventListener("click", () => onAnswer("a"));
    $("pop-side-b").addEventListener("click", () => onAnswer("b"));
  }

  function nextRound() {
    if (state.index >= state.questions.length) return finish();
    const q = state.questions[state.index];
    state.roundStartedAt = Date.now();
    renderRound(q);
    state.timeoutHandle = setTimeout(() => onAnswer(null), ROUND_MS);
  }

  function onAnswer(picked) {
    if (state.answered) return;
    state.answered = true;
    if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }
    if (window.Sound) window.Sound.play("tap");

    const q = state.questions[state.index];
    const elapsed = Date.now() - state.roundStartedAt;
    const correct = picked === q.correct;

    // Reveal both populations + colorize chosen side.
    $("pop-a-pop").textContent = fmt(q.a.population);
    $("pop-b-pop").textContent = fmt(q.b.population);
    const sideA = $("pop-side-a");
    const sideB = $("pop-side-b");
    if (q.correct === "a") sideA.classList.add("is-correct");
    if (q.correct === "b") sideB.classList.add("is-correct");
    if (picked === "a" && !correct) sideA.classList.add("is-wrong");
    if (picked === "b" && !correct) sideB.classList.add("is-wrong");
    if (picked === "a" && q.correct !== "a") sideB.classList.add("is-muted");
    if (picked === "b" && q.correct !== "b") sideA.classList.add("is-muted");

    if (picked == null) {
      state.results.push("timeout");
      state.streak = 0;
      if (window.Sound) window.Sound.play("wrong");
    } else if (correct) {
      const timeFraction = Math.max(0, 1 - elapsed / ROUND_MS);
      const timeBonus = Math.round(POINTS_TIME_MAX * timeFraction);
      state.streak += 1;
      if (state.streak > state.longestStreak) state.longestStreak = state.streak;
      const streakBonus = Math.min(state.streak * POINTS_STREAK_PER, POINTS_STREAK_MAX);
      state.score += POINTS_BASE + timeBonus + streakBonus;
      state.results.push("correct");
      if (window.Sound) window.Sound.play("correct");
    } else {
      state.streak = 0;
      state.results.push("wrong");
      if (window.Sound) window.Sound.play("wrong");
    }

    // Profile records both countries (the player saw both flags).
    if (window.Profile) {
      window.Profile.recordRound({ continent: q.a.continent, correct, code: q.a.code });
      window.Profile.recordRound({ continent: q.b.continent, correct, code: q.b.code });
    }

    $("pop-score").textContent = state.score;
    $("pop-streak").textContent = state.streak;

    // Auto-advance after a brief pause so the player reads both populations.
    state.advanceHandle = setTimeout(() => {
      state.index += 1;
      nextRound();
    }, REVEAL_PAUSE_MS);
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
      `Population · ${correctCount}/${state.results.length} · ${state.score} pts`;
    wrap.querySelector(".share-btn").onclick = () =>
      window.Share.share(window.Share.format({
        mode: "solo",
        title: "Atlas — Population Showdown",
        results: state.results,
        score: state.score,
        streak: state.longestStreak,
      }), "Atlas");
  }

  function leave() { clearTimers(); }

  window.Games = window.Games || {};
  window.Games.population = {
    id:    "population",
    title: "Population Showdown",
    icon:  "📊",
    start, leave,
  };
})();
