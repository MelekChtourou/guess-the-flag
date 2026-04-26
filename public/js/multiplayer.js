// Multiplayer client. Talks to server/gameManager.js over Socket.IO.
//
// Lifecycle:
//   create(name) / join(code, name) -> server confirms -> show lobby
//   host clicks "Start" -> 'round:start' arrives -> show game
//   player taps option -> emit 'game:answer'
//   server emits 'round:end' -> open the country detail panel inline;
//     host gets a "Next" button (emits 'game:next'), others see "Waiting…".
//     server auto-advances at the deadline if the host doesn't click.
//   after N rounds, server emits 'game:end' -> show results

(function () {
  let socket = null;

  const state = {
    code: null,
    selfId: null,
    hostId: null,
    players: [],
    inGame: false,
    myPick: null,
    revealDeadline: 0,
    revealTickHandle: null,
  };

  function $(id) { return document.getElementById(id); }

  function ensureSocket() {
    if (socket) return socket;
    socket = io();

    socket.on("connect", () => { state.selfId = socket.id; });

    socket.on("lobby:update", (data) => {
      state.code = data.code;
      state.hostId = data.hostId;
      state.players = data.players;
      renderLobby();
    });

    socket.on("round:start", (data) => {
      state.inGame = true;
      stopRevealTick();
      window.App.show("game");
      window.Game.updateHud({
        round: data.round,
        total: data.total,
        score: scoreFor(state.selfId),
        streak: 0,
      });
      const remaining = Math.max(0, data.deadline - Date.now());
      state.myPick = null;
      window.Game.renderRound(
        { flagCode: data.flagCode, options: data.options },
        {
          deadlineMs: remaining,
          onAnswer: (choice) => {
            state.myPick = choice;
            socket.emit("game:answer", { choice });
          },
        },
      );
    });

    socket.on("round:end", (data) => {
      state.players = data.scores;
      state.revealDeadline = data.deadline || (Date.now() + 12000);
      window.Game.updateHud({ score: scoreFor(state.selfId) });

      // Show reveal panel + correct/wrong highlighting based on our own pick.
      const isHost = state.selfId === state.hostId;
      window.Game.revealAnswer(data.correct, state.myPick, {
        nextLabel: isHost ? "Next round →" : "Waiting for host…",
        nextEnabled: isHost,
      });
      // Host: emit game:next on click. Others: button is disabled.
      window.Game.onNextClick(() => {
        if (state.selfId === state.hostId) socket.emit("game:next");
      });
      // Tick the host's button to show a countdown so the auto-advance is
      // less surprising. Updates roughly every 250ms; doesn't fight the
      // server-side timer.
      if (isHost) startRevealTick(data.deadline);
    });

    socket.on("game:end", (data) => {
      state.inGame = false;
      stopRevealTick();
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

  function startRevealTick(deadline) {
    stopRevealTick();
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      if (remaining <= 0) {
        window.Game.setNextButton({ label: "Next round →" });
        stopRevealTick();
        return;
      }
      window.Game.setNextButton({ label: `Next round → (${seconds}s)` });
    };
    tick();
    state.revealTickHandle = setInterval(tick, 250);
  }
  function stopRevealTick() {
    if (state.revealTickHandle) { clearInterval(state.revealTickHandle); state.revealTickHandle = null; }
  }

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
    $("lobby-start").hidden = !isHost;
    $("lobby-waiting").hidden = isHost;
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

  function create(name) {
    ensureSocket();
    socket.emit("room:create", { name }, (resp) => {
      if (resp && resp.error) {
        window.UI.toast(resp.error);
        window.App.show("menu");
        return;
      }
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
      window.App.show("lobby");
    });
  }

  function startGame() { if (socket) socket.emit("game:start"); }

  function leave() {
    stopRevealTick();
    if (socket && state.code) socket.emit("room:leave");
    state.code = null;
    state.players = [];
    state.hostId = null;
    state.inGame = false;
  }

  function isInRoom() { return !!state.code; }
  function isHost()   { return !!state.code && state.selfId === state.hostId; }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("lobby-start").addEventListener("click", startGame);

    document.getElementById("lobby-share").addEventListener("click", async () => {
      if (!state.code) return;
      const url = `${location.origin}/?room=${state.code}`;
      try {
        await navigator.clipboard.writeText(url);
        window.UI.toast("Link copied");
      } catch {
        window.UI.toast(`Code: ${state.code}`);
      }
    });

    // Deep-link: ?room=ABCD
    const params = new URLSearchParams(location.search);
    const preCode = (params.get("room") || "").toUpperCase();
    if (preCode.length === 4) {
      const codeInput = document.getElementById("join-code-input");
      setTimeout(() => {
        document.querySelector('[data-action="join-room"]').click();
        codeInput.value = preCode;
      }, 50);
    }
  });

  window.Multiplayer = { create, join, startGame, leave, isInRoom, isHost };
})();
