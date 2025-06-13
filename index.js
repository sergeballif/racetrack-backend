const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const { sanitizeName, rateLimit } = require('./utils');
const { initDatabase, createTables, gameDatabase, testConnection } = require('./database');
const { initEmailService, sendReplayNotification, testEmailService } = require('./emailService');
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

// Debug environment variables
app.get('/api/env-debug', (req, res) => {
  res.json({
    EMAIL_SERVICE: process.env.EMAIL_SERVICE || 'not set',
    EMAIL_USER: process.env.EMAIL_USER || 'not set',
    EMAIL_PASS: process.env.EMAIL_PASS ? 'configured' : 'not set',
    TEACHER_EMAIL: process.env.TEACHER_EMAIL || 'not set',
    FRONTEND_URL: process.env.FRONTEND_URL || 'not set',
    DATABASE_URL: process.env.DATABASE_URL ? 'configured' : 'not set',
    NODE_ENV: process.env.NODE_ENV || 'not set'
  });
});

// Test database connection endpoint
app.get('/api/db-test', async (req, res) => {
  const isConnected = await testConnection();
  res.json({ 
    database: isConnected ? 'connected' : 'not available',
    timestamp: new Date().toISOString()
  });
});

// Test email service endpoint
app.get('/api/email-test', async (req, res) => {
  const emailStatus = await testEmailService();
  
  // Debug: show what environment variables are available
  const envDebug = {
    EMAIL_SERVICE: process.env.EMAIL_SERVICE ? 'set' : 'missing',
    EMAIL_USER: process.env.EMAIL_USER ? 'set' : 'missing', 
    EMAIL_PASS: process.env.EMAIL_PASS ? 'set' : 'missing',
    TEACHER_EMAIL: process.env.TEACHER_EMAIL ? 'set' : 'missing',
    FRONTEND_URL: process.env.FRONTEND_URL ? 'set' : 'missing'
  };
  
  res.json({
    email: emailStatus.success ? 'configured' : 'not available',
    message: emailStatus.message,
    environment_variables: envDebug,
    timestamp: new Date().toISOString()
  });
});

// --- Replay Mode API Endpoints ---

// Get session data for replay mode
app.get('/api/session/:sessionSlug', async (req, res) => {
  try {
    const { sessionSlug } = req.params;
    const session = await gameDatabase.getGameSession(sessionSlug);
    
    if (!session) {
      return res.status(404).json({ 
        error: 'Session not found',
        message: `No replay session found with ID: ${sessionSlug}`
      });
    }
    
    res.json({
      id: session.id,
      session_slug: session.session_slug,
      quiz_filename: session.quiz_filename,
      quiz_content: session.quiz_content,
      created_at: session.created_at,
      completed_at: session.completed_at,
      status: session.status
    });
  } catch (error) {
    console.error('[API] Error fetching session:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Failed to load session data'
    });
  }
});

// Get all events for a replay session
app.get('/api/session/:sessionSlug/events', async (req, res) => {
  try {
    const { sessionSlug } = req.params;
    const session = await gameDatabase.getGameSession(sessionSlug);
    
    if (!session) {
      return res.status(404).json({ 
        error: 'Session not found',
        message: `No replay session found with ID: ${sessionSlug}`
      });
    }
    
    const events = await gameDatabase.getGameEvents(session.id);
    
    res.json({
      session_id: session.id,
      session_slug: sessionSlug,
      total_events: events.length,
      events: events.map(event => ({
        id: event.id,
        event_type: event.event_type,
        event_data: event.event_data,
        timestamp: event.timestamp
      }))
    });
  } catch (error) {
    console.error('[API] Error fetching session events:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Failed to load session events'
    });
  }
});

// Get final positions for a replay session
app.get('/api/session/:sessionSlug/players', async (req, res) => {
  try {
    const { sessionSlug } = req.params;
    const session = await gameDatabase.getGameSession(sessionSlug);
    
    if (!session) {
      return res.status(404).json({ 
        error: 'Session not found',
        message: `No replay session found with ID: ${sessionSlug}`
      });
    }
    
    // Get final positions from database
    const finalPositions = await gameDatabase.getFinalPositions(session.id);
    
    res.json({
      session_id: session.id,
      session_slug: sessionSlug,
      total_players: finalPositions.length,
      players: finalPositions.map(player => ({
        student_id: player.student_id,
        student_name: player.student_name,
        final_square: player.final_square,
        total_correct: player.total_correct
      }))
    });
  } catch (error) {
    console.error('[API] Error fetching session players:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Failed to load session players'
    });
  }
});

// --- Student state (in-memory, non-persistent; replace with DB for prod) ---
const students = new Map(); // socket.id => { name, joinedAt, square }
const answers = new Map(); // socket.id => answerIdx (integer)
let currentQuiz = null; // { content: string }
let currentPhase = 1;
let currentQuestionIdx = 0;

// --- Replay mode database state (optional, doesn't affect live gameplay) ---
let currentGameSession = null; // { id, session_slug } for current live session
initDatabase(); // Initialize database connection (safe if no DATABASE_URL)

// Initialize email service with logging
console.log('[STARTUP] Initializing email service...');
const emailResult = initEmailService(); // Initialize email service (safe if no email config)
console.log('[STARTUP] Email service result:', emailResult ? 'initialized' : 'not available');

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

  socket.on('student-move', ({ roll, id, square }) => {
    if (!rateLimit(socket.id, 'student-move')) return;
    
    // Handle both direct square setting and dice roll movement
    const targetId = id || socket.id;
    const s = students.get(targetId);
    if (!s) {
      console.log(`[ERROR] Student not found for move: ${targetId}`);
      return;
    }
    
    const oldSquare = s.square || 0;
    let newSquare = oldSquare;
    
    if (typeof square === 'number' && square >= 0) {
      // Direct square update
      newSquare = square;
      console.log(`[DEBUG] Direct move: ${s.name} (${targetId}) from ${oldSquare} to ${newSquare}`);
    } else if (typeof roll === 'number' && roll >= 1 && roll <= 6) {
      // Dice roll movement
      const currentSquare = typeof s.square === 'number' ? s.square : 0;
      newSquare = (currentSquare + roll) % 96; // Wrap around after 96 squares
      console.log(`[DEBUG] Dice roll move: ${s.name} (${targetId}) rolled ${roll}, from ${currentSquare} to ${newSquare}`);
    } else {
      console.log(`[DEBUG] Invalid move parameters: roll=${roll}, square=${square}, targetId=${targetId}`);
      return;
    }
    
    // Update the student's position
    s.square = newSquare;
    
    // Record student movement for replay mode (doesn't affect live game)
    if (currentGameSession && oldSquare !== newSquare) {
      gameDatabase.logEvent(currentGameSession.id, 'student_move', {
        student_id: targetId,
        student_name: s.name,
        from_square: oldSquare,
        to_square: newSquare,
        roll: typeof roll === 'number' ? roll : null,
        question_idx: currentQuestionIdx,
        phase: currentPhase,
        timestamp: new Date().toISOString()
      }).catch(err => {
        console.log('[REPLAY] Error logging student move:', err.message);
      });
    }
    
    // Always broadcast the update to all clients
    const update = { 
      id: targetId, 
      square: newSquare,
      name: s.name,
      roll: typeof roll === 'number' ? roll : undefined
    };
    
    console.log(`[DEBUG] Broadcasting move update:`, update);
    
    // Send to all clients
    io.emit('student-move-update', update);
    
    // Also update the student list
    broadcastStudentList();
  });

  socket.on('student-answer', ({ answerIdx }) => {
    if (!rateLimit(socket.id, 'student-answer')) return;
    console.log('[DEBUG] student-answer received:', answerIdx, 'from', socket.id);
    if (typeof answerIdx !== 'number' || answerIdx < 0 || answerIdx > 3) return;
    
    // Record student answer for replay mode (doesn't affect live game)
    if (currentGameSession) {
      const student = students.get(socket.id);
      gameDatabase.logEvent(currentGameSession.id, 'student_answer', {
        student_id: socket.id,
        student_name: student?.name || 'Unknown',
        answer_idx: answerIdx,
        question_idx: currentQuestionIdx,
        phase: currentPhase,
        timestamp: new Date().toISOString()
      }).catch(err => {
        console.log('[REPLAY] Error logging student answer:', err.message);
      });
    }
    
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
    // Complete current session if it exists (for replay mode)
    if (currentGameSession) {
      const finalPositions = Array.from(students.entries()).map(([id, s]) => ({
        id,
        name: s.name,
        square: s.square || 0,
        totalCorrect: 0 // TODO: Track correct answers
      }));
      gameDatabase.completeGame(currentGameSession.id, finalPositions).catch(err => {
        console.log('[REPLAY] Error completing session:', err.message);
      });
      currentGameSession = null;
    }
    
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
  socket.on('load-quiz-md', ({ content, filename }) => {
    // Limit quiz file size and validate type
    if (typeof content !== 'string' || content.length > 100000) return;
    console.log('[DEBUG] Loaded quiz markdown, length:', content?.length);
    
    // Create database session for replay mode (doesn't affect live game)
    if (filename) {
      gameDatabase.createGameSession(filename, content).then(session => {
        if (session) {
          currentGameSession = session;
          console.log(`[REPLAY] Session created: ${session.session_slug}`);
          
          // Send email notification with replay URL
          const teacherEmail = process.env.TEACHER_EMAIL;
          if (teacherEmail) {
            sendReplayNotification(teacherEmail, session.session_slug, filename)
              .then(sent => {
                if (sent) {
                  console.log(`[EMAIL] Replay notification sent to ${teacherEmail}`);
                } else {
                  console.log(`[EMAIL] Failed to send replay notification`);
                }
              });
          } else {
            console.log('[EMAIL] No TEACHER_EMAIL configured, skipping notification');
          }
        }
      }).catch(err => {
        console.log('[REPLAY] Session creation failed (continuing without replay):', err.message);
      });
    }
    
    // Broadcast to all clients so everyone loads the same quiz (unchanged)
    currentQuiz = { content };
    currentPhase = 1;
    currentQuestionIdx = 0;
    io.emit('quiz-md-loaded', { content });
  });

  // Teacher: advance phase and broadcast to all clients
  socket.on('advance-phase', ({ nextPhase, nextQuestionIdx }) => {
    console.log('[DEBUG] advance-phase received:', { nextPhase, nextQuestionIdx });
    
    // Record phase advancement for replay mode (doesn't affect live game)
    if (currentGameSession) {
      gameDatabase.logEvent(currentGameSession.id, 'phase_advance', {
        phase: nextPhase,
        question_idx: nextQuestionIdx,
        timestamp: new Date().toISOString()
      }).catch(err => {
        console.log('[REPLAY] Error logging phase advance:', err.message);
      });
    }
    
    currentPhase = nextPhase;
    currentQuestionIdx = nextQuestionIdx;
    io.emit('advance-phase', { nextPhase, nextQuestionIdx });
  });

  // --- Admin sync request: send current quiz and phase to admin clients ---
  socket.on('admin-sync-request', () => {
    if (currentQuiz && currentQuiz.content) {
      socket.emit('quiz-md-loaded', { content: currentQuiz.content });
      socket.emit('advance-phase', { nextPhase: currentPhase, nextQuestionIdx: currentQuestionIdx });
    }
  });

  // --- Admin adjust student square ---
  socket.on('admin-adjust-square', ({ id, square }) => {
    if (!rateLimit(socket.id, 'admin-adjust-square')) return;
    if (!id || typeof square !== 'number' || square < 0) return;
    
    const student = students.get(id);
    if (!student) return;
    
    // Update the student's position
    student.square = square;
    
    // Broadcast the update to all clients
    const update = { 
      id, 
      square,
      name: student.name
    };
    
    io.emit('student-move-update', update);
    broadcastStudentList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  
  // Initialize database tables (safe if no database connection)
  try {
    await createTables();
  } catch (error) {
    console.log('[DATABASE] Table creation skipped (no database connection)');
  }
});
