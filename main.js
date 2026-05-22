/**
 * =============================================================================
 * TURN-BASED ARENA — main.js
 * Vanilla JS Client Logic + Socket.io Event Handling
 * =============================================================================
 * State machine:
 *   character-select → lobby (matchmaking) → arena (in-game) → game-over
 *
 * All authoritative game state lives on the server.
 * The client only manages:
 *   - UI state (current screen, selected moves)
 *   - Local player metadata (name, character)
 *   - Display values mirrored from server events
 * =============================================================================
 */

// ─── Socket.io Connection ─────────────────────────────────────────────────────
const socket = io();

// ─── Character Metadata ───────────────────────────────────────────────────────
const CHARACTER_META = {
  Enosh:   { emoji: '🗡️', color: '#1abc9c' },
  Pranish: { emoji: '🔥', color: '#c0392b' },
  Sohan:   { emoji: '🛡️', color: '#8b5cf6' },
};

const ACTION_META = {
  Attack:  { icon: '⚔️', label: 'Attack' },
  Defend:  { icon: '🛡️', label: 'Defend' },
  Counter: { icon: '⚡', label: 'Counter' },
  Spell:   { icon: '✨', label: 'Spell'  },
};

// ─── Local Client State ───────────────────────────────────────────────────────
const state = {
  playerName:   '',
  character:    null,          // 'Enosh' | 'Pranish' | 'Sohan'
  roomId:       null,
  selectedMoves: [],           // Up to 3 actions queued locally
  isLockedIn:   false,
  opponentLocked: false,
  selfHp:       100,
  opponentHp:   100,
  turn:         1,
};

// ─── DOM References ───────────────────────────────────────────────────────────
const screens = {
  character: document.getElementById('screen-character'),
  lobby:     document.getElementById('screen-lobby'),
  arena:     document.getElementById('screen-arena'),
  gameover:  document.getElementById('screen-gameover'),
};

const $  = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// Character Screen
const playerNameInput  = $('player-name-input');
const btnEnterArena    = $('btn-enter-arena');
const charCards        = $$('.char-card');

// Lobby Screen
const lobbyStatusText  = $('lobby-status-text');
const lobbyAvatar      = $('lobby-avatar');
const lobbyPlayerName  = $('lobby-player-name');
const lobbyCharName    = $('lobby-char-name');

// Arena Screen
const hudSelfName      = $('hud-self-name');
const hudSelfChar      = $('hud-self-char');
const hudOppName       = $('hud-opp-name');
const hudOppChar       = $('hud-opp-char');
const hpBarSelf        = $('hp-bar-self');
const hpBarOpp         = $('hp-bar-opp');
const hpValSelf        = $('hp-val-self');
const hpValOpp         = $('hp-val-opp');
const turnCounter      = $('turn-counter');
const panelSelfAvatar  = $('panel-self-avatar');
const panelSelfChar    = $('panel-self-char');
const panelOppAvatar   = $('panel-opp-avatar');
const panelOppChar     = $('panel-opp-char');
const oppLockIndicator = $('opp-lock-indicator');
const actionButtons    = $$('.action-btn');
const queueSlots       = $$('.queue-slot');
const statusBanner     = $('status-banner');
const btnLockIn        = $('btn-lock-in');
const combatLogBody    = $('combat-log-body');

// Game Over Screen
const gameoverResult   = $('gameover-result');
const gameoverDetail   = $('gameover-detail');
const btnPlayAgain     = $('btn-play-again');

// ─── Screen Navigation ────────────────────────────────────────────────────────
/**
 * Shows a named screen, hides all others.
 * @param {'character'|'lobby'|'arena'|'gameover'} name
 */
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
}

// ─── Character Selection ──────────────────────────────────────────────────────
charCards.forEach(card => {
  card.addEventListener('click', () => {
    // Deselect all, then select clicked
    charCards.forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.character = card.dataset.char;
    updateEnterButton();
  });
});

playerNameInput.addEventListener('input', updateEnterButton);

function updateEnterButton() {
  const hasName = playerNameInput.value.trim().length > 0;
  const hasChar = state.character !== null;
  btnEnterArena.disabled = !(hasName && hasChar);
}

btnEnterArena.addEventListener('click', () => {
  state.playerName = playerNameInput.value.trim();

  // Populate lobby screen
  const meta = CHARACTER_META[state.character];
  lobbyAvatar.textContent     = meta.emoji;
  lobbyPlayerName.textContent = state.playerName;
  lobbyCharName.textContent   = state.character;

  showScreen('lobby');

  // Emit join queue to server
  socket.emit('joinQueue', {
    name:      state.playerName,
    character: state.character,
  });
});

// ─── Action Queue Management ──────────────────────────────────────────────────
/**
 * Adds an action to the local move queue (up to 3 slots).
 * Updates the visual slot cards.
 */
function addMoveToQueue(action) {
  if (state.selectedMoves.length >= 3 || state.isLockedIn) return;

  state.selectedMoves.push(action);
  renderQueueSlots();
  updateLockInButton();
}

/**
 * Removes a move at a given slot index and shifts remaining moves.
 */
function removeMoveFromSlot(index) {
  if (state.isLockedIn) return;
  state.selectedMoves.splice(index, 1);
  renderQueueSlots();
  updateLockInButton();
}

/**
 * Renders the current selectedMoves array into the 3 visual slot cards.
 */
function renderQueueSlots() {
  queueSlots.forEach((slot, i) => {
    const move = state.selectedMoves[i];
    if (move) {
      const meta = ACTION_META[move];
      slot.classList.add('filled');
      // Replace inner content preserving slot-num and remove btn
      slot.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <button class="slot-remove-btn" data-slot="${i}" title="Remove">✕</button>
        <span class="slot-action-icon">${meta.icon}</span>
        <span>${meta.label}</span>
      `;
      // Re-bind remove button (innerHTML clears old listeners)
      slot.querySelector('.slot-remove-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        removeMoveFromSlot(parseInt(e.currentTarget.dataset.slot));
      });
    } else {
      slot.classList.remove('filled');
      slot.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <button class="slot-remove-btn" data-slot="${i}" title="Remove">✕</button>
        <span>Empty</span>
      `;
    }
  });

  // Disable action buttons once 3 moves selected
  const full = state.selectedMoves.length >= 3;
  actionButtons.forEach(btn => {
    btn.disabled = full || state.isLockedIn;
  });
}

function updateLockInButton() {
  const ready = state.selectedMoves.length === 3 && !state.isLockedIn;
  btnLockIn.disabled = !ready;
}

// Action button clicks
actionButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    addMoveToQueue(btn.dataset.action);
  });
});

// Remove-slot button clicks (initial render)
document.querySelectorAll('.slot-remove-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeMoveFromSlot(parseInt(e.currentTarget.dataset.slot));
  });
});

// ─── Lock In ─────────────────────────────────────────────────────────────────
btnLockIn.addEventListener('click', () => {
  if (state.selectedMoves.length !== 3 || state.isLockedIn) return;

  state.isLockedIn = true;

  // Visually lock UI
  actionButtons.forEach(btn => btn.disabled = true);
  btnLockIn.disabled   = true;
  btnLockIn.textContent = '🔒 Waiting for Opponent…';
  btnLockIn.classList.add('locked');

  showStatusBanner('🔒 Moves locked! Waiting for opponent…', 'waiting');

  socket.emit('lockIn', { moves: state.selectedMoves });
});

// ─── HP Bar Helpers ───────────────────────────────────────────────────────────
/**
 * Updates an HP bar element.
 * @param {HTMLElement} barEl - The fill div
 * @param {HTMLElement} labelEl - The number span
 * @param {number} hp
 */
function updateHpBar(barEl, labelEl, hp) {
  const pct   = Math.max(0, Math.min(100, hp));
  const level = pct > 50 ? 'high' : pct > 25 ? 'mid' : 'low';

  barEl.style.width        = `${pct}%`;
  barEl.dataset.level      = level;
  labelEl.textContent      = hp;
}

// ─── Combat Log ───────────────────────────────────────────────────────────────
/**
 * Appends an entry to the combat log and auto-scrolls.
 * @param {string} text
 * @param {'win'|'lose'|'clash'|'system'} type
 */
function addLogEntry(text, type = 'system') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = text;
  combatLogBody.appendChild(entry);
  combatLogBody.scrollTop = combatLogBody.scrollHeight;
}

// ─── Status Banner ────────────────────────────────────────────────────────────
function showStatusBanner(text, type = 'waiting') {
  statusBanner.textContent = text;
  statusBanner.className   = `status-banner visible ${type}`;
}
function hideStatusBanner() {
  statusBanner.className = 'status-banner';
}

// ─── Arena Setup ─────────────────────────────────────────────────────────────
/**
 * Populates the arena UI with match data received from the server.
 * @param {{ self, opponent, roomId }} matchData
 */
function setupArena(matchData) {
  const { self, opponent, roomId } = matchData;
  state.roomId      = roomId;
  state.selfHp      = self.hp;
  state.opponentHp  = opponent.hp;
  state.turn        = 1;
  state.isLockedIn  = false;
  state.opponentLocked = false;
  state.selectedMoves = [];

  const selfMeta = CHARACTER_META[self.character] || { emoji: '⚔️' };
  const oppMeta  = CHARACTER_META[opponent.character] || { emoji: '⚔️' };

  // HUD
  hudSelfName.textContent = self.name;
  hudSelfChar.textContent = self.character;
  hudOppName.textContent  = opponent.name;
  hudOppChar.textContent  = opponent.character;
  turnCounter.textContent = '1';

  // HP Bars
  updateHpBar(hpBarSelf, hpValSelf, 100);
  updateHpBar(hpBarOpp,  hpValOpp,  100);

  // Avatar Panels
  panelSelfAvatar.textContent = selfMeta.emoji;
  panelSelfChar.textContent   = self.character;
  panelOppAvatar.textContent  = oppMeta.emoji;
  panelOppChar.textContent    = opponent.character;

  // Reset opponent lock indicator
  oppLockIndicator.textContent = '⏳ Choosing…';
  oppLockIndicator.classList.remove('locked');

  // Reset slots & buttons
  renderQueueSlots();
  updateLockInButton();
  btnLockIn.textContent = '🔒 Lock In Moves';
  btnLockIn.classList.remove('locked');
  hideStatusBanner();

  // Clear combat log
  combatLogBody.innerHTML = '';
  addLogEntry(`⚔ ${self.name} (${self.character}) vs ${opponent.name} (${opponent.character}) — FIGHT!`, 'system');
}

// ─── Turn Result Renderer ─────────────────────────────────────────────────────
/**
 * Processes and displays the result of a resolved turn.
 * @param {{ turn, slotResults, selfHp, opponentHp }} data
 */
function renderTurnResult(data) {
  const { turn, slotResults, selfHp, opponentHp } = data;

  addLogEntry(`━━━ Turn ${turn} Results ━━━`, 'system');

  slotResults.forEach(slot => {
    const { slot: slotNum, p1Action, p2Action, outcomeP1, dmgToP1, dmgToP2 } = slot;

    // From this client's perspective, "our" outcome is outcomeP1
    // (server sends perspective-correct data per player)
    const isClash = outcomeP1 === 'Clash';

    let type = 'clash';
    if (!isClash) {
      // If we dealt damage this slot (dmgToP2 > 0), it's a win
      if (dmgToP2 > 0) type = 'win';
      else if (dmgToP1 > 0) type = 'lose';
    }

    addLogEntry(`Slot ${slotNum}: You used ${p1Action} → ${outcomeP1}`, type);
  });

  // Update HP (with shake animation on damage taken)
  const selfDmg = state.selfHp - selfHp;
  const oppDmg  = state.opponentHp - opponentHp;

  if (selfDmg > 0) {
    const panel = document.querySelector('.avatar-panel.self');
    panel.classList.remove('shake');
    void panel.offsetWidth; // reflow to restart animation
    panel.classList.add('shake');
  }
  if (oppDmg > 0) {
    const panel = document.querySelector('.avatar-panel.opponent-panel');
    panel.classList.remove('shake');
    void panel.offsetWidth;
    panel.classList.add('shake');
  }

  state.selfHp     = selfHp;
  state.opponentHp = opponentHp;
  state.turn       = turn + 1;

  updateHpBar(hpBarSelf, hpValSelf, selfHp);
  updateHpBar(hpBarOpp,  hpValOpp,  opponentHp);
  turnCounter.textContent = state.turn;

  addLogEntry(`HP — You: ${selfHp} | Opponent: ${opponentHp}`, 'system');
}

/**
 * Resets the arena UI for a new turn after results are shown.
 */
function resetForNextTurn() {
  state.isLockedIn      = false;
  state.opponentLocked  = false;
  state.selectedMoves   = [];

  actionButtons.forEach(btn => btn.disabled = false);
  btnLockIn.disabled      = false;
  btnLockIn.textContent   = '🔒 Lock In Moves';
  btnLockIn.classList.remove('locked');

  oppLockIndicator.textContent = '⏳ Choosing…';
  oppLockIndicator.classList.remove('locked');

  hideStatusBanner();
  renderQueueSlots();
}

// ─── Socket.io Event Handlers ─────────────────────────────────────────────────

/** Server accepted our queue join */
socket.on('queueJoined', ({ message }) => {
  console.log('[Socket] queueJoined:', message);
  lobbyStatusText.textContent = 'Searching for opponent';
});

/** A match has been found — transition to the arena */
socket.on('matchFound', (data) => {
  console.log('[Socket] matchFound:', data);
  setupArena(data);
  showScreen('arena');
  addLogEntry('✅ Match found! The arena is set.', 'system');
});

/** Server confirmed our lock-in */
socket.on('lockConfirmed', ({ message }) => {
  console.log('[Socket] lockConfirmed:', message);
  showStatusBanner('🔒 Moves locked! Waiting for opponent…', 'waiting');
});

/** Opponent has locked in their moves */
socket.on('opponentLocked', ({ message }) => {
  console.log('[Socket] opponentLocked:', message);
  state.opponentLocked = true;
  oppLockIndicator.textContent = '✅ Ready!';
  oppLockIndicator.classList.add('locked');

  // If we're also locked, prompt is shown by lockConfirmed; otherwise hint
  if (!state.isLockedIn) {
    addLogEntry('⚡ Opponent has locked in — hurry!', 'system');
  }
});

/** Both players locked — server resolved the turn */
socket.on('turnResult', (data) => {
  console.log('[Socket] turnResult:', data);
  renderTurnResult(data);

  // Brief pause before resetting for next turn (1.5s so player can read log)
  setTimeout(resetForNextTurn, 1500);
});

/** Game is over */
socket.on('gameOver', (data) => {
  console.log('[Socket] gameOver:', data);
  const { result, selfHp, opponentHp, winnerName } = data;

  // Final HP update
  updateHpBar(hpBarSelf, hpValSelf, selfHp);
  updateHpBar(hpBarOpp,  hpValOpp,  opponentHp);

  // Build game-over screen content
  const resultText = { win: 'VICTORY', loss: 'DEFEATED', draw: 'DRAW' };
  const resultDetail = {
    win:  `Your opponent has fallen. You emerge victorious from the arena!`,
    loss: `You have been defeated. Train harder and return.`,
    draw: `Both warriors fall simultaneously. An honourable draw.`,
  };

  gameoverResult.textContent = resultText[result] || '—';
  gameoverResult.className   = `result-badge ${result}`;

  const extra = winnerName && result !== 'draw'
    ? ` Winner: ${winnerName}.`
    : '';
  gameoverDetail.textContent = (resultDetail[result] || '') + extra;

  setTimeout(() => showScreen('gameover'), 800);
});

/** Opponent disconnected mid-game */
socket.on('opponentDisconnected', ({ message }) => {
  console.log('[Socket] opponentDisconnected:', message);
  addLogEntry(`⚠️ ${message}`, 'system');

  gameoverResult.textContent = 'VICTORY';
  gameoverResult.className   = 'result-badge win';
  gameoverDetail.textContent = 'Your opponent disconnected. The arena is yours!';

  setTimeout(() => showScreen('gameover'), 1200);
});

/** Server-side validation errors */
socket.on('error', ({ message }) => {
  console.warn('[Socket] error:', message);
  addLogEntry(`❌ Error: ${message}`, 'lose');
});

/** Generic disconnect handling */
socket.on('disconnect', () => {
  console.warn('[Socket] Disconnected from server.');
  // If we were in a game, show a disconnection message
  const arenaActive = screens.arena.classList.contains('active');
  if (arenaActive) {
    addLogEntry('⚠️ Lost connection to the server.', 'lose');
  }
});

socket.on('reconnect', () => {
  console.log('[Socket] Reconnected.');
});

// ─── Play Again ───────────────────────────────────────────────────────────────
btnPlayAgain.addEventListener('click', () => {
  // Reset all local state
  state.playerName     = '';
  state.character      = null;
  state.roomId         = null;
  state.selectedMoves  = [];
  state.isLockedIn     = false;
  state.opponentLocked = false;
  state.selfHp         = 100;
  state.opponentHp     = 100;
  state.turn           = 1;

  // Reset character selection UI
  charCards.forEach(c => c.classList.remove('selected'));
  playerNameInput.value = '';
  btnEnterArena.disabled = true;

  showScreen('character');
});

// ─── Init ─────────────────────────────────────────────────────────────────────
console.log('⚔ Turn-Based Arena client initialised.');
showScreen('character');
