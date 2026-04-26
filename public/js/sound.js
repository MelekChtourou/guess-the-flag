// Synthesized sound effects via the Web Audio API.
//
// No audio assets to download or license — every effect is built from
// oscillators + gain envelopes at runtime. Keeps the project asset-free
// and the experience instant on any network.
//
// The AudioContext is created lazily on the first user gesture (browsers
// block autoplay until then). All effects respect a global mute flag
// persisted in localStorage as `gtf-muted`.

(function () {
  const STORAGE_KEY = "gtf-muted";

  let ctx = null;
  let muted = (() => {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch (e) { return false; }
  })();

  // Lazy AudioContext init. Browsers refuse to start one until a user
  // gesture has happened in the page; we ignore failures gracefully.
  function ensureCtx() {
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      return ctx;
    } catch (e) {
      return null;
    }
  }

  // --- Effect primitives --------------------------------------------

  // Plays a single tone with an attack/decay envelope.
  // freq: Hz, dur: seconds, type: "sine"|"square"|"triangle"|"sawtooth".
  function tone({ freq = 440, dur = 0.15, type = "sine", peak = 0.18, attack = 0.01, decay, when = 0 }) {
    const c = ensureCtx();
    if (!c || muted) return;
    const t0 = c.currentTime + when;
    const t1 = t0 + dur;
    const dec = decay != null ? decay : Math.max(0.02, dur - attack);

    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0005, t0 + attack + dec);

    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t1 + 0.05);
  }

  // Pitch sweep with the same envelope shape — useful for "whoosh" effects.
  function sweep({ from = 200, to = 800, dur = 0.25, type = "sine", peak = 0.18, when = 0 }) {
    const c = ensureCtx();
    if (!c || muted) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // --- The five named effects ---------------------------------------

  const EFFECTS = {
    // Crisp, soft option-tap. Subtle so it's not obnoxious during fast play.
    tap()     { tone({ freq: 660, dur: 0.06, type: "sine", peak: 0.10, attack: 0.005 }); },

    // Ascending C–E–G major arpeggio. Bright, satisfying.
    correct() {
      tone({ freq: 523.25, dur: 0.12, type: "triangle", peak: 0.16, when: 0 });
      tone({ freq: 659.25, dur: 0.12, type: "triangle", peak: 0.16, when: 0.08 });
      tone({ freq: 783.99, dur: 0.22, type: "triangle", peak: 0.18, when: 0.16 });
    },

    // Two-note descending minor. Reads as "nope" without being harsh.
    wrong() {
      tone({ freq: 277.18, dur: 0.15, type: "sine", peak: 0.18 });
      tone({ freq: 233.08, dur: 0.28, type: "sine", peak: 0.18, when: 0.10 });
    },

    // Quick rising sweep — opens the country panel.
    reveal()  { sweep({ from: 220, to: 880, dur: 0.28, type: "sine", peak: 0.12 }); },

    // Major chord stack with delay tail — celebratory but not over the top.
    victory() {
      tone({ freq: 523.25, dur: 0.6,  type: "triangle", peak: 0.14, when: 0 });
      tone({ freq: 659.25, dur: 0.6,  type: "triangle", peak: 0.14, when: 0.05 });
      tone({ freq: 783.99, dur: 0.7,  type: "triangle", peak: 0.16, when: 0.10 });
      tone({ freq: 1046.5, dur: 0.9,  type: "sine",     peak: 0.12, when: 0.18 });
    },
  };

  function play(name) {
    const fn = EFFECTS[name];
    if (fn) fn();
  }

  // --- Mute toggle --------------------------------------------------

  function setMuted(value) {
    muted = !!value;
    try { localStorage.setItem(STORAGE_KEY, muted ? "1" : "0"); } catch (e) {}
    document.documentElement.toggleAttribute("data-muted", muted);
  }

  function isMuted() { return muted; }

  document.addEventListener("DOMContentLoaded", () => {
    // Reflect initial state on <html> so CSS can swap the icon.
    document.documentElement.toggleAttribute("data-muted", muted);
    const btn = document.getElementById("sound-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      setMuted(!muted);
      // Click-feedback ping so the user can hear that they just unmuted.
      if (!muted) play("tap");
    });
  });

  window.Sound = { play, setMuted, isMuted };
})();
