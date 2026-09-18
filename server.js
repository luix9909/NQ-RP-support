const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, stmts, closeDb } = require('./db');

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

function getAdminById(id) { return stmts.getAdminById.get(id); }
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
function getTicket(id) { return stmts.getTicket.get(id); }
function publicTicket(t) {
  if (!t) return null;
  const { access_token, ...rest } = t;
  return rest;
}
function queuePosition(ticketId) {
  const t = getTicket(ticketId);
  if (!t || t.status !== 'waiting') return 0;
  const row = stmts.queueCount.get(ticketId);
  return row.c;
}
function avgHandlingSeconds() {
  const rows = stmts.avgHandling.all();
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
  const waiting = stmts.waitingIds.all();
  waiting.forEach(w => io.to('ticket:' + w.id).emit('ticket:status', ticketStatusPayload(w.id)));
  io.to('admins:queue').emit('queue:update');
}

// ---------------- PUBLIC: ticket creation & status ----------------
app.post('/api/tickets', (req, res) => {
  try {
    const { customerName, customerContact, subject } = req.body;
    if (!customerName || !customerName.trim()) return res.status(400).json({ error: 'الاسم مطلوب' });
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'اكتب تفاصيل طلبك' });
    const accessToken = nanoid(24);
    const info = stmts.insertTicket.run(accessToken, customerName.trim(), (customerContact || '').trim(), subject.trim());
    const id = info.lastInsertRowid;
    broadcastQueue();
    const status = ticketStatusPayload(id);
    res.json({ ...status, accessToken });
  } catch (e) {
    console.error('create ticket error', e);
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
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
  res.json(stmts.listMessages.all(req.ticket.id));
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
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'أدخل الإيميل وكلمة المرور' });
    const admin = stmts.getAdminByEmail.get(email.trim());
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    const token = nanoid(32);
    adminSessions.set(token, admin.id);
    res.json({ token, admin: publicAdmin(admin) });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});
app.get('/api/admin/me', requireAdminAuth, (req, res) => res.json({ admin: publicAdmin(req.admin) }));

app.post('/api/admin/admins', requireAdminAuth, requireOwner, (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'كل الحقول مطلوبة' });
  if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور لازم تكون 6 أحرف على الأقل' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = stmts.insertAdmin.run(email.trim(), hash, name.trim());
    res.json(publicAdmin(getAdminById(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'هذا الإيميل مستخدم من قبل' });
    console.error(e);
    res.status(500).json({ error: 'خطأ غير متوقع' });
  }
});
app.get('/api/admin/admins', requireAdminAuth, requireOwner, (req, res) => {
  res.json(stmts.listAdmins.all());
});
app.delete('/api/admin/admins/:id', requireAdminAuth, requireOwner, (req, res) => {
  const target = getAdminById(req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  if (target.role === 'owner') return res.status(400).json({ error: 'لا يمكن حذف المالك' });
  stmts.deleteAdmin.run(req.params.id);
  for (const [tok, id] of adminSessions) if (id === Number(req.params.id)) adminSessions.delete(tok);
  res.json({ ok: true });
});

// ---------------- ADMIN: tickets ----------------
app.get('/api/admin/tickets', requireAdminAuth, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? stmts.listTicketsByStatus.all(status)
    : stmts.listTicketsRecent.all();
  res.json(rows.map(publicTicket));
});
app.get('/api/admin/tickets/:id', requireAdminAuth, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  res.json(publicTicket(t));
});
app.get('/api/admin/tickets/:id/messages', requireAdminAuth, (req, res) => {
  res.json(stmts.listMessages.all(req.params.id));
});

app.post('/api/admin/tickets/:id/accept', requireAdminAuth, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  if (t.status !== 'waiting') return res.status(409).json({ error: 'الطلب تم التعامل معه بالفعل' });
  stmts.acceptTicket.run(req.admin.id, req.admin.name, t.id);
  const sysMsg = stmts.insertSystemMessage.run(t.id, `تم الاتصال بك من قبل ${req.admin.name} — كيف نقدر نساعدك؟`);
  const msg = stmts.getMessageById.get(sysMsg.lastInsertRowid);
  io.to('ticket:' + t.id).emit('ticket:message', msg);
  broadcastQueue();
  res.json(ticketStatusPayload(t.id));
});

app.post('/api/admin/tickets/:id/close', requireAdminAuth, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  const { outcome, solution } = req.body;
  const out = ['approved', 'rejected'].includes(outcome) ? outcome : null;
  stmts.closeTicket.run(out, (solution || '').trim(), t.id);
  io.to('ticket:' + t.id).emit('ticket:status', ticketStatusPayload(t.id));
  io.to('admins:queue').emit('queue:update');
  res.json(ticketStatusPayload(t.id));
});

app.get('/api/admin/stats', requireAdminAuth, (req, res) => {
  const todayResolved = stmts.todayResolved.get().c;
  const totalTickets = stmts.totalTickets.get().c;
  const totalResolved = stmts.totalResolved.get().c;
  const waitingNow = stmts.waitingNow.get().c;
  const activeNow = stmts.activeNow.get().c;
  const byAdminToday = stmts.byAdminToday.all();
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
      socket.emit('ticket:history', stmts.listMessages.all(ticketId));
      return;
    }
    if (accessToken && accessToken === t.access_token) {
      socket.join('ticket:' + ticketId);
      socket.ticketId = String(ticketId);
      socket.emit('ticket:history', stmts.listMessages.all(ticketId));
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

    const info = stmts.insertMessage.run(ticketId, senderType, senderName, finalContent, attachmentUrl || null, attachmentType || null);
    const msg = stmts.getMessageById.get(info.lastInsertRowid);
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

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
