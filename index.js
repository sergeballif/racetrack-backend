const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const { sanitizeName, rateLimit } = require('./utils');
dotenv.config();

// Helper to support multiple comma-separated origins
function parseOrigins(originsStr) {
  if (!originsStr) return ['http://localhost:5173'];
  return originsStr.split(',').map(o => o.trim()).filter(Boolean);
}

const allowedOrigins = parseOrigins(process.env.CORS_ORIGIN);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, origin); // Return the origin string
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST']
  }
});

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, origin); // Return the origin string
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Quiz Game Backend Running');
});

// --- Student state (in-memory, non-persistent; replace with DB for prod) ---
const students = new Map(); // socket.id => { name, joinedAt, square }
const answers = new Map(); // socket.id => answerIdx (integer)
let currentQuiz = null; // { content: string }
let currentPhase = 1;
let currentQuestionIdx = 0;

function broadcastStudentList() {
  const list = Array.from(students.entries()).map(([id, s]) => ({
    id,
    name: s.name,
    joinedAt: s.joinedAt,
    square: s.square || 0 // default to 0 if not set
  }));
  io.emit('student-list', list);
}

function broadcastVotes() {
  // Tally votes for each answer index
  const counts = {};
  for (const idx of answers.values()) {
    if (typeof idx === 'number') counts[idx] = (counts[idx] || 0) + 1;
  }
  console.log('[DEBUG] Emitting vote-counts:', counts);
  io.emit('vote-counts', counts);
}

// Socket.io minimal test + student join
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('student-join', ({ name }) => {
    if (!rateLimit(socket.id, 'student-join', 2)) return;
    const cleanName = sanitizeName(name);
    if (!cleanName) return;
    students.set(socket.id, { name: cleanName, joinedAt: Date.now(), square: 0 });
    console.log(`Student joined: ${cleanName} (${socket.id})`);
    broadcastStudentList();
    // Sync current quiz and phase if available
    if (currentQuiz && currentQuiz.content) {
      socket.emit('quiz-md-loaded', { content: currentQuiz.content });
      socket.emit('advance-phase', { nextPhase: currentPhase, nextQuestionIdx: currentQuestionIdx });
    }
  });

  socket.on('student-move', ({ square }) => {
    if (!rateLimit(socket.id, 'student-move')) return;
    if (typeof square !== 'number' || square < 0) return;
    const s = students.get(socket.id);
    if (s) {
      s.square = square;
      broadcastStudentList();
    }
  });

  socket.on('student-answer', ({ answerIdx }) => {
    if (!rateLimit(socket.id, 'student-answer')) return;
    console.log('[DEBUG] student-answer received:', answerIdx, 'from', socket.id);
    if (typeof answerIdx !== 'number' || answerIdx < 0 || answerIdx > 3) return;
    answers.set(socket.id, answerIdx);
    broadcastVotes();
  });

  socket.on('disconnect', () => {
    students.delete(socket.id);
    answers.delete(socket.id);
    console.log('User disconnected:', socket.id);
    broadcastStudentList();
    broadcastVotes();
  });

  socket.on('ping-from-client', (msg) => {
    socket.emit('pong-from-server', `Pong! Server received: ${msg}`);
  });

  // Teacher: replace student name with 'Trouble' for all clients
  socket.on('replace-student-name', ({ id }) => {
    if (!id || !students.has(id)) return;
    const s = students.get(id);
    if (s && s.name !== 'Trouble') {
      s.name = 'Trouble';
      broadcastStudentList();
    }
  });

  // Teacher: restart game (reset all tokens and answers)
  socket.on('restart-game', () => {
    for (const s of students.values()) {
      s.square = 0;
    }
    answers.clear();
    broadcastStudentList();
    broadcastVotes();
    // Emit a 'game-restarted' event for frontend to reset state
    io.emit('game-restarted');
  });

  // Teacher: load quiz markdown and broadcast to all clients
  socket.on('load-quiz-md', ({ content }) => {
    // Limit quiz file size and validate type
    if (typeof content !== 'string' || content.length > 100000) return;
    console.log('[DEBUG] Loaded quiz markdown, length:', content?.length);
    // Broadcast to all clients so everyone loads the same quiz
    currentQuiz = { content };
    currentPhase = 1;
    currentQuestionIdx = 0;
    io.emit('quiz-md-loaded', { content });
  });

  // Teacher: advance phase and broadcast to all clients
  socket.on('advance-phase', ({ nextPhase, nextQuestionIdx }) => {
    console.log('[DEBUG] advance-phase received:', { nextPhase, nextQuestionIdx });
    currentPhase = nextPhase;
    currentQuestionIdx = nextQuestionIdx;
    io.emit('advance-phase', { nextPhase, nextQuestionIdx });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
