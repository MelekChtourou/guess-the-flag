// Shared game-rendering logic, used by both solo and multiplayer modes.
//
// Both modes share the same DOM (the #screen-game section). What differs
// is who advances rounds and who scores:
//
//   Solo:        client controls the round timer and computes its own
//                score (see solo.js). The Next button is always enabled.
//
//   Multiplayer: server tells the client when each round starts/ends and
//                what the scores are (see multiplayer.js). The Next
//                button is host-only and emits a server event.
//
// Game.renderRound starts a fresh round.
// Game.revealAnswer paints the answer + opens the country detail panel.
// Game.onNextClick lets the mode controller hook the Next button.

(function () {
  const ROUND_MS_DEFAULT = 15000;
  const els = {};

  function $(id) { return document.getElementById(id); }
  function init() {
    els.flag         = $("flag-img");
    els.options      = $("options");
    els.timer        = $("timer-bar");
    els.timerWrap    = document.querySelector(".timer-wrap");
    els.flagStage    = document.querySelector(".flag-stage");
    els.capitalStage = $("capital-stage");
    els.capitalText  = $("capital-text");
    els.round        = $("hud-round");
    els.total        = $("hud-total");
    els.score        = $("hud-score");
    els.streak       = $("hud-streak");
    els.reaction     = $("reaction");
    els.stage        = $("screen-game");
    els.next         = $("cp-next");

    els.next.addEventListener("click", () => {
      if (window.Sound) window.Sound.play("tap");
      if (typeof nextHandler === "function") nextHandler();
    });
  }

  // The "stimulus" — the visual the player has to identify. Different
  // mini-games swap this between flag image, capital city name, etc.
  // Defaults to "flag" for back-compat.
  let questionStyle = "flag";
  function setQuestionStyle(style) { questionStyle = style; }

  function flagUrl(code) { return `https://flagcdn.com/w320/${code}.png`; }

  let currentButtons = [];
  let currentTimerHandle = null;
  let answered = false;
  let nextHandler = null;
  // Stash of the current question so revealAnswer can populate the panel.
  let currentQuestion = null;
  let currentRegion = null;

  function clearTimer() {
    if (currentTimerHandle) {
      cancelAnimationFrame(currentTimerHandle);
      currentTimerHandle = null;
    }
    if (els.timer) {
      els.timer.style.transition = "none";
      els.timer.style.transform = "scaleX(1)";
    }
  }

  function renderRound(question, opts = {}) {
    if (!els.flag) init();
    const { onAnswer = () => {}, deadlineMs = ROUND_MS_DEFAULT, region = null } = opts;

    answered = false;
    currentQuestion = question;
    currentRegion = region;
    els.reaction.textContent = "";

    // Hide the country panel from the previous round; show the play UI.
    window.Country.hide();
    els.options.style.display = "";
    els.timerWrap.style.display = "";

    // Show whichever stimulus stage matches the current style.
    if (questionStyle === "capital") {
      els.flagStage.style.display = "none";
      if (els.capitalStage) els.capitalStage.style.display = "";
      if (els.capitalText) {
        els.capitalText.textContent = question.capital;
        els.capitalText.style.animation = "none";
        void els.capitalText.offsetWidth;
        els.capitalText.style.animation = "";
      }
    } else {
      els.flagStage.style.display = "";
      if (els.capitalStage) els.capitalStage.style.display = "none";
      els.flag.src = flagUrl(question.flagCode);
      els.flag.alt = "Flag to guess";
      els.flag.style.animation = "none";
      void els.flag.offsetWidth;
      els.flag.style.animation = "";
    }

    // Build options
    els.options.innerHTML = "";
    currentButtons = question.options.map((name) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option";
      btn.textContent = name;
      btn.addEventListener("click", () => {
        if (answered) return;
        answered = true;
        if (window.Sound) window.Sound.play("tap");
        onAnswer(name);
      });
      els.options.appendChild(btn);
      return btn;
    });

    clearTimer();
    requestAnimationFrame(() => {
      els.timer.style.transition = `transform ${deadlineMs}ms linear`;
      els.timer.style.transform  = "scaleX(0)";
    });
  }

  function disableOptions() {
    answered = true;
    currentButtons.forEach((b) => (b.disabled = true));
  }

  // Open the reveal panel after a player has answered (or time expired).
  // The mode controller decides what the Next button does — solo advances
  // immediately, multiplayer host emits a server event.
  function revealAnswer(correctName, pickedName, opts = {}) {
    disableOptions();
    clearTimer();

    let correctEl = null;
    let pickedEl = null;
    currentButtons.forEach((b) => {
      if (b.textContent === correctName) correctEl = b;
      if (b.textContent === pickedName)  pickedEl  = b;
      if (b !== correctEl && b !== pickedEl) b.classList.add("is-muted");
    });
    if (correctEl) correctEl.classList.add("is-correct");

    let line;
    if (pickedName == null) {
      line = window.UI.timeoutLine();
      window.UI.shake(els.stage);
      if (window.Sound) window.Sound.play("wrong");
    } else if (pickedName === correctName) {
      line = window.UI.praiseLine();
      window.UI.confetti(20);
      if (window.Sound) window.Sound.play("correct");
    } else {
      if (pickedEl) pickedEl.classList.add("is-wrong");
      line = window.UI.tauntLine();
      window.UI.shake(els.stage);
      if (window.Sound) window.Sound.play("wrong");
    }
    els.reaction.textContent = line;
    // Sweep when the country panel slides up — a small sense of "opening".
    if (window.Sound) setTimeout(() => window.Sound.play("reveal"), 220);

    // Show the country detail panel below the play area.
    if (currentQuestion) {
      window.Country.show({
        code: currentQuestion.flagCode,
        name: correctName,
        region: currentRegion,
        fact: currentQuestion.fact,
      });
    }

    // Defaults for the Next button — controllers can override per-mode.
    const { nextEnabled = true, nextLabel = "Next →", nextHidden = false } = opts;
    els.next.disabled = !nextEnabled;
    els.next.textContent = nextLabel;
    els.next.hidden = nextHidden;
  }

  function onNextClick(handler) { nextHandler = handler; }

  function setNextButton({ enabled, label, hidden } = {}) {
    if (label   != null) els.next.textContent = label;
    if (enabled != null) els.next.disabled = !enabled;
    if (hidden  != null) els.next.hidden = hidden;
  }

  function updateHud({ round, total, score, streak }) {
    if (!els.round) init();
    if (round  != null) els.round.textContent  = round;
    if (total  != null) els.total.textContent  = total;
    if (score  != null) els.score.textContent  = score;
    if (streak != null) els.streak.textContent = streak;
  }

  window.Game = {
    renderRound,
    revealAnswer,
    updateHud,
    flagUrl,
    onNextClick,
    setNextButton,
    setQuestionStyle,
    ROUND_MS_DEFAULT,
  };
})();
