const { Pool } = require('pg');

// Database connection pool
let pool = null;

// Initialize database connection
function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('[DATABASE] No DATABASE_URL found, replay features disabled');
    return null;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    // Test connection
    pool.on('connect', () => {
      console.log('[DATABASE] Connected to PostgreSQL');
    });

    pool.on('error', (err) => {
      console.error('[DATABASE] Unexpected error on idle client', err);
    });

    return pool;
  } catch (error) {
    console.error('[DATABASE] Failed to initialize:', error);
    return null;
  }
}

// Database schema creation
const createTables = async () => {
  if (!pool) return false;

  try {
    // Games table - stores quiz sessions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_slug VARCHAR(255) UNIQUE NOT NULL,
        quiz_filename VARCHAR(255),
        quiz_content TEXT,
        teacher_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'active'
      )
    `);

    // Game events table - chronological log of everything that happens
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_events (
        id SERIAL PRIMARY KEY,
        game_id UUID REFERENCES games(id) ON DELETE CASCADE,
        event_type VARCHAR(100) NOT NULL,
        event_data JSONB,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Final positions table - end state of players
    await pool.query(`
      CREATE TABLE IF NOT EXISTS final_positions (
        id SERIAL PRIMARY KEY,
        game_id UUID REFERENCES games(id) ON DELETE CASCADE,
        student_id VARCHAR(255) NOT NULL,
        student_name VARCHAR(255),
        final_square INTEGER DEFAULT 0,
        total_correct INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_game_events_game_id ON game_events(game_id);
      CREATE INDEX IF NOT EXISTS idx_game_events_timestamp ON game_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_final_positions_game_id ON final_positions(game_id);
      CREATE INDEX IF NOT EXISTS idx_games_session_slug ON games(session_slug);
    `);

    console.log('[DATABASE] Tables created successfully');
    return true;
  } catch (error) {
    console.error('[DATABASE] Error creating tables:', error);
    return false;
  }
};

// Helper function to generate session slug from filename
function generateSessionSlug(filename) {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  // Extract base name from filename and clean it
  const baseName = filename
    .replace(/\.[^/.]+$/, '') // Remove extension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with dashes
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing dashes

  // Add random suffix for uniqueness
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  
  return `${date}-${baseName}-${randomSuffix}`;
}

// Game session management functions
const gameDatabase = {
  // Create a new game session
  async createGameSession(quizFilename, quizContent, teacherEmail = null) {
    if (!pool) return null;

    try {
      const sessionSlug = generateSessionSlug(quizFilename);
      
      const result = await pool.query(`
        INSERT INTO games (session_slug, quiz_filename, quiz_content, teacher_email)
        VALUES ($1, $2, $3, $4)
        RETURNING id, session_slug
      `, [sessionSlug, quizFilename, quizContent, teacherEmail]);

      console.log(`[DATABASE] Created game session: ${sessionSlug}`);
      return result.rows[0];
    } catch (error) {
      console.error('[DATABASE] Error creating game session:', error);
      return null;
    }
  },

  // Log an event during the game
  async logEvent(gameId, eventType, eventData) {
    if (!pool || !gameId) return false;

    try {
      await pool.query(`
        INSERT INTO game_events (game_id, event_type, event_data)
        VALUES ($1, $2, $3)
      `, [gameId, eventType, JSON.stringify(eventData)]);

      return true;
    } catch (error) {
      console.error('[DATABASE] Error logging event:', error);
      return false;
    }
  },

  // Get game session by slug (for replay mode)
  async getGameSession(sessionSlug) {
    if (!pool) return null;

    try {
      const result = await pool.query(`
        SELECT * FROM games WHERE session_slug = $1
      `, [sessionSlug]);

      return result.rows[0] || null;
    } catch (error) {
      console.error('[DATABASE] Error getting game session:', error);
      return null;
    }
  },

  // Get all events for a game session
  async getGameEvents(gameId) {
    if (!pool) return [];

    try {
      const result = await pool.query(`
        SELECT * FROM game_events 
        WHERE game_id = $1 
        ORDER BY timestamp ASC
      `, [gameId]);

      return result.rows;
    } catch (error) {
      console.error('[DATABASE] Error getting game events:', error);
      return [];
    }
  },

  // Mark game as completed and save final positions
  async completeGame(gameId, finalPositions) {
    if (!pool || !gameId) return false;

    try {
      // Mark game as completed
      await pool.query(`
        UPDATE games SET completed_at = CURRENT_TIMESTAMP, status = 'completed'
        WHERE id = $1
      `, [gameId]);

      // Save final positions
      for (const position of finalPositions) {
        await pool.query(`
          INSERT INTO final_positions (game_id, student_id, student_name, final_square, total_correct)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
        `, [gameId, position.id, position.name, position.square || 0, position.totalCorrect || 0]);
      }

      console.log(`[DATABASE] Game ${gameId} marked as completed`);
      return true;
    } catch (error) {
      console.error('[DATABASE] Error completing game:', error);
      return false;
    }
  },

  // Get final positions for a game session
  async getFinalPositions(gameId) {
    if (!pool) return [];

    try {
      const result = await pool.query(`
        SELECT * FROM final_positions 
        WHERE game_id = $1 
        ORDER BY final_square DESC, student_name ASC
      `, [gameId]);

      return result.rows;
    } catch (error) {
      console.error('[DATABASE] Error getting final positions:', error);
      return [];
    }
  }
};

// Test database connection
async function testConnection() {
  if (!pool) {
    console.log('[DATABASE] No database connection available');
    return false;
  }

  try {
    const result = await pool.query('SELECT NOW()');
    console.log('[DATABASE] Connection test successful:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('[DATABASE] Connection test failed:', error);
    return false;
  }
}

module.exports = {
  initDatabase,
  createTables,
  gameDatabase,
  testConnection,
  generateSessionSlug
};