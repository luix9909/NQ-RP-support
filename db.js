const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// On Render free tier the project dir can be tricky; prefer /tmp if DB_PATH not set
const dbPath = process.env.DB_PATH || path.join(__dirname, 'support.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create tables
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

// Pre-prepare frequently used statements (avoids create/destroy churn that triggers
// native cleanup crashes on some Node + better-sqlite3 combinations on Render)
const stmts = {
  getAdminById: db.prepare('SELECT * FROM admins WHERE id = ?'),
  getAdminByEmail: db.prepare('SELECT * FROM admins WHERE email = ? COLLATE NOCASE'),
  insertAdmin: db.prepare(`INSERT INTO admins (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')`),
  listAdmins: db.prepare('SELECT id, email, name, role FROM admins ORDER BY id'),
  deleteAdmin: db.prepare('DELETE FROM admins WHERE id = ?'),

  getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
  insertTicket: db.prepare(
    `INSERT INTO tickets (access_token, customer_name, customer_contact, subject) VALUES (?, ?, ?, ?)`
  ),
  listTicketsByStatus: db.prepare('SELECT * FROM tickets WHERE status = ? ORDER BY id'),
  listTicketsRecent: db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 300'),
  acceptTicket: db.prepare(
    `UPDATE tickets SET status = 'active', assigned_admin_id = ?, assigned_admin_name = ?, accepted_at = datetime('now') WHERE id = ?`
  ),
  closeTicket: db.prepare(
    `UPDATE tickets SET status = 'closed', outcome = ?, solution = ?, closed_at = datetime('now') WHERE id = ?`
  ),
  queueCount: db.prepare(
    `SELECT COUNT(*) AS c FROM tickets WHERE status = 'waiting' AND id <= ?`
  ),
  waitingIds: db.prepare(`SELECT id FROM tickets WHERE status = 'waiting' ORDER BY id`),
  avgHandling: db.prepare(
    `SELECT accepted_at, closed_at FROM tickets
     WHERE status = 'closed' AND accepted_at IS NOT NULL AND closed_at IS NOT NULL
     ORDER BY id DESC LIMIT 20`
  ),

  insertMessage: db.prepare(
    `INSERT INTO messages (ticket_id, sender_type, sender_name, content, attachment_url, attachment_type) VALUES (?, ?, ?, ?, ?, ?)`
  ),
  insertSystemMessage: db.prepare(
    `INSERT INTO messages (ticket_id, sender_type, sender_name, content) VALUES (?, 'system', 'النظام', ?)`
  ),
  getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  listMessages: db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id'),

  // stats
  todayResolved: db.prepare(
    `SELECT COUNT(*) AS c FROM tickets WHERE status = 'closed' AND date(closed_at) = date('now')`
  ),
  totalTickets: db.prepare('SELECT COUNT(*) AS c FROM tickets'),
  totalResolved: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'closed'`),
  waitingNow: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'waiting'`),
  activeNow: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'active'`),
  byAdminToday: db.prepare(
    `SELECT assigned_admin_name AS name, COUNT(*) AS c FROM tickets
     WHERE status = 'closed' AND date(closed_at) = date('now') AND assigned_admin_name IS NOT NULL
     GROUP BY assigned_admin_name ORDER BY c DESC`
  ),
};

function closeDb() {
  try {
    if (db && db.open) db.close();
  } catch (_) {}
}

process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
process.on('exit', closeDb);

module.exports = { db, stmts, closeDb };
