const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const { sanitizeName, rateLimit } = require('./utils');
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',').map(s => s.trim()),
    methods: ['GET', 'POST']
  }
});

// --- CORS SETUP ---
const allowedOrigins = process.env.CORS_ORIGIN?.split(',').map(s => s.trim());

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
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

  socket.on('student-move', ({ roll, id }) => {
    if (!rateLimit(socket.id, 'student-move')) return;
    // Support both legacy and new: id may be undefined (use socket.id)
    const studentId = id || socket.id;
    const s = students.get(studentId);
    if (!s) return;
    if (typeof roll !== 'number' || roll < 1 || roll > 6) return;
    // Compute new square, allow unlimited laps (no cap at 96)
    const prevSquare = s.square || 0;
    let newSquare = prevSquare + roll;
    s.square = newSquare;
    // Emit move result to the student
    io.to(socket.id).emit('student-move-result', { id: studentId, square: newSquare, roll });
    broadcastStudentList();
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

  // Teacher: restart game (reset all tokens, answers, and quiz)
  socket.on('restart-game', () => {
    students.clear();
    answers.clear();
    currentQuiz = null;
    currentPhase = 1;
    currentQuestionIdx = 0;
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

  // Admin: adjust a student's square
  socket.on('admin-adjust-square', ({ id, square }) => {
    if (!id || typeof square !== 'number' || square < 0 || square > 96) return;
    if (!students.has(id)) return;
    const s = students.get(id);
    if (s) {
      s.square = square;
      broadcastStudentList();
    }
  });

  // --- Admin sync request: send current quiz and phase to admin clients ---
  socket.on('admin-sync-request', () => {
    if (currentQuiz && currentQuiz.content) {
      socket.emit('quiz-md-loaded', { content: currentQuiz.content });
      socket.emit('advance-phase', { nextPhase: currentPhase, nextQuestionIdx: currentQuestionIdx });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
