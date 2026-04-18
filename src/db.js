const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const db = new sqlite3.Database(
  path.join(__dirname, "..", "codeframe.db"),
  (err) => {
    if (err) {
      console.error("DB error:", err);
    } else {
      console.log("SQLite connected");
    }
  }
);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT,
      avatar_url TEXT,
      plan_days INTEGER,
      subscription_end TEXT,
      active INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(discord_id, usage_date, config_hash)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS login_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
});

module.exports = db;