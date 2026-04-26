// Menu controller for the legendary Atlas hub.
//
// Holds two pieces of state:
//   - mode:      "solo" | "multi" | "daily"  (driven by the top mode chips)
//   - continent: "Africa" | "Asia" | ...  | null (driven by tapping the globe)
//
// On tap of a game card it composes those two into the right action:
//   solo  + Flag      → navigate to /flag?continent=Africa
//   multi + (any)     → navigate to /host         (Wave 7 will plumb game choice)
//   daily + Flag      → navigate to /daily
//   daily + non-flag  → toast "Daily for X coming soon"
//
// All clicks are emitted through Router.go() so URLs stay in sync.

(function () {
  const state = {
    mode: "solo",
    continent: null,         // null = worldwide
  };

  function $(id) { return document.getElementById(id); }
  function $$(sel) { return [...document.querySelectorAll(sel)]; }

  // --- Mode chips --------------------------------------------------

  function setMode(mode) {
    state.mode = mode;
    $$(".mode-chip").forEach((c) => {
      const on = c.dataset.mode === mode;
      c.classList.toggle("is-active", on);
      c.setAttribute("aria-selected", String(on));
    });
    // Show extra controls when in Multi mode (e.g. "Join with code").
    const tray = $("tray-multi-actions");
    if (tray) tray.hidden = (mode !== "multi");
    refreshDailyQuick();
    updateGameCardStates();
  }

  function updateGameCardStates() {
    // In Daily mode, only Flag is currently available — dim the others.
    $$(".tray-card[data-game]").forEach((card) => {
      const isFlag = card.dataset.game === "flag";
      const disabled = state.mode === "daily" && !isFlag;
      card.classList.toggle("is-disabled", disabled);
    });
  }

  // --- Continent state ---------------------------------------------

  function setContinent(id) {
    state.continent = id;
    const label = $("continent-label");
    const name  = $("continent-name");
    if (id) {
      label.hidden = false;
      name.textContent = id;
    } else {
      label.hidden = true;
      if (window.Globe) window.Globe.clearSelection();
    }
    // Fade the hint text once the user has interacted.
    const hint = $("atlas-hint");
    if (hint) hint.classList.add("is-faded");
  }

  // --- Daily quick link refresh ------------------------------------

  async function refreshDailyQuick() {
    const link = $("menu-daily-quick");
    const text = $("tray-daily-text");
    if (!link || !text) return;
    try {
      const res = await fetch("/api/daily-questions");
      if (!res.ok) return;
      const data = await res.json();
      const completedToday = window.Profile && window.Profile.dailyCompleted(data.dayNumber);
      if (completedToday) {
        text.textContent = `Daily #${data.dayNumber} — done ✓`;
        link.classList.add("is-done");
      } else {
        text.textContent = `Daily #${data.dayNumber} — play today's challenge`;
        link.classList.remove("is-done");
      }
    } catch (e) { /* network blip — leave default text */ }
  }

  // --- Profile badge -----------------------------------------------

  function refreshProfileBadge() {
    if (!window.Profile) return;
    const s = window.Profile.summary();
    const lvl = $("profile-level");
    if (lvl) lvl.textContent = `Lv. ${s.level}`;
  }

  // --- Game card click dispatcher ----------------------------------
  //
  // Composes mode + continent into a navigation. Continent is currently
  // surfaced as a query string the game controllers respect (see
  // games/flag.js etc — they pass it to /api/*-questions in Wave 7).

  function launchGame(id) {
    if (state.mode === "daily" && id !== "flag") {
      if (window.UI) window.UI.toast(`Daily for ${id} coming soon`);
      return;
    }
    if (state.mode === "multi") {
      // The host's preferred game is queued client-side and sent to the
      // server with `room:setGame` once we're in the lobby. Letting the
      // host change it from the lobby tabs still works.
      if (window.Multiplayer) window.Multiplayer.setGame(id);  // no-op if not yet in room
      // Stash the desired game type on the multi state so it gets sent
      // immediately after room creation.
      if (window.Multiplayer && window.Multiplayer.queueGame) window.Multiplayer.queueGame(id);
      window.Router.go("/host?game=" + encodeURIComponent(id));
      return;
    }
    if (state.mode === "daily") {
      window.Router.go("/daily");
      return;
    }
    // Solo: pass the continent filter as a query param if set.
    const path = "/" + id;
    const url = state.continent
      ? `${path}?continent=${encodeURIComponent(state.continent)}`
      : path;
    window.Router.go(url);
  }

  // Read the continent off the current URL — used by the game controllers
  // to filter their fetch.
  function continentFromUrl() {
    const params = new URLSearchParams(location.search);
    return params.get("continent");
  }

  // --- Boot --------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    // Mode chip clicks.
    $$(".mode-chip").forEach((c) => {
      c.addEventListener("click", () => {
        if (window.Sound) window.Sound.play("tap");
        setMode(c.dataset.mode);
      });
    });

    // Game card clicks (delegated through app.js global handler too —
    // we handle directly here to inject mode + continent context).
    $$(".tray-card[data-game]").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (card.classList.contains("is-disabled")) {
          e.stopImmediatePropagation();
          if (window.UI) window.UI.toast("Not available in this mode yet");
          return;
        }
        // Prevent the global delegated handler from also routing.
        e.stopImmediatePropagation();
        if (window.Sound) window.Sound.play("tap");
        launchGame(card.dataset.game);
      });
    });

    // Continent clear button.
    document.addEventListener("click", (e) => {
      const t = e.target.closest('[data-action="clear-continent"]');
      if (t) {
        e.stopImmediatePropagation();
        if (window.Sound) window.Sound.play("tap");
        setContinent(null);
      }
    });

    // Wire globe → continent label.
    if (window.Globe && typeof window.Globe.onContinentSelected === "function") {
      window.Globe.onContinentSelected((id) => setContinent(id));
    }

    // Auto-fade the onboarding hint after a few seconds even if the user
    // hasn't tapped anywhere yet — keeps the menu uncluttered on long views.
    setTimeout(() => {
      const hint = document.getElementById("atlas-hint");
      if (hint) hint.classList.add("is-faded");
    }, 8000);

    // Initial fill.
    setMode("solo");
    refreshDailyQuick();
    refreshProfileBadge();
  });

  window.Menu = { setMode, setContinent, continentFromUrl, refreshDailyQuick, refreshProfileBadge };
})();
