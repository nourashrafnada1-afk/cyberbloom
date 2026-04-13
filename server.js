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

// ─── Questions (hardcoded — edit here) ───────────────────────────────────────
// Players only see A B C D — the question text is NEVER sent to players.
// Correct answers: Q1=D, Q2=D, Q3=B, Q4=C, Q5=A, Q6=A, Q7=B, Q8=C, Q9=C, Q10=B

const QUESTIONS = [
  {
    text: 'Question 1 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'D',
  },
  {
    text: 'Question 2 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'D',
  },
  {
    text: 'Question 3 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'B',
  },
  {
    text: 'Question 4 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'C',
  },
  {
    text: 'Question 5 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'A',
  },
  {
    text: 'Question 6 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'A',
  },
  {
    text: 'Question 7 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'B',
  },
  {
    text: 'Question 8 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'C',
  },
  {
    text: 'Question 9 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'C',
  },
  {
    text: 'Question 10 text goes here',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    correct: 'B',
  },
];

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

const players = {};
// players[sid] = { sid, name, idnum, score, submitted: { [qIndex]: true } }

let hostSid         = null;
let sessionStarted  = false;
let sessionEnded    = false;
let currentQuestion = 0;

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

  socket.on('register', ({ role, name, idnum }) => {
    if (role === 'host') {
      hostSid = socket.id;
      socket.join('host');
      socket.emit('host_init', {
        players: Object.values(players),
        sessionStarted,
        sessionEnded,
        currentQuestion,
        totalQuestions: QUESTIONS.length,
      });
      return;
    }

    players[socket.id] = { sid: socket.id, name, idnum, score: 0, submitted: {} };
    socket.join('players');

    socket.emit('player_init', {
      sessionStarted,
      sessionEnded,
      currentQuestion,
      totalQuestions: QUESTIONS.length,
    });

    io.to('host').emit('players_update', { players: Object.values(players) });
    io.to('host').emit('player_joined', { name, count: Object.keys(players).length });
  });

  // Host starts the session
  socket.on('start_session', () => {
    if (socket.id !== hostSid) return;
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

  // Host moves to next question
  socket.on('next_question', () => {
    if (socket.id !== hostSid) return;
    currentQuestion++;

    if (currentQuestion >= QUESTIONS.length) {
      sessionEnded = true;
      const results = buildResults();
      io.emit('session_ended', { results });
      io.to('host').emit('players_update', { players: Object.values(players) });
    } else {
      broadcastQuestion(currentQuestion);
      io.to('host').emit('players_update', { players: Object.values(players) });
    }
  });

  // Player submits answer
  socket.on('submit_answer', ({ qIndex, answer }) => {
    const player = players[socket.id];
    if (!player || !sessionStarted || sessionEnded) return;
    if (qIndex !== currentQuestion) return;
    if (player.submitted[qIndex]) return;

    player.submitted[qIndex] = true;
    if (answer === QUESTIONS[qIndex].correct) player.score += 1;

    // No right/wrong feedback — just confirm submission
    socket.emit('answer_confirmed', { qIndex });
    io.to('host').emit('players_update', { players: Object.values(players) });
  });

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

function broadcastQuestion(index) {
  const q = QUESTIONS[index];
  // Players get ONLY the question number — no text, no options text
  // Just the index so they know which question they're on
  io.to('players').emit('new_question', {
    index,
    total: QUESTIONS.length,
  });
  // Host gets full question with correct answer
  io.to('host').emit('new_question_host', {
    index,
    total: QUESTIONS.length,
    text:  q.text,
    options: q.options,
    correct: q.correct,
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
      total: QUESTIONS.length,
    }));
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🌸  CyberBloom running at http://localhost:${PORT}\n`);
});