const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------------- uploads ----------------
const uploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, nanoid(12) + path.extname(file.originalname || '').slice(0, 10)),
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/|^video\/|^audio\//.test(file.mimetype);
    cb(ok ? null : new Error('نوع الملف غير مدعوم'), ok);
  },
});

// ---------------- in-memory sessions ----------------
const adminSessions = new Map(); // token -> adminId

function getAdminById(id) { return db.prepare('SELECT * FROM admins WHERE id = ?').get(id); }
function publicAdmin(a) { return { id: a.id, email: a.email, name: a.name, role: a.role }; }

function requireAdminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const adminId = adminSessions.get(token);
  if (!adminId) return res.status(401).json({ error: 'غير مصرح' });
  const admin = getAdminById(adminId);
  if (!admin) return res.status(401).json({ error: 'غير مصرح' });
  req.admin = admin;
  next();
}
function requireOwner(req, res, next) {
  if (req.admin.role !== 'owner') return res.status(403).json({ error: 'صلاحية المالك فقط' });
  next();
}

// ---------------- ticket helpers ----------------
function getTicket(id) { return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }
function publicTicket(t) {
  if (!t) return null;
  const { access_token, ...rest } = t;
  return rest;
}
function queuePosition(ticketId) {
  const t = getTicket(ticketId);
  if (!t || t.status !== 'waiting') return 0;
  const row = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE status = 'waiting' AND id <= ?`
  ).get(ticketId);
  return row.c;
}
function avgHandlingSeconds() {
  const rows = db.prepare(
    `SELECT accepted_at, closed_at FROM tickets
     WHERE status = 'closed' AND accepted_at IS NOT NULL AND closed_at IS NOT NULL
     ORDER BY id DESC LIMIT 20`
  ).all();
  if (!rows.length) return 300; // default estimate: 5 minutes
  const total = rows.reduce((sum, r) => {
    const secs = (new Date(r.closed_at + 'Z') - new Date(r.accepted_at + 'Z')) / 1000;
    return sum + Math.max(secs, 30);
  }, 0);
  return Math.round(total / rows.length);
}
function ticketStatusPayload(ticketId) {
  const t = getTicket(ticketId);
  if (!t) return null;
  const position = queuePosition(ticketId);
  const eta = t.status === 'waiting' ? position * avgHandlingSeconds() : 0;
  return {
    id: t.id, status: t.status, position, etaSeconds: eta,
    assignedAdminName: t.assigned_admin_name, outcome: t.outcome, solution: t.solution,
    subject: t.subject, customerName: t.customer_name,
  };
}
function broadcastQueue() {
  const waiting = db.prepare(`SELECT id FROM tickets WHERE status = 'waiting' ORDER BY id`).all();
  waiting.forEach(w => io.to('ticket:' + w.id).emit('ticket:status', ticketStatusPayload(w.id)));
  io.to('admins:queue').emit('queue:update');
}

// ---------------- PUBLIC: ticket creation & status ----------------
app.post('/api/tickets', (req, res) => {
  const { customerName, customerContact, subject } = req.body;
  if (!customerName || !customerName.trim()) return res.status(400).json({ error: 'الاسم مطلوب' });
  if (!subject || !subject.trim()) return res.status(400).json({ error: 'اكتب تفاصيل طلبك' });
  const accessToken = nanoid(24);
  const info = db.prepare(
    `INSERT INTO tickets (access_token, customer_name, customer_contact, subject) VALUES (?, ?, ?, ?)`
  ).run(accessToken, customerName.trim(), (customerContact || '').trim(), subject.trim());
  const id = info.lastInsertRowid;
  broadcastQueue();
  const status = ticketStatusPayload(id);
  res.json({ ...status, accessToken });
});

function verifyTicketToken(req, res, next) {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (req.query.token !== t.access_token) return res.status(403).json({ error: 'رمز الوصول غير صحيح' });
  req.ticket = t;
  next();
}

app.get('/api/tickets/:id/status', verifyTicketToken, (req, res) => {
  res.json(ticketStatusPayload(req.ticket.id));
});

app.get('/api/tickets/:id/messages', verifyTicketToken, (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(req.ticket.id));
});

// ---------------- uploads (customer needs ticket token, admin needs auth) ----------------
app.post('/api/upload', (req, res, next) => {
  const adminToken = (req.headers.authorization || '').replace('Bearer ', '');
  if (adminSessions.has(adminToken)) return next(); // admin path
  const ticketId = req.query.ticketId;
  const t = ticketId && getTicket(ticketId);
  if (!t || req.query.token !== t.access_token) return res.status(403).json({ error: 'غير مصرح بالرفع' });
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ما فيه ملف' });
  const type = req.file.mimetype.startsWith('image/') ? 'image'
             : req.file.mimetype.startsWith('video/') ? 'video' : 'audio';
  res.json({ url: '/uploads/' + req.file.filename, type });
});

// ---------------- ADMIN auth ----------------
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'أدخل الإيميل وكلمة المرور' });
  const admin = db.prepare('SELECT * FROM admins WHERE email = ? COLLATE NOCASE').get(email.trim());
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
  const token = nanoid(32);
  adminSessions.set(token, admin.id);
  res.json({ token, admin: publicAdmin(admin) });
});
app.get('/api/admin/me', requireAdminAuth, (req, res) => res.json({ admin: publicAdmin(req.admin) }));

app.post('/api/admin/admins', requireAdminAuth, requireOwner, (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'كل الحقول مطلوبة' });
  if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور لازم تكون 6 أحرف على الأقل' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`INSERT INTO admins (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')`)
      .run(email.trim(), hash, name.trim());
    res.json(publicAdmin(getAdminById(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'هذا الإيميل مستخدم من قبل' });
    res.status(500).json({ error: 'خطأ غير متوقع' });
  }
});
app.get('/api/admin/admins', requireAdminAuth, requireOwner, (req, res) => {
  res.json(db.prepare('SELECT id, email, name, role FROM admins ORDER BY id').all());
});
app.delete('/api/admin/admins/:id', requireAdminAuth, requireOwner, (req, res) => {
  const target = getAdminById(req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  if (target.role === 'owner') return res.status(400).json({ error: 'لا يمكن حذف المالك' });
  db.prepare('DELETE FROM admins WHERE id = ?').run(req.params.id);
  for (const [tok, id] of adminSessions) if (id === Number(req.params.id)) adminSessions.delete(tok);
  res.json({ ok: true });
});

// ---------------- ADMIN: tickets ----------------
app.get('/api/admin/tickets', requireAdminAuth, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM tickets WHERE status = ? ORDER BY id').all(status)
    : db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 300').all();
  res.json(rows.map(publicTicket));
});
app.get('/api/admin/tickets/:id', requireAdminAuth, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  res.json(publicTicket(t));
});
app.get('/api/admin/tickets/:id/messages', requireAdminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(req.params.id));
});

app.post('/api/admin/tickets/:id/accept', requireAdminAuth, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  if (t.status !== 'waiting') return res.status(409).json({ error: 'الطلب تم التعامل معه بالفعل' });
  db.prepare(
    `UPDATE tickets SET status = 'active', assigned_admin_id = ?, assigned_admin_name = ?, accepted_at = datetime('now') WHERE id = ?`
  ).run(req.admin.id, req.admin.name, t.id);
  const sysMsg = db.prepare(
    `INSERT INTO messages (ticket_id, sender_type, sender_name, content) VALUES (?, 'system', 'النظام', ?)`
  ).run(t.id, `تم الاتصال بك من قبل ${req.admin.name} — كيف نقدر نساعدك؟`);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(sysMsg.lastInsertRowid);
  io.to('ticket:' + t.id).emit('ticket:message', msg);
  broadcastQueue();
  res.json(ticketStatusPayload(t.id));
});

app.post('/api/admin/tickets/:id/close', requireAdminAuth, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  const { outcome, solution } = req.body;
  const out = ['approved', 'rejected'].includes(outcome) ? outcome : null;
  db.prepare(
    `UPDATE tickets SET status = 'closed', outcome = ?, solution = ?, closed_at = datetime('now') WHERE id = ?`
  ).run(out, (solution || '').trim(), t.id);
  io.to('ticket:' + t.id).emit('ticket:status', ticketStatusPayload(t.id));
  io.to('admins:queue').emit('queue:update');
  res.json(ticketStatusPayload(t.id));
});

app.get('/api/admin/stats', requireAdminAuth, (req, res) => {
  const todayResolved = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE status = 'closed' AND date(closed_at) = date('now')`
  ).get().c;
  const totalTickets = db.prepare('SELECT COUNT(*) c FROM tickets').get().c;
  const totalResolved = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status = 'closed'`).get().c;
  const waitingNow = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status = 'waiting'`).get().c;
  const activeNow = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status = 'active'`).get().c;
  const byAdminToday = db.prepare(
    `SELECT assigned_admin_name name, COUNT(*) c FROM tickets
     WHERE status = 'closed' AND date(closed_at) = date('now') AND assigned_admin_name IS NOT NULL
     GROUP BY assigned_admin_name ORDER BY c DESC`
  ).all();
  res.json({ todayResolved, totalTickets, totalResolved, waitingNow, activeNow, byAdminToday, avgHandlingSeconds: avgHandlingSeconds() });
});

// ---------------- SOCKET.IO ----------------
io.use((socket, next) => {
  const adminToken = socket.handshake.auth?.adminToken;
  if (adminToken) {
    const adminId = adminSessions.get(adminToken);
    if (adminId) socket.admin = getAdminById(adminId);
  }
  next();
});

io.on('connection', (socket) => {
  socket.on('admin:watch-queue', () => {
    if (socket.admin) socket.join('admins:queue');
  });

  socket.on('ticket:join', ({ ticketId, accessToken }) => {
    const t = getTicket(ticketId);
    if (!t) return;
    if (socket.admin) {
      socket.join('ticket:' + ticketId);
      socket.emit('ticket:history', db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(ticketId));
      return;
    }
    if (accessToken && accessToken === t.access_token) {
      socket.join('ticket:' + ticketId);
      socket.ticketId = String(ticketId);
      socket.emit('ticket:history', db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(ticketId));
    }
  });

  socket.on('ticket:typing', ({ ticketId, text }) => {
    if (socket.ticketId !== String(ticketId)) return;
    socket.to('ticket:' + ticketId).emit('ticket:typing', { text: (text || '').slice(0, 300) });
  });

  socket.on('ticket:message', ({ ticketId, content, attachmentUrl, attachmentType }) => {
    const t = getTicket(ticketId);
    if (!t) return;
    let senderType, senderName, finalContent = (content || '').trim();

    if (socket.admin) {
      senderType = 'admin'; senderName = socket.admin.name;
      if (/^\/?(wait|انتظار)$/i.test(finalContent)) {
        finalContent = 'الرجاء الانتظار قليلاً، سأكون معك خلال لحظات 🙏';
      }
    } else if (socket.ticketId === String(ticketId)) {
      senderType = 'customer'; senderName = t.customer_name;
    } else {
      return;
    }
    if (!finalContent && !attachmentUrl) return;

    const info = db.prepare(
      `INSERT INTO messages (ticket_id, sender_type, sender_name, content, attachment_url, attachment_type) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(ticketId, senderType, senderName, finalContent, attachmentUrl || null, attachmentType || null);
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
    io.to('ticket:' + ticketId).emit('ticket:message', msg);
  });

  // ---- WebRTC signaling relay (1:1 customer <-> admin voice call) ----
  socket.on('rtc:offer', ({ toSocketId, sdp }) => io.to(toSocketId).emit('rtc:offer', { fromSocketId: socket.id, sdp }));
  socket.on('rtc:answer', ({ toSocketId, sdp }) => io.to(toSocketId).emit('rtc:answer', { fromSocketId: socket.id, sdp }));
  socket.on('rtc:ice', ({ toSocketId, candidate }) => io.to(toSocketId).emit('rtc:ice', { fromSocketId: socket.id, candidate }));
  socket.on('rtc:call-request', ({ ticketId }) => socket.to('ticket:' + ticketId).emit('rtc:call-request', { fromSocketId: socket.id }));
  socket.on('rtc:call-accept', ({ toSocketId }) => io.to(toSocketId).emit('rtc:call-accept', { fromSocketId: socket.id }));
  socket.on('rtc:call-decline', ({ toSocketId }) => io.to(toSocketId).emit('rtc:call-decline'));
  socket.on('rtc:call-end', ({ ticketId }) => socket.to('ticket:' + ticketId).emit('rtc:call-end'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Support desk server running on port', PORT);
  console.log('Owner login: slomsalman2@gmail.com (password as set)');
});
