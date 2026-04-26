// Multiplayer client. Talks to server/gameManager.js over Socket.IO.
//
// One controller drives the multiplayer flow for ALL three games:
//
//   create(name) / join(code, name)         → server confirms, show lobby
//   host clicks a game tab                  → emit room:setGame
//   host clicks "Start"                     → emit game:start
//   server emits 'round:start' (variant)    → dispatch to renderer by gameType
//   player taps an option                   → emit game:answer
//   server emits 'round:end' (variant)      → reveal panel + leaderboard
//   host clicks Next, or auto-advance       → next round
//   after N rounds: game:end                → results screen
//
// The variant comes from data.gameType on every round event:
//   "flag"      → Game.setQuestionStyle("flag")  + 4-option QCM
//   "capital"   → Game.setQuestionStyle("capital") + 4-option QCM
//   "population"→ split-screen A vs B (uses screen-pop's DOM directly)

(function () {
  let socket = null;

  const state = {
    code: null,
    selfId: null,
    hostId: null,
    players: [],
    gameType: "flag",
    pendingGameType: null,    // host's preferred game before the room is in
    inGame: false,
    myPick: null,
    revealDeadline: 0,
    revealTickHandle: null,
  };

  function $(id) { return document.getElementById(id); }

  // --- Socket --------------------------------------------------------

  function ensureSocket() {
    if (socket) return socket;
    socket = io();

    socket.on("connect", () => { state.selfId = socket.id; });

    socket.on("lobby:update", (data) => {
      state.code     = data.code;
      state.hostId   = data.hostId;
      state.players  = data.players;
      state.gameType = data.gameType || "flag";
      renderLobby();
    });

    socket.on("round:start", (data) => {
      state.inGame = true;
      state.gameType = data.gameType || "flag";
      state.myPick = null;
      stopRevealTick();
      const remaining = Math.max(0, data.deadline - Date.now());

      if (state.gameType === "population") {
        // Population uses its own split-screen DOM (screen-pop).
        window.App.show("pop");
        renderPopulationRound(data, remaining);
      } else {
        window.App.show("game");
        window.Game.setQuestionStyle(state.gameType === "capital" ? "capital" : "flag");
        window.Game.updateHud({
          round: data.round,
          total: data.total,
          score: scoreFor(state.selfId),
          streak: 0,
        });
        // Capital ships its prompt as `data.capital`; the engine reads
        // it from question.capital so we pass it along.
        const question = state.gameType === "capital"
          ? { capital: data.capital, options: data.options, flagCode: data.flagCode }
          : { flagCode: data.flagCode, options: data.options };
        window.Game.renderRound(question, {
          deadlineMs: remaining,
          onAnswer: (choice) => {
            state.myPick = choice;
            socket.emit("game:answer", { choice });
          },
        });
      }
    });

    socket.on("round:end", (data) => {
      state.players = data.scores;
      state.revealDeadline = data.deadline || (Date.now() + 12000);

      // Profile recordRound — works for all 3 games (correct: derived
      // from comparing my pick to data.correct).
      const correct = state.myPick === data.correct;
      if (window.Profile) {
        // For Population, both countries were "seen" by the player.
        if (data.gameType === "population") {
          if (data.a) window.Profile.recordRound({ continent: data.a.continent, correct, code: data.a.code });
          if (data.b) window.Profile.recordRound({ continent: data.b.continent, correct, code: data.b.code });
        } else {
          window.Profile.recordRound({
            continent: data.continent,
            correct,
            code: data.flagCode,
          });
        }
      }

      const isHost = state.selfId === state.hostId;
      if (data.gameType === "population") {
        revealPopulation(data);
        // Population doesn't have a Next button at the moment — it
        // auto-advances on the server's REVEAL_DURATION_MS.
        if (isHost) startRevealTick(state.revealDeadline);
      } else {
        // Flag / Capital reuse the standard reveal panel.
        window.Game.updateHud({ score: scoreFor(state.selfId) });
        window.Game.revealAnswer(data.correct, state.myPick, {
          nextLabel: isHost ? "Next round →" : "Waiting for host…",
          nextEnabled: isHost,
        });
        window.Game.onNextClick(() => {
          if (state.selfId === state.hostId) socket.emit("game:next");
        });
        if (isHost) startRevealTick(state.revealDeadline);
      }
    });

    socket.on("game:end", (data) => {
      state.inGame = false;
      stopRevealTick();
      const myScore = scoreFor(state.selfId);
      if (window.Profile) window.Profile.recordGame({ score: myScore });
      if (window.Achievements) window.Achievements.evaluate();
      showResults(data);
    });

    socket.on("disconnect", () => {
      if (state.code) window.UI.toast("Disconnected from server");
    });

    return socket;
  }

  function scoreFor(id) {
    const p = state.players.find((p) => p.id === id);
    return p ? p.score : 0;
  }

  // --- Population MP rendering -------------------------------------
  //
  // We reuse the existing screen-pop DOM (defined for the solo game).
  // We don't import games/population.js — that controller drives its
  // own timer + scoring. In multi the server is authoritative, so we
  // just render and forward the pick.

  function flagUrl(code) { return `https://flagcdn.com/w320/${code}.png`; }
  function fmtPop(n) { return typeof n === "number" ? n.toLocaleString("en-US") : ""; }

  let popHandlersBound = false;

  function renderPopulationRound(data, remainingMs) {
    bindPopOnce();
    const sideA = $("pop-side-a"), sideB = $("pop-side-b");
    sideA.classList.remove("is-correct", "is-wrong", "is-muted");
    sideB.classList.remove("is-correct", "is-wrong", "is-muted");

    $("pop-a-flag").src = flagUrl(data.a.code);
    $("pop-b-flag").src = flagUrl(data.b.code);
    $("pop-a-name").textContent = data.a.name;
    $("pop-b-name").textContent = data.b.name;
    $("pop-a-pop").textContent = "";
    $("pop-b-pop").textContent = "";

    $("pop-round").textContent = data.round;
    $("pop-total").textContent = data.total;
    $("pop-score").textContent = scoreFor(state.selfId);
    $("pop-streak").textContent = 0;

    const bar = $("pop-timer");
    bar.style.transition = "none";
    bar.style.transform  = "scaleX(1)";
    requestAnimationFrame(() => {
      bar.style.transition = `transform ${Math.max(50, remainingMs)}ms linear`;
      bar.style.transform  = "scaleX(0)";
    });
  }

  function bindPopOnce() {
    if (popHandlersBound) return;
    popHandlersBound = true;
    $("pop-side-a").addEventListener("click", () => onPopAnswer("a"));
    $("pop-side-b").addEventListener("click", () => onPopAnswer("b"));
  }

  function onPopAnswer(choice) {
    if (state.myPick != null) return;       // already answered
    state.myPick = choice;
    if (window.Sound) window.Sound.play("tap");
    socket.emit("game:answer", { choice });
  }

  function revealPopulation(data) {
    // Show the populations + colorize sides relative to my pick.
    $("pop-a-pop").textContent = fmtPop(data.a && data.a.population);
    $("pop-b-pop").textContent = fmtPop(data.b && data.b.population);
    const sideA = $("pop-side-a"), sideB = $("pop-side-b");
    if (data.correct === "a") sideA.classList.add("is-correct");
    if (data.correct === "b") sideB.classList.add("is-correct");
    if (state.myPick && state.myPick !== data.correct) {
      (state.myPick === "a" ? sideA : sideB).classList.add("is-wrong");
    }
    if (state.myPick && state.myPick !== data.correct) {
      (state.myPick === "a" ? sideB : sideA).classList.add("is-muted");
    }
    $("pop-score").textContent = scoreFor(state.selfId);
  }

  // --- Reveal countdown tick ---------------------------------------

  function startRevealTick(deadline) {
    stopRevealTick();
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      if (remaining <= 0) {
        if (window.Game) window.Game.setNextButton({ label: "Next round →" });
        stopRevealTick();
        return;
      }
      if (state.gameType !== "population" && window.Game) {
        window.Game.setNextButton({ label: `Next round → (${seconds}s)` });
      }
    };
    tick();
    state.revealTickHandle = setInterval(tick, 250);
  }
  function stopRevealTick() {
    if (state.revealTickHandle) { clearInterval(state.revealTickHandle); state.revealTickHandle = null; }
  }

  // --- Lobby rendering ---------------------------------------------

  function renderLobby() {
    $("lobby-code").textContent = state.code || "----";
    $("lobby-count").textContent = state.players.length;
    const list = $("lobby-players");
    list.innerHTML = "";
    state.players.forEach((p) => {
      const li = document.createElement("li");
      if (p.isHost) li.classList.add("is-host");
      if (p.id === state.selfId) li.classList.add("is-me");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name;
      const scoreSpan = document.createElement("span");
      scoreSpan.className = "player-score";
      scoreSpan.textContent = p.score > 0 ? `${p.score}` : "";
      li.appendChild(nameSpan);
      li.appendChild(scoreSpan);
      list.appendChild(li);
    });

    const isHost = state.selfId === state.hostId;
    // Tabs: visible to everyone (so non-hosts know what's coming) but
    // only the host can change them.
    const tabs = $("lobby-game-tabs");
    if (tabs) {
      tabs.hidden = false;
      [...tabs.querySelectorAll(".lobby-game-tab")].forEach((tab) => {
        tab.classList.toggle("is-active", tab.dataset.game === state.gameType);
        tab.disabled = !isHost;
      });
    }
    // Start button label reflects the picked game.
    const start = $("lobby-start");
    if (start) {
      start.hidden = !isHost;
      const titles = { flag: "Flags", capital: "Capitals", population: "Showdown" };
      start.textContent = `Start: ${titles[state.gameType] || "Game"}`;
    }
    $("lobby-waiting").hidden = isHost;
    // If the host queued a different game type before joining the
    // room, send it now.
    if (isHost && state.pendingGameType && state.pendingGameType !== state.gameType) {
      socket.emit("room:setGame", { gameType: state.pendingGameType });
      state.pendingGameType = null;
    }
  }

  function showResults(data) {
    const winner = data.winner;
    if (winner && winner.id === state.selfId) {
      $("results-tier").textContent = "Victory";
      window.UI.victoryBurst();
      if (window.Sound) window.Sound.play("victory");
    } else if (winner) {
      $("results-tier").textContent = `${winner.name} wins`;
    } else {
      $("results-tier").textContent = "Game over";
    }
    $("results-score").textContent = `${scoreFor(state.selfId)} pts`;
    $("share-card").hidden = true;
    const list = $("results-scores");
    list.hidden = false;
    list.innerHTML = "";
    data.finalScores.forEach((p, i) => {
      const li = document.createElement("li");
      if (p.id === state.selfId) li.classList.add("is-me");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = `${i + 1}. ${p.name}`;
      const scoreSpan = document.createElement("span");
      scoreSpan.className = "player-score";
      scoreSpan.textContent = `${p.score}`;
      li.appendChild(nameSpan);
      li.appendChild(scoreSpan);
      list.appendChild(li);
    });
    window.App.show("results");
  }

  // --- Public API used by the rest of the app ---------------------

  function create(name, gameType) {
    ensureSocket();
    if (gameType) state.pendingGameType = gameType;
    socket.emit("room:create", { name }, (resp) => {
      if (resp && resp.error) {
        window.UI.toast(resp.error);
        window.Router.go("/");
        return;
      }
      window.history.replaceState({ path: `/r/${resp.code}` }, "", `/r/${resp.code}`);
      window.App.show("lobby");
    });
  }

  function join(code, name) {
    ensureSocket();
    socket.emit("room:join", { code, name }, (resp) => {
      if (resp && resp.error) {
        window.UI.toast(resp.error);
        return;
      }
      window.history.replaceState({ path: `/r/${code}` }, "", `/r/${code}`);
      window.App.show("lobby");
    });
  }

  function setGame(gameType) {
    if (!socket || !state.code) return;
    if (state.selfId !== state.hostId) return;
    socket.emit("room:setGame", { gameType });
  }

  function startGame() { if (socket) socket.emit("game:start"); }

  function leave() {
    stopRevealTick();
    if (socket && state.code) socket.emit("room:leave");
    state.code = null;
    state.players = [];
    state.hostId = null;
    state.inGame = false;
    state.gameType = "flag";
    state.pendingGameType = null;
  }

  function isInRoom() { return !!state.code; }
  function isHost()   { return !!state.code && state.selfId === state.hostId; }

  document.addEventListener("DOMContentLoaded", () => {
    $("lobby-start").addEventListener("click", startGame);

    // Game-tab clicks (host only — the renderLobby disables them otherwise).
    document.querySelectorAll(".lobby-game-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        if (window.Sound) window.Sound.play("tap");
        setGame(tab.dataset.game);
      });
    });

    $("lobby-share").addEventListener("click", async () => {
      if (!state.code) return;
      const url = `${location.origin}/r/${state.code}`;
      try {
        await navigator.clipboard.writeText(url);
        window.UI.toast("Link copied");
      } catch {
        window.UI.toast(`Code: ${state.code}`);
      }
    });
  });

  window.Multiplayer = { create, join, startGame, setGame, leave, isInRoom, isHost };
})();
