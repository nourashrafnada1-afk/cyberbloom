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

// ─── Answer Key (hardcoded, never sent to players) ───────────────────────────
// Q1=D, Q2=D, Q3=B, Q4=C, Q5=A, Q6=A, Q7=B, Q8=C, Q9=C, Q10=B
const ANSWER_KEY = ['D','D','B','C','A','A','B','C','C','B'];

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(session({
  secret: 'cyberbloom_secret_2024',
  resave: false,
  saveUninitialized: false,
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory State ──────────────────────────────────────────────────────────

/**
 * players[sid] = { sid, name, idnum, score, submitted: { [qIndex]: true } }
 */
const players = {};

let hostSid         = null;
let sessionStarted  = false;
let sessionEnded    = false;
let currentQuestion = 0;

/**
 * questions = array of { text, options: {A,B,C,D} }
 * Correct answers are ONLY in ANSWER_KEY — never stored here.
 */
let questions = [];

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

// Landing page — two buttons: Player / Host
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'join.html')));

// Player details page
app.get('/join-player', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'join-player.html')));

// Host passcode page
app.get('/join-host', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'join-host.html')));

// ── Player form submission ────────────────────────────────────────────────────
app.post('/join', (req, res) => {
  const name  = (req.body.name  || '').trim();
  const idnum = (req.body.phone || '').trim(); // field kept as "phone" in form for compatibility
  const role  = (req.body.role  || 'player');

  if (!name || !idnum) return res.redirect('/join-player');

  req.session.name  = name;
  req.session.idnum = idnum;
  req.session.role  = 'player';

  return res.redirect('/player');
});

// ── Host passcode submission ──────────────────────────────────────────────────
app.post('/join-host', (req, res) => {
  const pass = (req.body.password || '').trim();

  if (pass !== HOST_PASSWORD) return res.redirect('/join-host?error=wrong_password');

  req.session.name  = 'Host';
  req.session.idnum = '';
  req.session.role  = 'host';

  return res.redirect('/host');
});

// ── Protected pages ───────────────────────────────────────────────────────────
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

  // ── register ────────────────────────────────────────────────────────────────
  socket.on('register', ({ role, name, idnum }) => {
    if (role === 'host') {
      hostSid = socket.id;
      socket.join('host');
      socket.emit('host_init', {
        players: Object.values(players),
        sessionStarted,
        sessionEnded,
        currentQuestion,
        totalQuestions: questions.length,
      });
      return;
    }

    players[socket.id] = {
      sid: socket.id,
      name,
      idnum,
      score: 0,
      submitted: {},
    };
    socket.join('players');

    socket.emit('player_init', {
      sessionStarted,
      sessionEnded,
      currentQuestion,
      totalQuestions: questions.length,
      question: sessionStarted && !sessionEnded && questions[currentQuestion]
        ? sanitizeQuestion(questions[currentQuestion], currentQuestion)
        : null,
    });

    io.to('host').emit('players_update', { players: Object.values(players) });
    io.to('host').emit('player_joined', { name, count: Object.keys(players).length });
  });

  // ── host sets questions ──────────────────────────────────────────────────────
  socket.on('set_questions', (qs) => {
    if (socket.id !== hostSid) return;
    questions = qs.map(q => ({ text: q.text, options: q.options }));
    currentQuestion = 0;
    io.to('host').emit('questions_saved', { count: questions.length });
  });

  // ── host starts session ──────────────────────────────────────────────────────
  socket.on('start_session', () => {
    if (socket.id !== hostSid || questions.length === 0) return;
    sessionStarted  = true;
    sessionEnded    = false;
    currentQuestion = 0;

    for (const sid in players) {
      players[sid].score     = 0;
      players[sid].submitted = {};
    }

    io.emit('session_started', {});
    broadcastQuestion(currentQuestion);
    io.to('host').emit('players_update', { players: Object.values(players) });
  });

  // ── host advances question ───────────────────────────────────────────────────
  socket.on('next_question', () => {
    if (socket.id !== hostSid) return;
    currentQuestion++;

    if (currentQuestion >= questions.length) {
      sessionEnded = true;
      const results = buildResults();
      io.emit('session_ended', { results });
      io.to('host').emit('players_update', { players: Object.values(players) });
    } else {
      broadcastQuestion(currentQuestion);
      io.to('host').emit('players_update', { players: Object.values(players) });
    }
  });

  // ── player submits answer ────────────────────────────────────────────────────
  socket.on('submit_answer', ({ qIndex, answer }) => {
    const player = players[socket.id];
    if (!player || !sessionStarted || sessionEnded) return;
    if (qIndex !== currentQuestion) return;
    if (player.submitted[qIndex]) return;

    player.submitted[qIndex] = true;

    const correct = ANSWER_KEY[qIndex];
    if (answer === correct) player.score += 1;

    // No correct/wrong info sent back — just a confirmation
    socket.emit('answer_confirmed', { qIndex });

    io.to('host').emit('players_update', { players: Object.values(players) });
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.id === hostSid) { hostSid = null; return; }
    if (players[socket.id]) {
      const { name } = players[socket.id];
      delete players[socket.id];
      io.to('host').emit('players_update', { players: Object.values(players) });
      io.to('host').emit('player_left', { name, count: Object.keys(players).length });
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeQuestion(q, index) {
  return { index, total: questions.length, text: q.text, options: q.options };
}

function broadcastQuestion(index) {
  const q = questions[index];
  if (!q) return;
  io.to('players').emit('new_question', sanitizeQuestion(q, index));
  io.to('host').emit('new_question_host', {
    ...sanitizeQuestion(q, index),
    correct: ANSWER_KEY[index],
  });
}

function buildResults() {
  return Object.values(players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank:  i + 1,
      name:  p.name,
      idnum: p.idnum,
      score: p.score,
      total: questions.length,
    }));
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🌸  CyberBloom running at http://localhost:${PORT}\n`);
  console.log(`   Answer key: ${ANSWER_KEY.join(' ')}\n`);
});