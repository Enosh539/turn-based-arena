/**
 * =============================================================================
 * TURN-BASED ARENA — server.js
 * Node.js + Express + Socket.io Backend
 * =============================================================================
 * Architecture:
 *  - Express serves static files from /public
 *  - Socket.io handles all real-time game events
 *  - All authoritative game state lives SERVER-SIDE (anti-cheat)
 *  - Simple FIFO matchmaking queue pairs players into private rooms
 * =============================================================================
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── App Setup ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_HP         = 100;
const QUEUE_SLOTS    = 3;   // Each player must queue exactly 3 actions per turn

/**
 * Combat resolution matrix.
 * resolveSlot(playerAction, opponentAction) → { playerDmg, opponentDmg, outcome }
 *
 * Rules:
 *  Attack  > Spell   → 20 DMG to opponent
 *  Defend  > Attack  → 0 DMG to player + 5 spike DMG to attacker
 *  Counter > Defend  → 30 Critical DMG to opponent
 *  Spell   > Counter → 15 Unblockable DMG to opponent
 *  Same    = Clash   → 0 DMG both sides
 */
const ACTIONS = ['Attack', 'Defend', 'Counter', 'Spell'];

/**
 * Resolves a single action slot.
 * @param {string} a - Player's action
 * @param {string} b - Opponent's action
 * @returns {{ dmgToA: number, dmgToB: number, outcomeA: string, outcomeB: string }}
 */
function resolveSlot(a, b) {
  // Clash — same action
  if (a === b) {
    return { dmgToA: 0, dmgToB: 0, outcomeA: 'Clash', outcomeB: 'Clash' };
  }

  // Win/loss table: wins[action] = the action it BEATS
  const beats = {
    Attack:  'Spell',    // Attack beats Spell  → 20 DMG
    Defend:  'Attack',   // Defend beats Attack  → blocks + 5 spike
    Counter: 'Defend',   // Counter beats Defend → 30 Crit DMG
    Spell:   'Counter',  // Spell beats Counter  → 15 Unblockable
  };

  const damage = {
    Attack:  20,
    Defend:  5,    // Spike damage reflected back
    Counter: 30,
    Spell:   15,
  };

  const outcomeLabel = {
    Attack:  'Strike!',
    Defend:  'Spike!',
    Counter: 'Critical!',
    Spell:   'Unblockable!',
  };

  if (beats[a] === b) {
    // Player A wins this slot
    const dmg = damage[a];
    return {
      dmgToA: (a === 'Defend') ? 0 : 0,  // Defend reflects; A takes no damage
      dmgToB: dmg,
      outcomeA: `${outcomeLabel[a]} (+${dmg} DMG dealt)`,
      outcomeB: `Blocked by ${a}`,
    };
  } else {
    // Player B wins this slot (symmetric reverse)
    const dmg = damage[b];
    return {
      dmgToA: dmg,
      dmgToB: (b === 'Defend') ? 0 : 0,
      outcomeA: `Blocked by ${b}`,
      outcomeB: `${outcomeLabel[b]} (+${dmg} DMG dealt)`,
    };
  }
}

// ─── Server State ─────────────────────────────────────────────────────────────
/** @type {string[]} Sockets waiting for a match */
const matchmakingQueue = [];

/**
 * Active game rooms.
 * Key: roomId (string)
 * Value: GameRoom object (see createRoom)
 */
const rooms = {};

/**
 * Maps each socketId → roomId so we can look up a player's room quickly.
 * @type {Map<string, string>}
 */
const playerRoom = new Map();

// ─── Room Factory ────────────────────────────────────────────────────────────
/**
 * Creates a fresh GameRoom object.
 * @param {string} roomId
 * @param {object} p1 - { id: socketId, name: string, character: string }
 * @param {object} p2 - { id: socketId, name: string, character: string }
 */
function createRoom(roomId, p1, p2) {
  return {
    roomId,
    turn: 1,
    players: {
      [p1.id]: {
        socketId:  p1.id,
        name:      p1.name,
        character: p1.character,
        hp:        MAX_HP,
        moves:     null,   // Filled when player locks in (array of 3 strings)
        lockedIn:  false,
      },
      [p2.id]: {
        socketId:  p2.id,
        name:      p2.name,
        character: p2.character,
        hp:        MAX_HP,
        moves:     null,
        lockedIn:  false,
      },
    },
    playerIds: [p1.id, p2.id],
  };
}

// ─── Matchmaking ──────────────────────────────────────────────────────────────
/**
 * Attempts to match the two oldest players in the queue.
 * If successful, creates a room and notifies both players.
 */
function tryMatch() {
  if (matchmakingQueue.length < 2) return;

  const id1 = matchmakingQueue.shift();
  const id2 = matchmakingQueue.shift();

  const socket1 = io.sockets.sockets.get(id1);
  const socket2 = io.sockets.sockets.get(id2);

  // Guard: one or both players may have disconnected while waiting
  if (!socket1 || !socket2) {
    // Re-queue whichever socket is still alive
    if (socket1) matchmakingQueue.unshift(id1);
    if (socket2) matchmakingQueue.unshift(id2);
    return;
  }

  const roomId = uuidv4();

  // Join the Socket.io room
  socket1.join(roomId);
  socket2.join(roomId);

  // Retrieve player meta stored when they joined the queue
  const room = createRoom(roomId, socket1.playerMeta, socket2.playerMeta);
  rooms[roomId] = room;
  playerRoom.set(id1, roomId);
  playerRoom.set(id2, roomId);

  // Build safe, opponent-facing snapshots (no moves leaked)
  const buildSnapshot = (selfId, oppId) => ({
    roomId,
    self: {
      name:      room.players[selfId].name,
      character: room.players[selfId].character,
      hp:        MAX_HP,
    },
    opponent: {
      name:      room.players[oppId].name,
      character: room.players[oppId].character,
      hp:        MAX_HP,
    },
  });

  socket1.emit('matchFound', buildSnapshot(id1, id2));
  socket2.emit('matchFound', buildSnapshot(id2, id1));

  console.log(`[Room ${roomId}] Matched: ${socket1.playerMeta.name} vs ${socket2.playerMeta.name}`);
}

// ─── Turn Resolution ──────────────────────────────────────────────────────────
/**
 * Called when both players have locked in.
 * Resolves all 3 slots, updates HP, checks for game-over, and broadcasts results.
 * @param {string} roomId
 */
function resolveTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const [id1, id2]   = room.playerIds;
  const p1           = room.players[id1];
  const p2           = room.players[id2];

  const slotResults  = [];
  let totalDmgToP1   = 0;
  let totalDmgToP2   = 0;

  // Resolve each of the 3 action slots
  for (let i = 0; i < QUEUE_SLOTS; i++) {
    const result = resolveSlot(p1.moves[i], p2.moves[i]);
    totalDmgToP1 += result.dmgToA;
    totalDmgToP2 += result.dmgToB;

    slotResults.push({
      slot:       i + 1,
      p1Action:   p1.moves[i],
      p2Action:   p2.moves[i],
      outcomeP1:  result.outcomeA,
      outcomeP2:  result.outcomeB,
      dmgToP1:    result.dmgToA,
      dmgToP2:    result.dmgToB,
    });
  }

  // Apply damage (clamp to 0)
  p1.hp = Math.max(0, p1.hp - totalDmgToP1);
  p2.hp = Math.max(0, p2.hp - totalDmgToP2);

  // Reset lock-in state for next turn
  p1.moves    = null;
  p1.lockedIn = false;
  p2.moves    = null;
  p2.lockedIn = false;
  room.turn++;

  // ── Broadcast turn result (each player gets their own perspective) ──────
  const basePayload = {
    turn:        room.turn - 1,
    slotResults,
  };

  // Send to P1
  io.to(id1).emit('turnResult', {
    ...basePayload,
    selfHp:     p1.hp,
    opponentHp: p2.hp,
  });

  // Send to P2
  io.to(id2).emit('turnResult', {
    ...basePayload,
    selfHp:     p2.hp,
    opponentHp: p1.hp,
  });

  console.log(`[Room ${roomId}] Turn ${room.turn - 1} resolved — P1 HP: ${p1.hp} | P2 HP: ${p2.hp}`);

  // ── Check game-over ────────────────────────────────────────────────────
  const p1Dead = p1.hp <= 0;
  const p2Dead = p2.hp <= 0;

  if (p1Dead || p2Dead) {
    let winnerId = null;
    if (p1Dead && p2Dead) {
      winnerId = 'draw';
    } else if (p2Dead) {
      winnerId = id1;
    } else {
      winnerId = id2;
    }

    // Notify each player with their win/loss/draw result
    const sendGameOver = (socketId, opponentId) => {
      let result;
      if (winnerId === 'draw')       result = 'draw';
      else if (winnerId === socketId) result = 'win';
      else                            result = 'loss';

      io.to(socketId).emit('gameOver', {
        result,
        selfHp:     room.players[socketId].hp,
        opponentHp: room.players[opponentId].hp,
        winnerName: winnerId === 'draw'
          ? null
          : room.players[winnerId].name,
      });
    };

    sendGameOver(id1, id2);
    sendGameOver(id2, id1);

    // Clean up room state
    cleanupRoom(roomId);
  }
}

// ─── Room Cleanup ─────────────────────────────────────────────────────────────
function cleanupRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.playerIds.forEach(id => playerRoom.delete(id));
  delete rooms[roomId];
  console.log(`[Room ${roomId}] Cleaned up.`);
}

// ─── Socket.io Event Handlers ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Connect] Socket ${socket.id}`);

  // ── joinQueue ──────────────────────────────────────────────────────────
  // Payload: { name: string, character: string }
  socket.on('joinQueue', ({ name, character }) => {
    // Validate inputs
    if (!name || typeof name !== 'string') return;
    if (!['Enosh', 'Pranish', 'Sohan'].includes(character)) return;

    // Sanitise name
    const safeName = name.trim().slice(0, 20) || 'Unknown';

    // Attach player meta to the socket for later retrieval
    socket.playerMeta = { id: socket.id, name: safeName, character };

    // Don't double-queue
    if (matchmakingQueue.includes(socket.id)) return;

    matchmakingQueue.push(socket.id);
    socket.emit('queueJoined', { message: 'Searching for opponent…' });
    console.log(`[Queue] ${safeName} (${character}) joined. Queue size: ${matchmakingQueue.length}`);

    tryMatch();
  });

  // ── lockIn ─────────────────────────────────────────────────────────────
  // Payload: { moves: string[] } — must be exactly 3 valid actions
  socket.on('lockIn', ({ moves }) => {
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;

    const room   = rooms[roomId];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    // Server-side validation of the submitted moves
    if (!Array.isArray(moves) || moves.length !== QUEUE_SLOTS) {
      socket.emit('error', { message: `You must submit exactly ${QUEUE_SLOTS} actions.` });
      return;
    }

    const allValid = moves.every(m => ACTIONS.includes(m));
    if (!allValid) {
      socket.emit('error', { message: 'Invalid action detected.' });
      return;
    }

    if (player.lockedIn) return; // Ignore duplicate lock-ins

    player.moves    = moves;
    player.lockedIn = true;

    console.log(`[Room ${roomId}] ${player.name} locked in: [${moves.join(', ')}]`);

    // Notify both players that this player has locked (no moves revealed!)
    const [id1, id2] = room.playerIds;
    const opponentId = socket.id === id1 ? id2 : id1;

    socket.emit('lockConfirmed', { message: 'Moves locked! Waiting for opponent…' });
    io.to(opponentId).emit('opponentLocked', { message: 'Opponent has locked in!' });

    // If both players are locked, resolve the turn
    if (room.players[id1].lockedIn && room.players[id2].lockedIn) {
      resolveTurn(roomId);
    }
  });

  // ── disconnect ────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Disconnect] Socket ${socket.id}`);

    // Remove from matchmaking queue if waiting
    const queueIdx = matchmakingQueue.indexOf(socket.id);
    if (queueIdx !== -1) matchmakingQueue.splice(queueIdx, 1);

    // Notify opponent and clean up room if in a game
    const roomId = playerRoom.get(socket.id);
    if (roomId) {
      const room = rooms[roomId];
      if (room) {
        const [id1, id2] = room.playerIds;
        const opponentId = socket.id === id1 ? id2 : id1;
        io.to(opponentId).emit('opponentDisconnected', {
          message: 'Your opponent disconnected. You win!',
        });
      }
      cleanupRoom(roomId);
    }
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n⚔️  Turn-Based Arena server running at http://localhost:${PORT}\n`);
});
