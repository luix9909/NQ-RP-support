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

// ---------------- in-memory sessions & auto mode ----------------
const adminSessions = new Map(); // token -> adminId
const autoModeTickets = new Set(); // ticketIds that have AI auto-reply enabled

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
  if (!rows.length) return 300;
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
    autoMode: autoModeTickets.has(Number(ticketId)),
  };
}
function broadcastQueue() {
  const waiting = stmts.waitingIds.all();
  waiting.forEach(w => io.to('ticket:' + w.id).emit('ticket:status', ticketStatusPayload(w.id)));
  // أرسل التحديث فوراً لكل الأدمن المتصلين
  io.to('admins:queue').emit('queue:update');
}

// ---------------- Simple local AI for /auto ----------------
function generateAutoReply(customerMessage, ticket) {
  const msg = (customerMessage || '').toLowerCase().trim();
  const name = ticket.customer_name || 'عميلنا';

  // Greetings
  if (/^(السلام|مرحبا|هلا|اهلا|أهلا|سلام|hi|hello)/.test(msg)) {
    return `وعليكم السلام ورحمة الله ${name} 🌟\nكيف أقدر أخدمك اليوم؟`;
  }
  // Thanks
  if (/شكر|مشكور|تسلم|يعطيك|thanks|thank you/.test(msg)) {
    return `العفو يا ${name}، هذا واجبي 😊\nهل في أي شيء ثاني أقدر أساعدك فيه؟`;
  }
  // Waiting / slow
  if (/طويل|انتظر|متى|متى يجي|متى ترد|بطيء|بطيئ/.test(msg)) {
    return `أعتذر على الانتظار ${name} 🙏\nأنا معك الآن، تفضل اشرح لي المشكلة بالتفصيل.`;
  }
  // Problem / help
  if (/مشكلة|خطأ|ما يشتغل|مايفتح|ما يفتح|عطل|خربان|مساعدة|ساعدني/.test(msg)) {
    return `تمام، خليني أساعدك.\nممكن تشرح لي المشكلة بالتفصيل؟ وإذا في صورة أو رسالة خطأ ارسلها لي.`;
  }
  // Account / login
  if (/حساب|دخول|تسجيل|باسوورد|كلمة مرور|ايميل|إيميل|login|password/.test(msg)) {
    return `بخصوص الحساب، ممكن تعطيني الإيميل المسجل فيه أو رقم الجوال المرتبط عشان أقدر أساعدك بشكل أدق؟`;
  }
  // Payment / money
  if (/فلوس|دفع|مبلغ|فاتورة|استرداد|ارجاع|refund|payment/.test(msg)) {
    return `بخصوص المبالغ، راح أراجع الطلب.\nممكن ترسل لي رقم العملية أو تفاصيل أكثر؟`;
  }
  // Closing
  if (/خلاص|تم|انتهى|شكرا انتهى|ما فيه شيء|لا شيء/.test(msg)) {
    return `تمام، يسعدني أني قدرت أساعدك ${name} 🌟\nإذا احتجت أي شيء ثاني لا تتردد ترجع لنا. يومك سعيد!`;
  }
  // Default smart reply
  const defaults = [
    `تمام ${name}، فهمت عليك.\nخليني أشيك وأرد عليك خلال لحظات.`,
    `شكراً لتواصلك ${name}.\nممكن تعطيني تفاصيل أكثر عشان أقدر أساعدك بشكل أفضل؟`,
    `حاضر، أنا معك.\nاشرح لي أكثر لو سمحت.`,
  ];
  return defaults[Math.floor(Math.random() * defaults.length)];
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

// ---------------- uploads ----------------
app.post('/api/upload', (req, res, next) => {
  const adminToken = (req.headers.authorization || '').replace('Bearer ', '');
  if (adminSessions.has(adminToken)) return next();
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
  res.json({ ...publicTicket(t), autoMode: autoModeTickets.has(Number(t.id)) });
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
  const status = ticketStatusPayload(t.id);
  io.to('ticket:' + t.id).emit('ticket:message', msg);
  io.to('ticket:' + t.id).emit('ticket:status', status);  // مهم: يفتح الشات عند الزبون
  broadcastQueue();
  res.json(status);
});

app.post('/api/admin/tickets/:id/close', requireAdminAuth, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  const { outcome, solution } = req.body;
  const out = ['approved', 'rejected'].includes(outcome) ? outcome : null;
  stmts.closeTicket.run(out, (solution || '').trim(), t.id);
  autoModeTickets.delete(Number(t.id));
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
      senderType = 'admin';
      senderName = socket.admin.name;

      // ===== Slash commands =====
      const cmd = finalContent.toLowerCase().trim();

      if (cmd === '/auto' || cmd === '/ai') {
        autoModeTickets.add(Number(ticketId));
        const sys = stmts.insertSystemMessage.run(ticketId, '🤖 تم تفعيل المساعد الذكي — سيرد تلقائياً على رسائل الزبون');
        const msg = stmts.getMessageById.get(sys.lastInsertRowid);
        io.to('ticket:' + ticketId).emit('ticket:message', msg);
        io.to('ticket:' + ticketId).emit('ticket:status', ticketStatusPayload(ticketId));
        return;
      }
      if (cmd === '/auto off' || cmd === '/ai off' || cmd === '/stop') {
        autoModeTickets.delete(Number(ticketId));
        const sys = stmts.insertSystemMessage.run(ticketId, 'تم إيقاف المساعد الذكي');
        const msg = stmts.getMessageById.get(sys.lastInsertRowid);
        io.to('ticket:' + ticketId).emit('ticket:message', msg);
        io.to('ticket:' + ticketId).emit('ticket:status', ticketStatusPayload(ticketId));
        return;
      }
      if (cmd === '/wait' || cmd === '/انتظار') {
        finalContent = 'الرجاء الانتظار قليلاً، سأكون معك خلال لحظات 🙏';
      }
      if (cmd === '/help' || cmd === '/أوامر') {
        const helpText = `الأوامر المتاحة:
/auto — تفعيل المساعد الذكي
/auto off — إيقاف المساعد الذكي
/wait — رسالة انتظار جاهزة
/close approved — إغلاق الطلب بالموافقة
/close rejected — إغلاق الطلب بالرفض
/help — عرض هذه القائمة`;
        const sys = stmts.insertSystemMessage.run(ticketId, helpText);
        const msg = stmts.getMessageById.get(sys.lastInsertRowid);
        io.to('ticket:' + ticketId).emit('ticket:message', msg);
        return;
      }
      if (cmd.startsWith('/close approved') || cmd === '/close ok') {
        const solution = finalContent.replace(/^\/close\s+(approved|ok)\s*/i, '').trim() || 'تم حل المشكلة';
        stmts.closeTicket.run('approved', solution, ticketId);
        autoModeTickets.delete(Number(ticketId));
        const sys = stmts.insertSystemMessage.run(ticketId, '✅ تم إغلاق الطلب (موافقة)');
        const msg = stmts.getMessageById.get(sys.lastInsertRowid);
        io.to('ticket:' + ticketId).emit('ticket:message', msg);
        io.to('ticket:' + ticketId).emit('ticket:status', ticketStatusPayload(ticketId));
        io.to('admins:queue').emit('queue:update');
        return;
      }
      if (cmd.startsWith('/close rejected') || cmd === '/close no') {
        const solution = finalContent.replace(/^\/close\s+(rejected|no)\s*/i, '').trim() || 'لم يتم حل المشكلة';
        stmts.closeTicket.run('rejected', solution, ticketId);
        autoModeTickets.delete(Number(ticketId));
        const sys = stmts.insertSystemMessage.run(ticketId, '❌ تم إغلاق الطلب (رفض)');
        const msg = stmts.getMessageById.get(sys.lastInsertRowid);
        io.to('ticket:' + ticketId).emit('ticket:message', msg);
        io.to('ticket:' + ticketId).emit('ticket:status', ticketStatusPayload(ticketId));
        io.to('admins:queue').emit('queue:update');
        return;
      }
    } else if (socket.ticketId === String(ticketId)) {
      senderType = 'customer';
      senderName = t.customer_name;
    } else {
      return;
    }

    if (!finalContent && !attachmentUrl) return;

    const info = stmts.insertMessage.run(ticketId, senderType, senderName, finalContent, attachmentUrl || null, attachmentType || null);
    const msg = stmts.getMessageById.get(info.lastInsertRowid);
    io.to('ticket:' + ticketId).emit('ticket:message', msg);

    // إذا الأدمن أرسل رسالة، تأكد أن الزبون ينتقل للشات (حتى لو ما تم accept رسمياً)
    if (senderType === 'admin') {
      const t2 = getTicket(ticketId);
      if (t2 && t2.status === 'waiting') {
        // نحولها إلى active تلقائياً لو الأدمن بدأ يتكلم
        stmts.acceptTicket.run(socket.admin.id, socket.admin.name, ticketId);
      }
      io.to('ticket:' + ticketId).emit('ticket:status', ticketStatusPayload(ticketId));
    }

    // Auto-reply if enabled and message is from customer
    if (senderType === 'customer' && autoModeTickets.has(Number(ticketId)) && finalContent) {
      setTimeout(() => {
        const reply = generateAutoReply(finalContent, t);
        const autoInfo = stmts.insertMessage.run(ticketId, 'admin', 'المساعد الذكي 🤖', reply, null, null);
        const autoMsg = stmts.getMessageById.get(autoInfo.lastInsertRowid);
        io.to('ticket:' + ticketId).emit('ticket:message', autoMsg);
      }, 800 + Math.random() * 700);
    }
  });

  // ---- WebRTC signaling ----
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
  console.log('Owner login: slomsalman2@gmail.com');
});

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
