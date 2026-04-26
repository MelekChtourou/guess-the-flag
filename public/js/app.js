// Top-level app glue.
//
// Single-page app on top of the History-API router (router.js):
//   - All navigation goes through Router.go(path), which updates the
//     URL and dispatches to the right mode controller.
//   - App.show(name) is the low-level screen swap, used by mode
//     controllers for in-flight transitions (lobby → game → results)
//     that don't get their own URL.
//   - data-action="..." attributes on buttons drive both menu navigation
//     and in-screen actions like "play again".
//
// The router decides when to start/leave Solo, Daily, and Multiplayer.
// app.js no longer calls .start() directly from a click handler.

(function () {
  const SCREENS = ["menu", "nickname", "lobby", "game", "pop", "round-end", "results", "stats"];

  // Internal screen swap. Mode controllers call this for non-routed
  // transitions (e.g. multiplayer.js calls App.show("lobby") on join).
  function show(name) {
    SCREENS.forEach((s) => {
      const el = document.getElementById(`screen-${s}`);
      if (!el) return;
      el.classList.toggle("screen-active", s === name);
    });
    if (name === "menu" && window.Profile)  refreshProfileBadge();
    if (name === "menu" && window.Daily)    window.Daily.refreshMenuCard();
    if (name === "stats" && window.Profile) renderStatsScreen();
    // Scroll back to top whenever we land on a new screen — small
    // touch that fixes the "why is the page scrolled" oddity when
    // jumping from a long results panel back to the menu.
    window.scrollTo(0, 0);
  }

  function refreshProfileBadge() {
    const s = window.Profile.summary();
    const lvl = document.getElementById("profile-level");
    const sum = document.getElementById("profile-summary");
    if (lvl) lvl.textContent = `Lv. ${s.level}`;
    if (sum) sum.textContent = `${s.totalCorrect} correct`;
  }

  function renderStatsScreen() {
    const p = window.Profile.get();
    const lvl = window.Profile.level(p.xp);
    document.getElementById("stats-level").textContent = `Lv. ${lvl}`;
    document.getElementById("stats-xp").textContent = `${p.xp.toLocaleString("en-US")} XP`;
    document.getElementById("stats-best").textContent = p.bestScore;
    document.getElementById("stats-streak").textContent = p.longestStreak;
    document.getElementById("stats-daily-streak").textContent = p.daily.currentStreak;
    document.getElementById("stats-total-correct").textContent = p.totalCorrect;

    const continents = ["Africa", "Asia", "Europe", "North America", "South America", "Oceania"];
    const wrap = document.getElementById("stats-continents");
    wrap.innerHTML = "";
    continents.forEach((name) => {
      const stat = p.perContinent[name] || { correct: 0, total: 0 };
      const pct = stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0;
      const row = document.createElement("div");
      row.className = "stats-continent";
      row.innerHTML = `
        <div class="stats-continent-bar" style="width: ${pct}%"></div>
        <span class="stats-continent-name">${name}</span>
        <span class="stats-continent-value">${stat.correct}/${stat.total}</span>
      `;
      wrap.appendChild(row);
    });

    // Collection counter (unique flags seen / total in dataset).
    const seenCount = window.Profile.seenCount();
    const total = window.Achievements ? window.Achievements.TOTAL_COUNTRIES : 150;
    document.getElementById("stats-seen-count").textContent = `${seenCount} / ${total}`;
    document.getElementById("stats-seen-bar").style.width = `${Math.min(100, (seenCount / total) * 100)}%`;

    // Achievements grid — locked vs unlocked, locked are dimmed.
    const ach = window.Achievements ? window.Achievements.list() : [];
    const unlockedCount = ach.filter((a) => p.achievements[a.id]).length;
    document.getElementById("stats-ach-count").textContent = `${unlockedCount} / ${ach.length}`;
    const aw = document.getElementById("stats-achievements");
    aw.innerHTML = "";
    ach.forEach((a) => {
      const unlocked = !!p.achievements[a.id];
      const tile = document.createElement("div");
      tile.className = "stats-ach" + (unlocked ? "" : " is-locked");
      tile.innerHTML = `
        <div class="stats-ach-icon">${a.icon}</div>
        <div class="stats-ach-meta">
          <div class="stats-ach-title">${a.title}</div>
          <div class="stats-ach-desc">${a.desc}</div>
        </div>
      `;
      aw.appendChild(tile);
    });
  }

  // --- Nickname screen modes (used for /host and /join) -------------
  let pendingAction = null;

  function openNickname(action, opts = {}) {
    pendingAction = action;
    const title = document.getElementById("nickname-title");
    const extra = document.getElementById("nickname-extra");
    const codeInput = document.getElementById("join-code-input");
    const nick = document.getElementById("nickname-input");

    if (action === "create-room") {
      title.textContent = "Pick a nickname";
      extra.hidden = true;
    } else if (action === "join-room") {
      title.textContent = "Join a room";
      extra.hidden = false;
      codeInput.value = (opts.code || "").toUpperCase();
    }
    show("nickname");
    setTimeout(() => nick.focus(), 100);
  }

  function commitNickname() {
    const nickname = document.getElementById("nickname-input").value.trim();
    const code = document.getElementById("join-code-input").value.trim().toUpperCase();
    if (!nickname) {
      window.UI.toast("Pick a nickname first");
      return;
    }
    if (pendingAction === "create-room") {
      // Pass through the desired game type if the URL carried it
      // (e.g. /host?game=capital from the menu's Multi-mode tap).
      const gameType = new URLSearchParams(location.search).get("game");
      window.Multiplayer.create(nickname, gameType);
    } else if (pendingAction === "join-room") {
      if (code.length !== 4) {
        window.UI.toast("Room code is 4 letters");
        return;
      }
      window.Multiplayer.join(code, nickname);
    }
  }

  // --- Boot ----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    // Force room-code input to uppercase as the user types.
    const codeInput = document.getElementById("join-code-input");
    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    });

    // Submit on Enter from any nickname input.
    document.getElementById("nickname-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") commitNickname();
    });
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commitNickname();
    });
    document.getElementById("nickname-go").addEventListener("click", commitNickname);

    // Delegated click handler for any [data-action] element. All routes
    // are pushed through Router.go so the URL stays in sync with the UI.
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action]");
      if (!t) return;
      const action = t.dataset.action;
      if (window.Sound) window.Sound.play("tap");

      switch (action) {
        // Hub-card click — drives any registered mini-game by id.
        case "game": {
          const id = t.dataset.game;
          if (id) window.Router.go("/" + id);
          break;
        }
        case "solo":           window.Router.go("/flag"); break;
        case "daily":          window.Router.go("/daily"); break;
        case "stats":          window.Router.go("/stats"); break;
        case "create-room":    window.Router.go("/host"); break;
        case "join-room":      window.Router.go("/join"); break;
        case "back":
          if (history.length > 1 && document.referrer) history.back();
          else window.Router.go("/");
          break;
        case "back-to-menu":   window.Router.go("/"); break;
        case "play-again":
          if (window.Multiplayer.isInRoom()) {
            show("lobby");
            if (window.Multiplayer.isHost()) {
              window.Multiplayer.startGame();
            } else {
              window.UI.toast("Waiting for the host…");
            }
          } else {
            // Re-enter whatever game route brought us here so the
            // controller restarts cleanly. Default to /flag.
            const path = location.pathname.match(/^\/(daily|flag|capital|population)/)?.[0] || "/flag";
            window.Router.handle(path);
          }
          break;
      }
    });

    // Boot the router last — it'll pick up the current location and
    // dispatch (e.g. landing on /stats or /r/ABCD directly works).
    window.Router.init();
  });

  window.App = { show, openNickname };
})();
