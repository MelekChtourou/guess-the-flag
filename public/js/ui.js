// Small UI helpers — confetti, screen-shake, taunts, toasts, tier labels.
// Pure DOM, no framework. Exposed on window.UI so other scripts can call them.

(function () {
  // Funny one-liners shown after each answer. Picked at random so the same
  // phrase rarely repeats twice in a session.
  const PRAISES = [
    "Geography wizard! 🧙",
    "Were you born holding an atlas?",
    "Cartographers fear you.",
    "Smooth like a UN diplomat.",
    "Flag whisperer 🚩",
    "Big brain energy.",
    "Easy. Too easy.",
    "Your geography teacher would weep.",
  ];

  const TAUNTS = [
    "Did you sleep through 6th grade?",
    "The flag is crying right now.",
    "Bold guess. Wrong, but bold.",
    "Nope. Try again, traveler.",
    "Even Google Maps wouldn't help you.",
    "That country is offended.",
    "Big yikes.",
    "Was that a finger slip? Please say yes.",
  ];

  const TIMEOUT_LINES = [
    "Time's up! ⏰",
    "Too slow!",
    "Snail pace. Pick faster!",
    "Did you fall asleep?",
  ];

  const TIERS = [
    { min: 1300, label: "Flag Legend 👑", emoji: "👑" },
    { min: 1000, label: "Flag Master 🏆", emoji: "🏆" },
    { min: 700,  label: "Pretty good 👍", emoji: "👍" },
    { min: 400,  label: "Getting there 🌱", emoji: "🌱" },
    { min: 0,    label: "Better luck next time 😅", emoji: "😅" },
  ];

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // --- Toast ---------------------------------------------------------
  let toastTimer = null;
  function toast(message, ms = 1800) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), ms);
  }

  // --- Screen shake --------------------------------------------------
  function shake(el) {
    if (!el) return;
    el.classList.remove("shake");
    // Force reflow so the animation restarts even if triggered twice in a row.
    void el.offsetWidth;
    el.classList.add("shake");
  }

  // --- Confetti ------------------------------------------------------
  // CSS-driven falling pieces with varied shape, color, and trajectory.
  // Each piece has a random horizontal drift baked in via CSS variables
  // so the burst feels physical rather than mechanical.
  const CONFETTI_COLORS = ["#f5c77e", "#7ce0b4", "#ec7986", "#9bb4ff", "#e9c8ff", "#ffd97a"];
  const CONFETTI_SHAPES = ["rect", "circle", "ribbon"];

  function confetti(count = 30) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const piece = document.createElement("div");
      const shape = CONFETTI_SHAPES[Math.floor(Math.random() * CONFETTI_SHAPES.length)];
      piece.className = `confetti-piece confetti-${shape}`;
      piece.style.left = Math.random() * 100 + "vw";
      piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      // Per-piece horizontal drift and rotation, exposed as CSS vars so
      // the keyframe in style.css can pick them up.
      const drift = (Math.random() - 0.5) * 30; // ±15vw drift
      const spin  = 360 + Math.random() * 540;  // half- to one-and-a-half spins
      piece.style.setProperty("--drift", drift + "vw");
      piece.style.setProperty("--spin",  spin  + "deg");
      const duration = 1400 + Math.random() * 1400;
      piece.style.animationDuration = duration + "ms";
      piece.style.animationDelay    = Math.random() * 250 + "ms";
      setTimeout(() => piece.remove(), duration + 600);
      frag.appendChild(piece);
    }
    document.body.appendChild(frag);
  }

  // Big victory animation — overlays the screen with a radial sunburst
  // that scales in then fades out. Pure SVG so it's resolution-independent.
  function victoryBurst() {
    // Inline SVG with a soft amber radial fan, plus an extra confetti round.
    const wrap = document.createElement("div");
    wrap.className = "victory-burst";
    wrap.innerHTML = `
      <svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        ${Array.from({ length: 24 }, (_, i) => {
          const angle = (360 / 24) * i;
          return `<rect x="-2" y="-100" width="4" height="60" rx="1" fill="url(#vg)" transform="rotate(${angle})"/>`;
        }).join("")}
        <defs>
          <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#ffe5a0" stop-opacity="0"/>
            <stop offset="60%"  stop-color="#f5c77e" stop-opacity="0.85"/>
            <stop offset="100%" stop-color="#f5c77e" stop-opacity="1"/>
          </linearGradient>
        </defs>
        <circle cx="0" cy="0" r="22" fill="#ffe5a0" opacity="0.85"/>
      </svg>
    `;
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 1600);
    confetti(60);
  }

  // --- Result tier ---------------------------------------------------
  function tierForScore(score) {
    return TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];
  }

  // --- Reactions exposed for game.js --------------------------------
  function praiseLine() { return pick(PRAISES); }
  function tauntLine()  { return pick(TAUNTS); }
  function timeoutLine() { return pick(TIMEOUT_LINES); }

  window.UI = {
    toast,
    shake,
    confetti,
    victoryBurst,
    tierForScore,
    praiseLine,
    tauntLine,
    timeoutLine,
  };
})();
