const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'support.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- owner | admin
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_contact TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | active | closed
  assigned_admin_id INTEGER,
  assigned_admin_name TEXT,
  outcome TEXT, -- approved | rejected | null
  solution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL, -- customer | admin | system
  sender_name TEXT NOT NULL,
  content TEXT,
  attachment_url TEXT,
  attachment_type TEXT, -- image | video | audio
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Seed the fixed owner account once
const ownerRow = db.prepare('SELECT * FROM admins WHERE role = ?').get('owner');
if (!ownerRow) {
  const hash = bcrypt.hashSync('asdasd1428D', 10);
  db.prepare(`INSERT INTO admins (email, password_hash, name, role) VALUES (?, ?, ?, 'owner')`)
    .run('slomsalman2@gmail.com', hash, 'المالك');
} else {
  // keep the owner's email fixed/correct without touching their password if they changed it
  db.prepare(`UPDATE admins SET email = ? WHERE role = 'owner'`).run('slomsalman2@gmail.com');
}

module.exports = { db };
