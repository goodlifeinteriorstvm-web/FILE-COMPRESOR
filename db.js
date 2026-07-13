const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Uses the Railway volume mount path when deployed (RAILWAY_VOLUME_MOUNT_PATH),
// falls back to a local ./data folder for local development.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL,        -- pdf | jpg | png
    original_path TEXT NOT NULL,
    compressed_path TEXT,
    original_size INTEGER NOT NULL,
    compressed_size INTEGER,
    quality INTEGER,
    saved_percent REAL,
    pages INTEGER,
    status TEXT DEFAULT 'uploaded', -- uploaded | compressing | done | error
    uploaded_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

module.exports = db;
module.exports.DATA_DIR = DATA_DIR;

