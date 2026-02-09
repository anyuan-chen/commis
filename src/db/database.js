import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

// Ensure data directory exists
if (!existsSync(config.paths.db)) {
  mkdirSync(config.paths.db, { recursive: true });
}

const dbPath = join(config.paths.db, 'commis.db');

// Initialize SQL.js
const SQL = await initSqlJs();

// Load existing database or create new one
let db;
if (existsSync(dbPath)) {
  const buffer = readFileSync(dbPath);
  db = new SQL.Database(buffer);
} else {
  db = new SQL.Database();
}

// Save database to file
function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}

// Initialize schema
const schemaPath = join(config.paths.root, 'src', 'db', 'schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');

// Split schema into individual statements and execute each
const statements = schema.split(';').filter(s => s.trim());
for (const statement of statements) {
  try {
    db.run(statement);
  } catch (err) {
    // Ignore "table already exists" errors
    if (!err.message.includes('already exists')) {
      console.error('Schema error:', err.message);
    }
  }
}

// Migrations for existing databases
const migrations = [
  // Add ASMR output path column for dual short types
  'ALTER TABLE shorts_jobs ADD COLUMN output_path_asmr TEXT',
  // Add reviews_enabled column for opt-in review aggregation
  'ALTER TABLE restaurants ADD COLUMN reviews_enabled INTEGER DEFAULT 0',
  // Add google_place_id for restaurant lookup via Google Places
  'ALTER TABLE restaurants ADD COLUMN google_place_id TEXT',
  // Add ASMR YouTube columns for dual upload
  'ALTER TABLE shorts_jobs ADD COLUMN asmr_youtube_video_id TEXT',
  'ALTER TABLE shorts_jobs ADD COLUMN asmr_youtube_url TEXT',
  // Extensible variants column — JSON array of { type, outputPath, youtubeVideoId, youtubeUrl }
  'ALTER TABLE shorts_jobs ADD COLUMN variants_json TEXT',
  // Website generation jobs table
  `CREATE TABLE IF NOT EXISTS website_jobs (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    progress_stage TEXT,
    error_message TEXT,
    material_id TEXT,
    output_path TEXT,
    deployed_url TEXT,
    use_iterative INTEGER DEFAULT 0,
    iterations_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
  )`
];

// Create indexes (separate from migrations to handle "already exists" gracefully)
const indexes = [
  'CREATE INDEX idx_restaurants_place_id ON restaurants(google_place_id)',
  'CREATE INDEX idx_website_jobs_restaurant ON website_jobs(restaurant_id)',
  'CREATE INDEX idx_website_jobs_status ON website_jobs(status)'
];

for (const index of indexes) {
  try {
    db.run(index);
  } catch (err) {
    // Ignore "already exists" errors
    if (!err.message.includes('already exists')) {
      console.error('Index error:', err.message);
    }
  }
}

for (const migration of migrations) {
  try {
    db.run(migration);
  } catch (err) {
    // Ignore "duplicate column" errors for migrations that already ran
    if (!err.message.includes('duplicate column')) {
      console.error('Migration error:', err.message);
    }
  }
}

saveDatabase();

// Wrapper to match better-sqlite3 API style
const dbWrapper = {
  prepare(sql) {
    return {
      run(...params) {
        db.run(sql, params);
        saveDatabase();
        return { changes: db.getRowsModified() };
      },
      get(...params) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const results = [];
        const stmt = db.prepare(sql);
        stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      }
    };
  },
  exec(sql) {
    db.exec(sql);
    saveDatabase();
  },
  pragma() {
    // sql.js doesn't support pragma the same way, ignore
  }
};

export default dbWrapper;
