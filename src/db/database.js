import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

// Ensure data directory exists
if (!existsSync(config.paths.db)) {
  mkdirSync(config.paths.db, { recursive: true });
}

const dbPath = join(config.paths.db, 'videoresto.db');

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
