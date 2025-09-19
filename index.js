const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const { sanitizeName, rateLimit } = require('./utils');
const { buildDisconnectInfo, sendDisconnectWebhook } = require('./disconnectDiagnostics');
const { initDatabase, createTables, gameDatabase, testConnection } = require('./database');
const { initEmailService, sendReplayNotification, testEmailService } = require('./emailService');
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
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
    
    // Allow requests from allowed origins
    if (allowedOrigins && allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Allow requests from the backend's own domain (for deletion pages)
    const backendUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL;
    if (backendUrl && origin === backendUrl) {
      return callback(null, true);
    }
    
    // For development, allow localhost
    if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return callback(null, true);
    }
    
    console.log('[CORS] Blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
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

// Test endpoint to check if session exists
app.get('/api/session/:sessionSlug/exists', async (req, res) => {
  try {
    const { sessionSlug } = req.params;
    const session = await gameDatabase.getGameSession(sessionSlug);
    
    res.json({
      exists: !!session,
      session_slug: sessionSlug,
      session: session ? {
        id: session.id,
        quiz_filename: session.quiz_filename,
        created_at: session.created_at
      } : null
    });
  } catch (error) {
    console.error('[API] Error checking session existence:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Failed to check session existence'
    });
  }
});

// Simple deletion page for sessions
app.get('/delete/:sessionSlug', async (req, res) => {
  try {
    const { sessionSlug } = req.params;
    const session = await gameDatabase.getGameSession(sessionSlug);
    
    if (!session) {
      return res.send(`
        <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2>Session Not Found</h2>
          <p>No replay session found with ID: <code>${sessionSlug}</code></p>
        </body></html>
      `);
    }
    
    res.send(`
      <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h2>Delete Replay Session</h2>
        <div style="background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <strong>Quiz:</strong> ${session.quiz_filename}<br>
          <strong>Created:</strong> ${new Date(session.created_at).toLocaleString()}<br>
          <strong>Session ID:</strong> ${sessionSlug}
        </div>
        
        <p><strong>⚠️ Warning:</strong> This action cannot be undone. The replay session and all associated data will be permanently deleted.</p>
        
        <form method="POST" action="/delete/${sessionSlug}" onsubmit="return confirm('Are you sure you want to delete this replay session?')">
          <button type="submit" style="background: #dc2626; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;">
            🗑️ Delete Session
          </button>
        </form>
      </body></html>
    `);
  } catch (error) {
    console.error('[API] Error showing deletion page:', error);
    res.status(500).send('Server error');
  }
});

// Handle form submission for session deletion
app.post('/delete/:sessionSlug', async (req, res) => {
  try {
    const { sessionSlug } = req.params;
    console.log(`[DELETE POST] Attempting to delete session: ${sessionSlug}`);
    
    const session = await gameDatabase.getGameSession(sessionSlug);
    
    if (!session) {
      return res.send(`
        <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2>Session Not Found</h2>
          <p>No replay session found with ID: <code>${sessionSlug}</code></p>
          <p>It may have already been deleted.</p>
        </body></html>
      `);
    }
    
    const deleted = await gameDatabase.deleteGameSession(session.id);
    
    if (deleted) {
      console.log(`[DELETE POST] Successfully deleted session: ${sessionSlug}`);
      res.send(`
        <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2>✅ Session Deleted Successfully</h2>
          <div style="background: #dcfce7; color: #166534; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <strong>Deleted:</strong> ${session.quiz_filename}<br>
            <strong>Session ID:</strong> ${sessionSlug}
          </div>
          <p>The replay session and all associated data have been permanently deleted.</p>
        </body></html>
      `);
    } else {
      console.log(`[DELETE POST] Failed to delete session: ${sessionSlug}`);
      res.send(`
        <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2>❌ Deletion Failed</h2>
          <p>Failed to delete session: <code>${sessionSlug}</code></p>
          <p>Please try again or contact support.</p>
        </body></html>
      `);
    }
  } catch (error) {
    console.error('[DELETE POST] Error deleting session:', error);
    res.send(`
      <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h2>❌ Error</h2>
        <p>An error occurred while deleting the session.</p>
        <p>Error: ${error.message}</p>
      </body></html>
    `);
  }
});

// Delete a replay session (for cleanup)
app.delete('/api/session/:sessionSlug', async (req, res) => {
  try {
    const { sessionSlug } = req.params;
    console.log(`[DELETE] Attempting to delete session: ${sessionSlug}`);
    
    const session = await gameDatabase.getGameSession(sessionSlug);
    console.log(`[DELETE] Session found:`, session ? 'yes' : 'no');
    
    if (!session) {
      console.log(`[DELETE] Session not found: ${sessionSlug}`);
      return res.status(404).json({ 
        error: 'Session not found',
        message: `No replay session found with ID: ${sessionSlug}`
      });
    }
    
    console.log(`[DELETE] Attempting to delete session ID: ${session.id}`);
    const deleted = await gameDatabase.deleteGameSession(session.id);
    console.log(`[DELETE] Deletion result:`, deleted);
    
    if (deleted) {
      console.log(`[DELETE] Successfully deleted session: ${sessionSlug}`);
      res.json({
        message: 'Session deleted successfully',
        session_slug: sessionSlug
      });
    } else {
      console.log(`[DELETE] Failed to delete session: ${sessionSlug}`);
      res.status(500).json({
        error: 'Failed to delete session',
        message: 'Database deletion operation failed'
      });
    }
  } catch (error) {
    console.error('[DELETE] Error deleting session:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: `Failed to delete session: ${error.message}`
    });
  }
});

// --- Student state (in-memory, non-persistent; replace with DB for prod) ---
// Map of persistent student_id => { name, joinedAt, square, sockets:Set<socket.id> }
const students = new Map();
// Map of socket.id => student_id for quick lookup
const socketToStudent = new Map();
// Map of student_id => answerIdx (integer)
const answers = new Map();
// Map of student_id => timeout for cleanup delay
const disconnectTimers = new Map();
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS || '15000', 10);
let currentQuiz = null; // { content: string }
let currentPhase = 1;
let currentQuestionIdx = 0;

// --- Quizmaster state ---
let quizmasterEnabled = true;
let quizmasterName = "Math Dad";
let quizmasterSquare = 0;

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

function broadcastQuizmasterState() {
  io.emit('quizmaster-state', {
    enabled: quizmasterEnabled,
    name: quizmasterName,
    square: quizmasterSquare
  });
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

  socket.on('student-join', ({ name, student_id, square }) => {
    // Increase rate limit for large sessions
    const maxStudents = students.size;
    const rateMultiplier = Math.max(1, Math.ceil(maxStudents / 25));
    if (!rateLimit(socket.id, 'student-join', 2 * rateMultiplier)) return;
    
    const cleanName = sanitizeName(name);
    if (!cleanName) return;

    const studentId = student_id || socket.id;
    const resumeSquare = typeof square === 'number' && square >= 0 ? square : null;

    // Cancel any pending cleanup for this student
    if (disconnectTimers.has(studentId)) {
      clearTimeout(disconnectTimers.get(studentId));
      disconnectTimers.delete(studentId);
      console.log(`Student ${cleanName} rejoined, cancelled cleanup (${studentId})`);
    }

    let student = students.get(studentId);
    if (student) {
      // Existing student reconnecting; just add this socket
      student.sockets.add(socket.id);
      if (resumeSquare !== null && typeof student.square !== 'number') {
        student.square = resumeSquare;
      }
      if (resumeSquare !== null && typeof student.square === 'number' && student.square !== resumeSquare) {
        console.log(`[RECOVERY] Updating square for ${cleanName} (${studentId}) from ${student.square} to ${resumeSquare}`);
        student.square = resumeSquare;
      }
    } else {
      const startingSquare = resumeSquare !== null ? resumeSquare : 0;
      student = { name: cleanName, joinedAt: Date.now(), square: startingSquare, sockets: new Set([socket.id]) };
      students.set(studentId, student);
    }

    socketToStudent.set(socket.id, studentId);
    const squareInfo = typeof student.square === 'number' ? ` square=${student.square}` : '';
    console.log(`Student joined: ${cleanName} (${studentId}) via socket ${socket.id}${squareInfo}`);
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
    const targetId = id || socketToStudent.get(socket.id);
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
    const studentId = socketToStudent.get(socket.id);
    console.log('[DEBUG] student-answer received:', answerIdx, 'from', studentId);
    if (typeof answerIdx !== 'number' || answerIdx < 0 || answerIdx > 3 || !studentId) return;

    // Record student answer for replay mode (doesn't affect live game)
    if (currentGameSession) {
      const student = students.get(studentId);
      gameDatabase.logEvent(currentGameSession.id, 'student_answer', {
        student_id: studentId,
        student_name: student?.name || 'Unknown',
        answer_idx: answerIdx,
        question_idx: currentQuestionIdx,
        phase: currentPhase,
        timestamp: new Date().toISOString()
      }).catch(err => {
        console.log('[REPLAY] Error logging student answer:', err.message);
      });
    }

    answers.set(studentId, answerIdx);
    broadcastVotes();
  });

  socket.on('disconnect', (reason) => {
    const studentId = socketToStudent.get(socket.id);
    const student = students.get(studentId);
    const studentName = student ? student.name : 'Unknown';
    const priorSocketCount = student ? student.sockets.size : 0;
    const hadAnswer = studentId ? answers.has(studentId) : false;

    socketToStudent.delete(socket.id);
    if (student) {
      student.sockets.delete(socket.id);
    }

    const remainingSockets = student ? student.sockets.size : 0;
    const disconnectInfo = buildDisconnectInfo(socket, reason, studentName, {
      studentId,
      priorSocketCount,
      remainingSockets,
      hadStudentRecord: Boolean(student),
      hasAnswer: hadAnswer,
      square: student?.square ?? null,
      totalStudents: students.size,
      phase: currentPhase,
      questionIdx: currentQuestionIdx,
      cleanupScheduled: remainingSockets === 0,
      cleanupDelayMs: DISCONNECT_GRACE_MS,
      sessionSlug: currentGameSession?.session_slug ?? null,
    });

    console.warn('[DISCONNECT]', disconnectInfo);
    sendDisconnectWebhook(disconnectInfo);

    if (!student) {
      return;
    }

    if (remainingSockets === 0) {
      console.log(`[DISCONNECT] Scheduling cleanup for ${studentName} (${studentId}) in ${DISCONNECT_GRACE_MS}ms (reason: ${reason})`);
      // Start a timer to allow reconnection before cleanup
      disconnectTimers.set(studentId, setTimeout(() => {
        const record = students.get(studentId);
        if (record && record.sockets.size === 0) {
          const hadAnswerAtCleanup = answers.has(studentId);
          const lastSquare = record?.square ?? 0;
          console.log(`[DISCONNECT] Grace period expired for ${studentName} (${studentId}); removing from session. lastSquare=${lastSquare} hadAnswer=${hadAnswerAtCleanup}`);
          students.delete(studentId);
          answers.delete(studentId);
          broadcastStudentList();
          broadcastVotes();
        } else {
          console.log(`[DISCONNECT] ${studentName} (${studentId}) reconnected before cleanup; skipping removal.`);
        }
        disconnectTimers.delete(studentId);
      }, DISCONNECT_GRACE_MS));
    } else {
      console.log(`[DISCONNECT] ${studentName} (${studentId}) still has ${remainingSockets} active socket(s); skipping cleanup timer.`);
    }
  });

  socket.on('ping-from-client', (msg) => {
    socket.emit('pong-from-server', `Pong! Server received: ${msg}`);
  });

  // Student state synchronization - check if student exists in backend
  socket.on('student-sync-request', () => {
    const studentId = socketToStudent.get(socket.id);
    const student = students.get(studentId);
    if (student) {
      socket.emit('student-sync-response', {
        exists: true,
        data: { id: studentId, name: student.name, joinedAt: student.joinedAt, square: student.square }
      });
    } else {
      socket.emit('student-sync-response', {
        exists: false
      });
    }
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
    // Clear all disconnect timers
    for (const timer of disconnectTimers.values()) {
      clearTimeout(timer);
    }
    disconnectTimers.clear();
    
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
    socketToStudent.clear();
    answers.clear();
    currentQuiz = null;
    currentPhase = 1;
    currentQuestionIdx = 0;
    quizmasterSquare = 0; // Reset quizmaster position
    broadcastStudentList();
    broadcastVotes();
    broadcastQuizmasterState();
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
  socket.on('advance-phase', ({ nextPhase, nextQuestionIdx, correctIdxs }) => {
    console.log('[DEBUG] advance-phase received:', { nextPhase, nextQuestionIdx, correctIdxs });
    
    // If advancing from phase 2 to 3, calculate quizmaster movement (always update position, regardless of enabled state)
    if (currentPhase === 2 && nextPhase === 3) {
      const totalAnswers = Array.from(answers.values()).filter(idx => typeof idx === 'number').length;
      
      if (totalAnswers > 0 && correctIdxs && Array.isArray(correctIdxs)) {
        // Count wrong answers by checking against correct answer indices
        const wrongAnswers = Array.from(answers.values()).filter(idx => 
          typeof idx === 'number' && !correctIdxs.includes(idx)
        ).length;
        
        const wrongRatio = wrongAnswers / totalAnswers;
        const quizmasterMove = Math.round(wrongRatio * 6);
        
        console.log('[QUIZMASTER] Total answers:', totalAnswers, 'Wrong answers:', wrongAnswers, 'Wrong ratio:', wrongRatio, 'Move:', quizmasterMove, 'Enabled:', quizmasterEnabled);
        
        if (quizmasterMove > 0) {
          quizmasterSquare = (quizmasterSquare + quizmasterMove) % 96;
          // Always broadcast state updates so frontend stays in sync
          broadcastQuizmasterState();
        }
      }
    }
    
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
      name: student.name,
      isAdminAdjustment: true // Flag to indicate this was an admin adjustment
    };
    
    io.emit('student-move-update', update);
    broadcastStudentList();
  });

  // --- Admin quizmaster controls ---
  socket.on('admin-toggle-quizmaster', ({ enabled }) => {
    if (!rateLimit(socket.id, 'admin-toggle-quizmaster')) return;
    if (typeof enabled !== 'boolean') return;
    
    quizmasterEnabled = enabled;
    console.log('[QUIZMASTER] Enabled:', enabled);
    broadcastQuizmasterState();
  });

  socket.on('admin-set-quizmaster-name', ({ name }) => {
    if (!rateLimit(socket.id, 'admin-set-quizmaster-name')) return;
    if (typeof name !== 'string' || name.length === 0 || name.length > 50) return;
    
    const cleanName = sanitizeName(name);
    if (!cleanName) return;
    
    quizmasterName = cleanName;
    console.log('[QUIZMASTER] Name set to:', cleanName);
    broadcastQuizmasterState();
  });

  socket.on('admin-adjust-quizmaster-square', ({ square }) => {
    if (!rateLimit(socket.id, 'admin-adjust-quizmaster-square')) return;
    if (typeof square !== 'number' || square < 0 || square > 96) return;
    
    quizmasterSquare = square;
    console.log('[QUIZMASTER] Square adjusted to:', square);
    broadcastQuizmasterState();
  });

  // Send current quizmaster state to new connections
  socket.on('get-quizmaster-state', () => {
    socket.emit('quizmaster-state', {
      enabled: quizmasterEnabled,
      name: quizmasterName,
      square: quizmasterSquare
    });
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

module.exports = { server, io, students, disconnectTimers };
