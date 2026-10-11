const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ENV } = require('./config');

fs.mkdirSync(ENV.DATA_DIR, { recursive: true });
const db = new Database(path.join(ENV.DATA_DIR, 'game.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT, first_name TEXT, is_premium INTEGER DEFAULT 0, lang TEXT,
  balance REAL DEFAULT 0, total_earned REAL DEFAULT 0,
  energy REAL, max_energy INTEGER, regen INTEGER, tap_power INTEGER,
  passive_per_hour INTEGER DEFAULT 0,
  last_energy INTEGER, last_passive INTEGER, last_tap INTEGER, last_seen INTEGER,
  referrer_id INTEGER,
  daily_streak INTEGER DEFAULT 0, last_daily TEXT,
  skin TEXT DEFAULT 'gold',
  boost_until INTEGER DEFAULT 0, vip_until INTEGER DEFAULT 0,
  stars_spent INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  notify INTEGER DEFAULT 1, last_notified INTEGER DEFAULT 0, bot_blocked INTEGER DEFAULT 0,
  created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_users_ref ON users(referrer_id);
CREATE INDEX IF NOT EXISTS idx_users_total ON users(total_earned DESC);
CREATE INDEX IF NOT EXISTS idx_users_seen ON users(last_seen);

CREATE TABLE IF NOT EXISTS levels(user_id INTEGER, key TEXT, level INTEGER, PRIMARY KEY(user_id, key));
CREATE TABLE IF NOT EXISTS skins_owned(user_id INTEGER, skin TEXT, PRIMARY KEY(user_id, skin));
CREATE TABLE IF NOT EXISTS pending_refs(user_id INTEGER PRIMARY KEY, referrer_id INTEGER);

CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, icon TEXT DEFAULT '⭐', reward INTEGER NOT NULL,
  type TEXT NOT NULL,          -- channel | link | refs
  url TEXT, chat_id TEXT, need INTEGER,
  active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS task_progress(
  user_id INTEGER, task_id INTEGER, started_at INTEGER, done_at INTEGER,
  PRIMARY KEY(user_id, task_id));

CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, product TEXT, stars INTEGER,
  charge_id TEXT UNIQUE, status TEXT DEFAULT 'paid',
  created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_pay_time ON payments(created_at);

CREATE TABLE IF NOT EXISTS broadcasts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT, button_text TEXT, button_url TEXT,
  status TEXT DEFAULT 'queued',  -- queued | running | done | cancelled
  cursor INTEGER DEFAULT 0, total INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
  created_at INTEGER, finished_at INTEGER);
`);

// Стартовые задания при первом запуске
if (db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n === 0) {
  const ins = db.prepare('INSERT INTO tasks(title, icon, reward, type, need, sort, created_at) VALUES(?,?,?,?,?,?,?)');
  ins.run('Пригласи 3 друзей', '👥', 25000, 'refs', 3, 10, Date.now());
  ins.run('Пригласи 10 друзей', '🤝', 150000, 'refs', 10, 11, Date.now());
}

module.exports = db;
