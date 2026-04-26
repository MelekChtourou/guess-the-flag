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
    country: null,           // null = no country selected
  };

  // Tiny in-memory cache of /api/country-summary results keyed by code.
  const countrySummaryCache = new Map();

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
    }
    // Fade the hint text once the user has interacted.
    const hint = $("atlas-hint");
    if (hint) hint.classList.add("is-faded");
  }

  // --- Country state -----------------------------------------------

  // Set when the globe reports a country tap (or null when cleared).
  // We render the country detail card and update state.continent so
  // the games tray's continent filter follows the picked country's
  // region without needing a separate user action.
  async function setCountry(code, name) {
    state.country = code || null;
    const card = $("country-detail-card");
    const contLabel = $("continent-label");

    if (!code) {
      // Clear path — both the country card and any continent label,
      // and tell the globe to dezoom.
      if (card) card.hidden = true;
      if (contLabel) contLabel.hidden = true;
      state.continent = null;
      if (window.Globe) window.Globe.clearSelection();
      return;
    }

    // Hide the continent fallback label if it was up.
    if (contLabel) contLabel.hidden = true;

    // Fade the onboarding hint.
    const hint = $("atlas-hint");
    if (hint) hint.classList.add("is-faded");

    // Show whatever we know immediately, then fill from /api/country-summary.
    const flag = $("cdc-flag");
    const nameEl = $("cdc-name");
    const subEl = $("cdc-sub");
    if (card)   card.hidden = false;
    if (flag)   flag.src = `https://flagcdn.com/w80/${code}.png`;
    if (flag)   flag.alt = `Flag of ${name || code}`;
    if (nameEl) nameEl.textContent = name || code.toUpperCase();
    if (subEl)  subEl.textContent  = "Loading…";

    let summary = countrySummaryCache.get(code);
    if (!summary) {
      try {
        const res = await fetch(`/api/country-summary/${encodeURIComponent(code)}`);
        if (res.ok) summary = await res.json();
      } catch (e) {}
      if (summary) countrySummaryCache.set(code, summary);
    }

    // Drop the response if the user has since switched countries.
    if (state.country !== code) return;

    if (summary) {
      if (nameEl) nameEl.textContent = summary.name || name || code.toUpperCase();
      if (subEl)  subEl.textContent  = formatSubtitle(summary);
      // Auto-derive the continent so the games tray filters to it.
      state.continent = summary.continent || null;
    } else {
      if (subEl) subEl.textContent = "—";
    }
  }

  function formatSubtitle(s) {
    const parts = [];
    if (s.capital) parts.push(s.capital);
    if (typeof s.population === "number") {
      parts.push(formatPop(s.population) + " people");
    }
    if (parts.length === 0 && s.continent) parts.push(s.continent);
    return parts.join(" · ");
  }

  function formatPop(n) {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000)         return (n / 1_000).toFixed(0) + "K";
    return String(n);
  }

  // --- Country picker ----------------------------------------------
  //
  // Lazy-loaded list (one fetch on first open, cached for the session).
  // Search-as-you-type filters by name; Enter / tap selects.

  let countryList = null;        // [{code, name, continent}, ...]
  let pickerRendered = false;    // initial DOM populated?

  async function ensureCountries() {
    if (countryList) return countryList;
    try {
      const res = await fetch("/api/countries");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      countryList = (data.countries || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      countryList = [];
    }
    return countryList;
  }

  function renderPickerList(filter = "") {
    const ul = $("picker-list");
    const empty = $("picker-empty");
    if (!ul) return;
    const q = filter.trim().toLowerCase();
    const items = (countryList || []).filter((c) =>
      !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().startsWith(q),
    );
    if (items.length === 0) {
      ul.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    // Build via innerHTML for one batched paint.
    ul.innerHTML = items.map((c) => `
      <li role="option">
        <button class="picker-row" data-code="${c.code}" data-name="${escapeAttr(c.name)}">
          <img class="picker-flag" loading="lazy" src="https://flagcdn.com/w40/${c.code}.png" alt="" />
          <span class="picker-row-name">${escapeHtml(c.name)}</span>
          <span class="picker-row-region">${escapeHtml(c.continent || "")}</span>
        </button>
      </li>
    `).join("");
  }
  function escapeHtml(s)  { return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function escapeAttr(s)  { return escapeHtml(s); }

  async function openPicker() {
    const modal = $("country-picker");
    const search = $("picker-search");
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    // Lazy-load countries on first open
    if (!pickerRendered) {
      await ensureCountries();
      renderPickerList("");
      pickerRendered = true;
    }
    // Focus input — defer slightly so iOS lifts the keyboard.
    setTimeout(() => { if (search) { search.value = ""; renderPickerList(""); search.focus(); } }, 80);
  }

  function closePicker() {
    const modal = $("country-picker");
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  function pickFromPicker(code, name) {
    closePicker();
    if (!window.Globe || typeof window.Globe.focusCountry !== "function") {
      // Topojson hasn't loaded — fall back to setCountry without zoom.
      setCountry(code, name);
      return;
    }
    const ok = window.Globe.focusCountry(code, name);
    if (!ok) {
      // Country not in our topojson polygons (small/disputed) — at
      // least show the card.
      setCountry(code, name);
    }
  }

  // --- Starfield generator ----------------------------------------
  //
  // Builds two long box-shadow strings — one for "near" stars (slightly
  // bigger + brighter) and one for "far" stars (smaller + dimmer). One
  // 1×1 px element per layer absorbs the whole shadow list, so the cost
  // stays minimal even with hundreds of stars.
  //
  // We size the field generously above viewport so layout shifts /
  // landscape rotation don't reveal seams.

  function generateStarfield() {
    const near = document.getElementById("stars-near");
    const far  = document.getElementById("stars-far");
    if (!near || !far) return;

    // Field extent: be generous so portrait→landscape rotation doesn't
    // expose blank corners. Use viewport units multiplied at boot.
    const W = Math.max(window.innerWidth,  1024);
    const H = Math.max(window.innerHeight, 1024);

    const NEAR_COUNT = 70;       // bigger / brighter
    const FAR_COUNT  = 130;      // smaller / dimmer

    near.style.boxShadow = makeStarShadow(NEAR_COUNT, W, H, [0.55, 0.95]);
    far.style.boxShadow  = makeStarShadow(FAR_COUNT,  W, H, [0.25, 0.6 ]);
  }

  function makeStarShadow(count, w, h, alphaRange) {
    const parts = [];
    for (let i = 0; i < count; i++) {
      const x = Math.floor(Math.random() * w);
      const y = Math.floor(Math.random() * h);
      const a = (alphaRange[0] + Math.random() * (alphaRange[1] - alphaRange[0])).toFixed(2);
      parts.push(`${x}px ${y}px 0 0 rgba(255,255,255,${a})`);
    }
    return parts.join(", ");
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

    // Continent clear button (legacy fallback).
    document.addEventListener("click", (e) => {
      const t = e.target.closest('[data-action="clear-continent"]');
      if (t) {
        e.stopImmediatePropagation();
        if (window.Sound) window.Sound.play("tap");
        setContinent(null);
        if (window.Globe) window.Globe.clearSelection();
      }
    });

    // Country card clear button — same idea but covers the new flow.
    document.addEventListener("click", (e) => {
      const t = e.target.closest('[data-action="clear-country"]');
      if (t) {
        e.stopImmediatePropagation();
        if (window.Sound) window.Sound.play("tap");
        setCountry(null);
      }
    });

    // Open / close country picker.
    document.addEventListener("click", (e) => {
      const open = e.target.closest('[data-action="open-picker"]');
      if (open) {
        e.stopImmediatePropagation();
        if (window.Sound) window.Sound.play("tap");
        openPicker();
        return;
      }
      const close = e.target.closest('[data-action="close-picker"]');
      if (close) {
        e.stopImmediatePropagation();
        closePicker();
        return;
      }
      // Row tap inside the picker → focus that country.
      const row = e.target.closest('.picker-row');
      if (row) {
        e.stopImmediatePropagation();
        if (window.Sound) window.Sound.play("tap");
        pickFromPicker(row.dataset.code, row.dataset.name);
      }
    });

    // Live search filter.
    document.addEventListener("input", (e) => {
      if (e.target && e.target.id === "picker-search") {
        renderPickerList(e.target.value || "");
      }
    });

    // Esc closes the picker; Enter on search picks the first match.
    document.addEventListener("keydown", (e) => {
      const modal = document.getElementById("country-picker");
      if (!modal || modal.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); closePicker(); }
      if (e.key === "Enter" && e.target && e.target.id === "picker-search") {
        const first = document.querySelector('.picker-row');
        if (first) {
          e.preventDefault();
          pickFromPicker(first.dataset.code, first.dataset.name);
        }
      }
    });

    // Wire globe → country card (primary path) and continent label (fallback).
    if (window.Globe && typeof window.Globe.onCountrySelected === "function") {
      window.Globe.onCountrySelected((code, name) => setCountry(code, name));
    }
    if (window.Globe && typeof window.Globe.onContinentSelected === "function") {
      window.Globe.onContinentSelected((id) => setContinent(id));
    }

    // Generate the starfield once at boot — denser than what we can
    // reasonably express in CSS, with two parallax-y layers.
    generateStarfield();

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

  window.Menu = { setMode, setContinent, setCountry, continentFromUrl, refreshDailyQuick, refreshProfileBadge };
})();
