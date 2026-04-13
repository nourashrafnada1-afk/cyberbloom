const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = '2792025';

// ─── Questions (hardcoded) ────────────────────────────────────────────────────
// Edit question text and options here.
// Correct answers: D D B C A A B C C B

const QUESTIONS = [
  { text: 'Question 1 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'D' },
  { text: 'Question 2 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'D' },
  { text: 'Question 3 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'B' },
  { text: 'Question 4 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'C' },
  { text: 'Question 5 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'A' },
  { text: 'Question 6 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'A' },
  { text: 'Question 7 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'B' },
  { text: 'Question 8 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'C' },
  { text: 'Question 9 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'C' },
  { text: 'Question 10 text goes here', options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' }, correct: 'B' },
];

// ─── Shared Session State ─────────────────────────────────────────────────────
// Single source of truth — every socket that connects syncs to this.

const state = {
  sessionStarted:  false,
  sessionEnded:    false,
  currentQuestion: 0,
};

// players[sid] = { sid, name, idnum, score, submitted: { [qIndex]: true } }
const players = {};

// Track all host socket IDs (supports multiple host tabs/devices)
const hostSids = new Set();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(session({
  secret: 'cyberbloom_secret_2024',
  resave: false,
  saveUninitialized: false,
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

app.get('/',            (_req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/join-player', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'join-player.html')));
app.get('/join-host',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'join-host.html')));

app.post('/join', (req, res) => {
  const name  = (req.body.name  || '').trim();
  const idnum = (req.body.phone || '').trim();
  if (!name || !idnum) return res.redirect('/join-player');
  req.session.name  = name;
  req.session.idnum = idnum;
  req.session.role  = 'player';
  return res.redirect('/player');
});

app.post('/join-host', (req, res) => {
  const pass = (req.body.password || '').trim();
  if (pass !== HOST_PASSWORD) return res.redirect('/join-host?error=wrong_password');
  req.session.name  = 'Host';
  req.session.idnum = '';
  req.session.role  = 'host';
  return res.redirect('/host');
});

app.get('/player', (req, res) => {
  if (!req.session.name) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/host', (req, res) => {
  if (!req.session.name || req.session.role !== 'host') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/leave', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/api/session', (req, res) => res.json({
  name:  req.session.name  || '',
  idnum: req.session.idnum || '',
  role:  req.session.role  || 'player',
}));

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── HOST registers ───────────────────────────────────────────────────────────
  socket.on('register_host', () => {
    hostSids.add(socket.id);
    socket.join('hosts');

    // Send full current state so any host joining at any time is in sync
    socket.emit('host_sync', {
      players:         Object.values(players),
      sessionStarted:  state.sessionStarted,
      sessionEnded:    state.sessionEnded,
      currentQuestion: state.currentQuestion,
      totalQuestions:  QUESTIONS.length,
      // If session running, send full current question
      currentQuestionData: state.sessionStarted && !state.sessionEnded
        ? buildHostQuestion(state.currentQuestion)
        : null,
      // If session ended, send results
      results: state.sessionEnded ? buildResults() : null,
    });

    console.log(`[HOST] connected: ${socket.id} | total hosts: ${hostSids.size}`);
  });

  // ── PLAYER registers ─────────────────────────────────────────────────────────
  socket.on('register_player', ({ name, idnum }) => {
    // Register or re-register the player (handles reconnects by name+idnum match)
    const existing = Object.values(players).find(
      p => p.name === name && p.idnum === idnum
    );

    if (existing) {
      // Reconnecting player — update their socket ID
      delete players[existing.sid];
      existing.sid = socket.id;
      players[socket.id] = existing;
    } else {
      players[socket.id] = {
        sid:       socket.id,
        name,
        idnum,
        score:     0,
        submitted: {},
      };
    }

    socket.join('players');

    // Send full current state so player syncs no matter when they join
    const playerSync = {
      sessionStarted:  state.sessionStarted,
      sessionEnded:    state.sessionEnded,
      currentQuestion: state.currentQuestion,
      totalQuestions:  QUESTIONS.length,
      myScore:         players[socket.id].score,
      alreadySubmitted: !!players[socket.id].submitted[state.currentQuestion],
      // If session running, send current question (number only — no text)
      currentQuestionData: state.sessionStarted && !state.sessionEnded
        ? { index: state.currentQuestion, total: QUESTIONS.length }
        : null,
      // If session ended, send results
      results: state.sessionEnded ? buildResults() : null,
    };

    socket.emit('player_sync', playerSync);

    // Notify all hosts about updated player list
    io.to('hosts').emit('players_update', { players: Object.values(players) });

    console.log(`[PLAYER] ${name} connected: ${socket.id} | total players: ${Object.keys(players).length}`);
  });

  // ── HOST: start session ──────────────────────────────────────────────────────
  socket.on('start_session', () => {
    if (!hostSids.has(socket.id)) return;
    if (state.sessionStarted) return; // already started

    state.sessionStarted  = true;
    state.sessionEnded    = false;
    state.currentQuestion = 0;

    // Reset all player scores
    for (const sid in players) {
      players[sid].score     = 0;
      players[sid].submitted = {};
    }

    // Tell everyone session started
    io.emit('session_started', { totalQuestions: QUESTIONS.length });

    // Send question to players (number only) and hosts (full)
    broadcastQuestion(state.currentQuestion);

    // Update hosts with fresh player list
    io.to('hosts').emit('players_update', { players: Object.values(players) });

    console.log(`[SESSION] Started by host ${socket.id}`);
  });

  // ── HOST: next question ──────────────────────────────────────────────────────
  socket.on('next_question', () => {
    if (!hostSids.has(socket.id)) return;
    if (!state.sessionStarted || state.sessionEnded) return;

    state.currentQuestion++;

    if (state.currentQuestion >= QUESTIONS.length) {
      // Session over
      state.sessionEnded = true;
      const results = buildResults();
      io.emit('session_ended', { results });
      io.to('hosts').emit('players_update', { players: Object.values(players) });
      console.log(`[SESSION] Ended`);
    } else {
      broadcastQuestion(state.currentQuestion);
      io.to('hosts').emit('players_update', { players: Object.values(players) });
      console.log(`[SESSION] Advanced to Q${state.currentQuestion + 1} by host ${socket.id}`);
    }
  });

  // ── PLAYER: submit answer ────────────────────────────────────────────────────
  socket.on('submit_answer', ({ qIndex, answer }) => {
    const player = players[socket.id];
    if (!player) return;
    if (!state.sessionStarted || state.sessionEnded) return;
    if (qIndex !== state.currentQuestion) return;
    if (player.submitted[qIndex]) return; // already submitted

    player.submitted[qIndex] = true;

    // Grade silently
    if (answer === QUESTIONS[qIndex].correct) player.score += 1;

    // Confirm to player — no right/wrong info
    socket.emit('answer_confirmed', { qIndex });

    // Update all hosts
    io.to('hosts').emit('players_update', { players: Object.values(players) });

    console.log(`[ANSWER] ${player.name} answered Q${qIndex + 1}: ${answer}`);
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (hostSids.has(socket.id)) {
      hostSids.delete(socket.id);
      console.log(`[HOST] disconnected: ${socket.id} | remaining hosts: ${hostSids.size}`);
      return;
    }

    if (players[socket.id]) {
      const { name } = players[socket.id];
      // Don't delete the player — keep their score/state so they can reconnect
      // Just remove from socket room tracking; their record stays in players{}
      // (If you want to remove them on disconnect, uncomment the line below)
      // delete players[socket.id];

      io.to('hosts').emit('players_update', { players: Object.values(players) });
      console.log(`[PLAYER] ${name} disconnected (state preserved for reconnect)`);
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Send the current question to all players (number only) and all hosts (full). */
function broadcastQuestion(index) {
  const q = QUESTIONS[index];

  // Players: only question number — no text, no options
  io.to('players').emit('new_question', {
    index,
    total: QUESTIONS.length,
  });

  // Hosts: full question + correct answer
  io.to('hosts').emit('new_question_host', buildHostQuestion(index));
}

/** Build the full question object for the host. */
function buildHostQuestion(index) {
  const q = QUESTIONS[index];
  return {
    index,
    total:   QUESTIONS.length,
    text:    q.text,
    options: q.options,
    correct: q.correct,
  };
}

/** Build sorted results array. */
function buildResults() {
  return Object.values(players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank:  i + 1,
      name:  p.name,
      idnum: p.idnum,
      score: p.score,
      total: QUESTIONS.length,
    }));
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🌸  CyberBloom running at http://localhost:${PORT}\n`);
  console.log(`   Total questions: ${QUESTIONS.length}`);
  console.log(`   Answer key: ${QUESTIONS.map(q => q.correct).join(' ')}\n`);
});