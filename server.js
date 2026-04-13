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

const state = {
  sessionStarted:  false,
  sessionEnded:    false,
  currentQuestion: 0,
};

// players[sid] = { sid, name, idnum, score, submitted: { [qIndex]: true } }
const players = {};

// All connected host socket IDs
const hostSids = new Set();

// ─── Helper: fully reset all session state ────────────────────────────────────

function resetState() {
  state.sessionStarted  = false;
  state.sessionEnded    = false;
  state.currentQuestion = 0;

  // Clear all players
  for (const sid in players) {
    delete players[sid];
  }
}

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

    socket.emit('host_sync', {
      players:             Object.values(players),
      sessionStarted:      state.sessionStarted,
      sessionEnded:        state.sessionEnded,
      currentQuestion:     state.currentQuestion,
      totalQuestions:      QUESTIONS.length,
      currentQuestionData: state.sessionStarted && !state.sessionEnded
        ? buildHostQuestion(state.currentQuestion)
        : null,
      results: state.sessionEnded ? buildResults() : null,
    });

    console.log(`[HOST] connected: ${socket.id} | total hosts: ${hostSids.size}`);
  });

  // ── PLAYER registers ─────────────────────────────────────────────────────────
  socket.on('register_player', ({ name, idnum }) => {
    // Reconnect: match by name + idnum
    const existing = Object.values(players).find(
      p => p.name === name && p.idnum === idnum
    );

    if (existing) {
      delete players[existing.sid];
      existing.sid = socket.id;
      players[socket.id] = existing;
    } else {
      players[socket.id] = { sid: socket.id, name, idnum, score: 0, submitted: {} };
    }

    socket.join('players');

    socket.emit('player_sync', {
      sessionStarted:      state.sessionStarted,
      sessionEnded:        state.sessionEnded,
      currentQuestion:     state.currentQuestion,
      totalQuestions:      QUESTIONS.length,
      myScore:             players[socket.id].score,
      alreadySubmitted:    !!players[socket.id].submitted[state.currentQuestion],
      currentQuestionData: state.sessionStarted && !state.sessionEnded
        ? { index: state.currentQuestion, total: QUESTIONS.length }
        : null,
      results: state.sessionEnded ? buildResults() : null,
    });

    io.to('hosts').emit('players_update', { players: Object.values(players) });
    console.log(`[PLAYER] ${name} connected | total: ${Object.keys(players).length}`);
  });

  // ── HOST: start session ──────────────────────────────────────────────────────
  socket.on('start_session', () => {
    if (!hostSids.has(socket.id)) return;
    if (state.sessionStarted) return;

    state.sessionStarted  = true;
    state.sessionEnded    = false;
    state.currentQuestion = 0;

    for (const sid in players) {
      players[sid].score     = 0;
      players[sid].submitted = {};
    }

    io.emit('session_started', { totalQuestions: QUESTIONS.length });
    broadcastQuestion(state.currentQuestion);
    io.to('hosts').emit('players_update', { players: Object.values(players) });
    console.log(`[SESSION] Started`);
  });

  // ── HOST: next question ──────────────────────────────────────────────────────
  socket.on('next_question', () => {
    if (!hostSids.has(socket.id)) return;
    if (!state.sessionStarted || state.sessionEnded) return;

    state.currentQuestion++;

    if (state.currentQuestion >= QUESTIONS.length) {
      state.sessionEnded = true;
      const results = buildResults();
      io.emit('session_ended', { results });
      io.to('hosts').emit('players_update', { players: Object.values(players) });
      console.log(`[SESSION] Ended`);
    } else {
      broadcastQuestion(state.currentQuestion);
      io.to('hosts').emit('players_update', { players: Object.values(players) });
      console.log(`[SESSION] Q${state.currentQuestion + 1}`);
    }
  });

  // ── HOST: reset quiz ─────────────────────────────────────────────────────────
  socket.on('reset_quiz', () => {
    if (!hostSids.has(socket.id)) return;

    console.log(`[RESET] Quiz reset by host ${socket.id}`);

    // Tell ALL players to go back to join page before we wipe state
    io.to('players').emit('quiz_reset');

    // Small delay so the event reaches clients before we wipe socket rooms
    setTimeout(() => {
      resetState();
      // Tell all hosts to go back to lobby
      io.to('hosts').emit('host_reset');
      console.log(`[RESET] State cleared`);
    }, 300);
  });

  // ── PLAYER: submit answer ────────────────────────────────────────────────────
  socket.on('submit_answer', ({ qIndex, answer }) => {
    const player = players[socket.id];
    if (!player || !state.sessionStarted || state.sessionEnded) return;
    if (qIndex !== state.currentQuestion) return;
    if (player.submitted[qIndex]) return;

    player.submitted[qIndex] = true;
    if (answer === QUESTIONS[qIndex].correct) player.score += 1;

    socket.emit('answer_confirmed', { qIndex });
    io.to('hosts').emit('players_update', { players: Object.values(players) });
    console.log(`[ANSWER] ${player.name} Q${qIndex + 1}: ${answer}`);
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (hostSids.has(socket.id)) {
      hostSids.delete(socket.id);
      console.log(`[HOST] disconnected: ${socket.id} | remaining: ${hostSids.size}`);
      return;
    }
    if (players[socket.id]) {
      const { name } = players[socket.id];
      io.to('hosts').emit('players_update', { players: Object.values(players) });
      console.log(`[PLAYER] ${name} disconnected (state kept)`);
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function broadcastQuestion(index) {
  io.to('players').emit('new_question', { index, total: QUESTIONS.length });
  io.to('hosts').emit('new_question_host', buildHostQuestion(index));
}

function buildHostQuestion(index) {
  const q = QUESTIONS[index];
  return { index, total: QUESTIONS.length, text: q.text, options: q.options, correct: q.correct };
}

function buildResults() {
  return Object.values(players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, idnum: p.idnum, score: p.score, total: QUESTIONS.length }));
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🌸  CyberBloom running at http://localhost:${PORT}\n`);
  console.log(`   Answer key: ${QUESTIONS.map(q => q.correct).join(' ')}\n`);
});