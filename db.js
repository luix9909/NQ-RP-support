const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'support.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_contact TEXT,
  subject TEXT NOT NULL,
  problem_location TEXT,
  problem_details TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  assigned_admin_id INTEGER,
  assigned_admin_name TEXT,
  outcome TEXT,
  solution TEXT,
  rating INTEGER,
  rating_reason TEXT,
  rated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT,
  attachment_url TEXT,
  attachment_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS canned_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Seed default canned replies if empty
const cannedCount = db.prepare('SELECT COUNT(*) AS c FROM canned_replies').get().c;
if (cannedCount === 0) {
  const ins = db.prepare('INSERT INTO canned_replies (title, content) VALUES (?, ?)');
  [
    ['ترحيب', 'مرحباً بك في ناقة 🌟 كيف أقدر أخدمك؟'],
    ['انتظار', 'الرجاء الانتظار قليلاً، سأكون معك خلال لحظات 🙏'],
    ['طلب تفاصيل', 'ممكن تعطيني تفاصيل أكثر عن المشكلة؟ ومتى بدأت؟'],
    ['طلب صورة', 'لو تقدر ترسل صورة أو لقطة شاشة للمشكلة يساعدني كثير 📎'],
    ['تم الحل', 'تم حل المشكلة. هل في أي شيء ثاني أقدر أساعدك فيه؟'],
    ['شكر', 'شكراً لتواصلك معنا، سعداء بخدمتك 💜'],
  ].forEach(([t, body]) => ins.run(t, body));
}


// Migrations for existing DBs
try { db.exec('ALTER TABLE tickets ADD COLUMN problem_location TEXT'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN problem_details TEXT'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN rating INTEGER'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN rating_reason TEXT'); } catch {}
try { db.exec('ALTER TABLE tickets ADD COLUMN rated_at TEXT'); } catch {}

const ownerRow = db.prepare('SELECT * FROM admins WHERE role = ?').get('owner');
const OWNER_EMAIL = 'slomsalman2@gmail.com';
const OWNER_PASS = process.env.OWNER_PASSWORD || 'asdasd1428D';
if (!ownerRow) {
  const hash = bcrypt.hashSync(OWNER_PASS, 10);
  db.prepare(`INSERT INTO admins (email, password_hash, name, role) VALUES (?, ?, ?, 'owner')`)
    .run(OWNER_EMAIL, hash, 'المالك');
  console.log('Owner account created:', OWNER_EMAIL);
} else {
  db.prepare(`UPDATE admins SET email = ? WHERE role = 'owner'`).run(OWNER_EMAIL);
  // If RESET_OWNER_PASSWORD=1, reset password (useful when login breaks after redeploy)
  if (process.env.RESET_OWNER_PASSWORD === '1') {
    const hash = bcrypt.hashSync(OWNER_PASS, 10);
    db.prepare(`UPDATE admins SET password_hash = ? WHERE role = 'owner'`).run(hash);
    console.log('Owner password was reset');
  }
}

const stmts = {
  getAdminById: db.prepare('SELECT * FROM admins WHERE id = ?'),
  getAdminByEmail: db.prepare('SELECT * FROM admins WHERE lower(email) = lower(?)'),
  insertAdmin: db.prepare(`INSERT INTO admins (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')`),
  listAdmins: db.prepare('SELECT id, email, name, role, created_at FROM admins ORDER BY id'),
  deleteAdmin: db.prepare('DELETE FROM admins WHERE id = ?'),
  updateAdmin: db.prepare('UPDATE admins SET name = ?, email = ? WHERE id = ?'),

  getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
  getTicketByToken: db.prepare('SELECT * FROM tickets WHERE access_token = ?'),
  insertTicket: db.prepare(
    `INSERT INTO tickets (access_token, customer_name, customer_contact, subject, problem_location, problem_details) VALUES (?, ?, ?, ?, ?, ?)`
  ),
  listTicketsByStatus: db.prepare('SELECT * FROM tickets WHERE status = ? ORDER BY id'),
  listTicketsRecent: db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 400'),
  acceptTicket: db.prepare(
    `UPDATE tickets SET status = 'active', assigned_admin_id = ?, assigned_admin_name = ?, accepted_at = datetime('now') WHERE id = ?`
  ),
  closeTicket: db.prepare(
    `UPDATE tickets SET status = 'closed', outcome = ?, solution = ?, closed_at = datetime('now') WHERE id = ?`
  ),
  rateTicket: db.prepare(
    `UPDATE tickets SET rating = ?, rating_reason = ?, rated_at = datetime('now') WHERE id = ? AND access_token = ?`
  ),
  queueCount: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'waiting' AND id <= ?`),
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

  todayResolved: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'closed' AND date(closed_at) = date('now')`),
  totalTickets: db.prepare('SELECT COUNT(*) AS c FROM tickets'),
  totalResolved: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'closed'`),
  waitingNow: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'waiting'`),
  activeNow: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status = 'active'`),
  byAdminToday: db.prepare(
    `SELECT assigned_admin_name AS name, COUNT(*) AS c FROM tickets
     WHERE status = 'closed' AND date(closed_at) = date('now') AND assigned_admin_name IS NOT NULL
     GROUP BY assigned_admin_name ORDER BY c DESC`
  ),

  // Ratings / reviews for owner
  adminRatings: db.prepare(
    `SELECT t.id, t.customer_name, t.subject, t.rating, t.rating_reason, t.rated_at, t.outcome, t.solution,
            t.assigned_admin_id, t.assigned_admin_name, t.closed_at
     FROM tickets t
     WHERE t.rating IS NOT NULL
     ORDER BY t.rated_at DESC LIMIT 500`
  ),
  ratingsByAdmin: db.prepare(
    `SELECT assigned_admin_id, assigned_admin_name,
            COUNT(*) AS total,
            AVG(rating) AS avg_rating,
            SUM(CASE WHEN rating <= 3 THEN 1 ELSE 0 END) AS low_count
     FROM tickets
     WHERE rating IS NOT NULL AND assigned_admin_id IS NOT NULL
     GROUP BY assigned_admin_id, assigned_admin_name
     ORDER BY avg_rating ASC`
  ),
  deleteTicket: db.prepare('DELETE FROM tickets WHERE id = ?'),
  deleteMessages: db.prepare('DELETE FROM messages WHERE ticket_id = ?'),

  listCanned: db.prepare('SELECT * FROM canned_replies ORDER BY id'),
  insertCanned: db.prepare('INSERT INTO canned_replies (title, content, created_by) VALUES (?, ?, ?)'),
  deleteCanned: db.prepare('DELETE FROM canned_replies WHERE id = ?'),
  updateCanned: db.prepare('UPDATE canned_replies SET title = ?, content = ? WHERE id = ?'),
};

function closeDb() {
  try { if (db) db.close(); } catch {}
}
process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
process.on('exit', closeDb);

module.exports = { db, stmts, closeDb };
