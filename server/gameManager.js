// Multiplayer room manager. Owns all in-memory game state.
//
// Rooms are identified by a 4-letter code. State lives in this module's
// closure — restart the server and rooms are gone (intentional: this is a
// casual party game, not something that needs persistence).
//
// All scoring / round timing is server-authoritative. Clients tell us
// "I picked option X"; we decide if it was right and how many points.

const { buildQuestionSet } = require("./questions");

// --- Constants -------------------------------------------------------

const TOTAL_ROUNDS       = 10;
const ROUND_DURATION_MS  = 15000;
// Generous reveal window so everyone has time to read the country panel
// (capital, population, photo, intro). The host can advance early via
// 'game:next'; otherwise we auto-advance at this deadline.
const REVEAL_DURATION_MS = 12000;
const MAX_PLAYERS        = 8;
const NICKNAME_MAX_LEN   = 14;
const ROOM_CODE_LEN      = 4;
const ROOM_TIMEOUT_MS    = 30 * 60 * 1000; // GC empty rooms after 30 min

// O/0 and I/1 omitted to keep verbal sharing painless.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

// --- Scoring (matches solo.js intent) -------------------------------

const POINTS_BASE         = 100;
const POINTS_TIME_MAX     = 50;
const POINTS_STREAK_PER   = 10;
const POINTS_STREAK_MAX   = 50;

// --- Internal state -------------------------------------------------

/** @typedef {{ name: string, score: number, streak: number, lastAnswer: ?string, answerAt: ?number, socketId: string }} Player */
/** @typedef {{ code: string, hostId: string, players: Map<string, Player>, status: 'waiting'|'playing'|'reveal'|'finished', round: number, questions: any[], roundStartedAt: number, roundTimer: ?NodeJS.Timeout, gcAt: number }} Room */
const rooms = /** @type {Map<string, Room>} */ (new Map());

// Reverse index: socketId -> roomCode, for fast disconnect handling.
const socketIndex = new Map();

// Periodic GC for abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && now > room.gcAt) {
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

// --- Helpers --------------------------------------------------------

function generateCode() {
  // Loop until we find a code not already in use. ~330k possibilities,
  // collision is essentially impossible at any plausible scale.
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not allocate a unique room code");
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, NICKNAME_MAX_LEN);
}

function publicPlayerList(room) {
  // Stable order: by score desc then name asc, so the leaderboard
  // never re-shuffles unexpectedly between events.
  return [...room.players.values()]
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.socketId,
      name: p.name,
      score: p.score,
      isHost: p.socketId === room.hostId,
    }));
}

function emitLobby(io, room) {
  io.to(room.code).emit("lobby:update", {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayerList(room),
    status: room.status,
  });
}

// --- Room lifecycle -------------------------------------------------

function createRoom(socket, name) {
  const cleanName = sanitizeName(name) || "Player";
  const code = generateCode();
  const room = {
    code,
    hostId: socket.id,
    players: new Map(),
    status: "waiting",
    round: 0,
    questions: [],
    roundStartedAt: 0,
    roundTimer: null,
    gcAt: Date.now() + ROOM_TIMEOUT_MS,
  };
  room.players.set(socket.id, {
    name: cleanName,
    score: 0,
    streak: 0,
    lastAnswer: null,
    answerAt: null,
    socketId: socket.id,
  });
  rooms.set(code, room);
  socketIndex.set(socket.id, code);
  socket.join(code);
  return room;
}

function joinRoom(socket, code, name) {
  const room = rooms.get((code || "").toUpperCase());
  if (!room) return { error: "Room not found" };
  if (room.status !== "waiting") return { error: "Game already started" };
  if (room.players.size >= MAX_PLAYERS) return { error: "Room is full" };
  if (socketIndex.has(socket.id)) return { error: "Already in a room" };

  const cleanName = sanitizeName(name) || "Player";
  // Disambiguate duplicate names ("Sam" / "Sam (2)").
  let finalName = cleanName;
  const existingNames = new Set([...room.players.values()].map((p) => p.name));
  let suffix = 2;
  while (existingNames.has(finalName)) {
    finalName = `${cleanName} (${suffix++})`;
  }

  room.players.set(socket.id, {
    name: finalName,
    score: 0,
    streak: 0,
    lastAnswer: null,
    answerAt: null,
    socketId: socket.id,
  });
  socketIndex.set(socket.id, room.code);
  socket.join(room.code);
  return { room };
}

function leaveRoom(io, socket) {
  const code = socketIndex.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketIndex.delete(socket.id);
  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(code);

  if (room.players.size === 0) {
    // Don't delete immediately — host might be reloading. GC handles it.
    if (room.roundTimer) clearTimeout(room.roundTimer);
    room.gcAt = Date.now() + ROOM_TIMEOUT_MS;
    return;
  }

  // Reassign host if the host left.
  if (socket.id === room.hostId) {
    room.hostId = room.players.keys().next().value;
  }

  emitLobby(io, room);

  // If we were mid-game and only one player remains, fast-forward to results.
  if ((room.status === "playing" || room.status === "reveal") && room.players.size <= 1) {
    finishGame(io, room);
  }
}

// --- Game flow ------------------------------------------------------

function startGame(io, socket) {
  const code = socketIndex.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (!room || room.hostId !== socket.id) return;
  if (room.status !== "waiting") return;
  if (room.players.size < 1) return;

  room.questions = buildQuestionSet(TOTAL_ROUNDS);
  room.round = 0;
  for (const p of room.players.values()) {
    p.score = 0;
    p.streak = 0;
  }
  startRound(io, room);
}

function startRound(io, room) {
  room.status = "playing";
  const question = room.questions[room.round];
  room.roundStartedAt = Date.now();
  for (const p of room.players.values()) {
    p.lastAnswer = null;
    p.answerAt = null;
  }

  // Send the question without the correct answer — server is authoritative.
  io.to(room.code).emit("round:start", {
    round: room.round + 1,
    total: room.questions.length,
    flagCode: question.flagCode,
    options: question.options,
    deadline: room.roundStartedAt + ROUND_DURATION_MS,
  });

  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => endRound(io, room), ROUND_DURATION_MS);
}

function submitAnswer(io, socket, choice) {
  const code = socketIndex.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  const player = room.players.get(socket.id);
  if (!player || player.lastAnswer != null) return;

  const question = room.questions[room.round];
  // Reject answers that aren't one of the offered options (cheap input check).
  if (!question.options.includes(choice)) return;

  player.lastAnswer = choice;
  player.answerAt = Date.now();

  // If everyone has answered, end the round early.
  let allAnswered = true;
  for (const p of room.players.values()) {
    if (p.lastAnswer == null) { allAnswered = false; break; }
  }
  if (allAnswered) {
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
    endRound(io, room);
  }
}

function endRound(io, room) {
  room.status = "reveal";
  const question = room.questions[room.round];

  // Score every player based on their recorded answer + timing.
  for (const p of room.players.values()) {
    if (p.lastAnswer === question.correct) {
      const elapsed = (p.answerAt || room.roundStartedAt + ROUND_DURATION_MS) - room.roundStartedAt;
      const timeFraction = Math.max(0, 1 - elapsed / ROUND_DURATION_MS);
      const timeBonus = Math.round(POINTS_TIME_MAX * timeFraction);
      p.streak += 1;
      const streakBonus = Math.min(p.streak * POINTS_STREAK_PER, POINTS_STREAK_MAX);
      p.score += POINTS_BASE + timeBonus + streakBonus;
    } else {
      p.streak = 0;
    }
  }

  io.to(room.code).emit("round:end", {
    round:     room.round + 1,
    total:     room.questions.length,
    correct:   question.correct,
    flagCode:  question.flagCode,
    continent: question.continent,
    fact:      question.fact,
    scores:    publicPlayerList(room),
    deadline:  Date.now() + REVEAL_DURATION_MS,
  });

  // Auto-advance after the reveal window so a distracted host can't stall.
  room.roundTimer = setTimeout(() => advanceRound(io, room), REVEAL_DURATION_MS);
}

function advanceRound(io, room) {
  if (room.status !== "reveal") return;  // already moved on
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  room.round += 1;
  if (room.round >= room.questions.length) {
    finishGame(io, room);
  } else {
    startRound(io, room);
  }
}

function nextRound(io, socket) {
  // Host-only manual advance during the reveal phase.
  const code = socketIndex.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (!room || room.hostId !== socket.id) return;
  if (room.status !== "reveal") return;
  advanceRound(io, room);
}

function finishGame(io, room) {
  room.status = "finished";
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  const scores = publicPlayerList(room);
  io.to(room.code).emit("game:end", {
    finalScores: scores,
    winner: scores[0] || null,
  });
  // Reset to lobby state so host can start a new game without rejoining.
  room.status = "waiting";
  room.round = 0;
  room.questions = [];
  for (const p of room.players.values()) {
    p.score = 0;
    p.streak = 0;
    p.lastAnswer = null;
    p.answerAt = null;
  }
}

// --- Socket wiring --------------------------------------------------

function registerSocketHandlers(io) {
  io.on("connection", (socket) => {

    socket.on("room:create", ({ name } = {}, ack) => {
      if (socketIndex.has(socket.id)) {
        if (typeof ack === "function") ack({ error: "Already in a room" });
        return;
      }
      const room = createRoom(socket, name);
      if (typeof ack === "function") ack({ code: room.code });
      emitLobby(io, room);
    });

    socket.on("room:join", ({ code, name } = {}, ack) => {
      const result = joinRoom(socket, code, name);
      if (result.error) {
        if (typeof ack === "function") ack({ error: result.error });
        return;
      }
      if (typeof ack === "function") ack({ code: result.room.code });
      emitLobby(io, result.room);
    });

    socket.on("room:leave", () => {
      leaveRoom(io, socket);
    });

    socket.on("game:start", () => {
      startGame(io, socket);
    });

    socket.on("game:answer", ({ choice } = {}) => {
      submitAnswer(io, socket, choice);
    });

    socket.on("game:next", () => {
      nextRound(io, socket);
    });

    socket.on("disconnect", () => {
      leaveRoom(io, socket);
    });
  });
}

module.exports = { registerSocketHandlers };
