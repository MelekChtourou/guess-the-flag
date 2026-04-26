// Top-level app glue:
//   - Show/hide screens (the SPA "router")
//   - Wire up menu / nickname / shared back-buttons
//   - Hand off to Solo or Multiplayer controllers based on user choice

(function () {
  const SCREENS = ["menu", "nickname", "lobby", "game", "round-end", "results", "stats"];

  // --- Routing -------------------------------------------------------
  function show(name) {
    SCREENS.forEach((s) => {
      const el = document.getElementById(`screen-${s}`);
      if (!el) return;
      el.classList.toggle("screen-active", s === name);
    });
    // Refresh derived UI on certain screens.
    if (name === "menu" && window.Profile)  refreshProfileBadge();
    if (name === "menu" && window.Daily)    window.Daily.refreshMenuCard();
    if (name === "stats" && window.Profile) renderStatsScreen();
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

    // Continent rows — one per known continent, with a progress bar.
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
  }

  // --- Nickname screen modes ----------------------------------------
  // Reused for both "create room" (just nickname) and "join room"
  // (nickname + room code). `pendingAction` decides which.
  let pendingAction = null;

  function openNicknameScreen(action) {
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
      codeInput.value = "";
    }
    nick.value = nick.value || "";
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
      window.Multiplayer.create(nickname);
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

    // Delegated handler for any [data-action] button.
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action]");
      if (!t) return;
      const action = t.dataset.action;
      // Tactile click feedback on every menu / nav action.
      if (window.Sound) window.Sound.play("tap");

      if (action === "solo")          window.Solo.start();
      else if (action === "daily")      window.Daily.start();
      else if (action === "stats")      show("stats");
      else if (action === "create-room") openNicknameScreen("create-room");
      else if (action === "join-room")   openNicknameScreen("join-room");
      else if (action === "back-to-menu") {
        window.Solo.leave();
        if (window.Daily) window.Daily.leave();
        window.Multiplayer.leave();
        show("menu");
      }
      else if (action === "play-again") {
        if (window.Multiplayer.isInRoom()) {
          // Multiplayer rematch: only the host can start; others wait in lobby.
          window.App.show("lobby");
          if (window.Multiplayer.isHost()) {
            window.Multiplayer.startGame();
          } else {
            window.UI.toast("Waiting for the host…");
          }
        } else {
          window.Solo.start();
        }
      }
    });

    show("menu");
  });

  window.App = { show };
})();
