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

const adminSessions = new Map();
const autoModeTickets = new Set();

// ---------- Whiteboard + voice room state ----------
const boardStrokes = [];
const boardPeers = new Set();
const voicePeers = new Set();



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

function getTicket(id) { return stmts.getTicket.get(id); }
function publicTicket(t) {
  if (!t) return null;
  const { access_token, ...rest } = t;
  return rest;
}
function queuePosition(ticketId) {
  const t = getTicket(ticketId);
  if (!t || t.status !== 'waiting') return 0;
  return stmts.queueCount.get(ticketId).c;
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
    problemLocation: t.problem_location, problemDetails: t.problem_details,
    rating: t.rating, autoMode: autoModeTickets.has(Number(ticketId)),
  };
}
function broadcastQueue() {
  const waiting = stmts.waitingIds.all();
  waiting.forEach(w => io.to('ticket:' + w.id).emit('ticket:status', ticketStatusPayload(w.id)));
  io.to('admins:queue').emit('queue:update');
}

function generateAutoReply(customerMessage, ticket) {
  const msg = (customerMessage || '').toLowerCase().trim();
  const name = ticket.customer_name || 'عميلنا';
  if (/^(السلام|مرحبا|هلا|اهلا|أهلا|سلام|hi|hello)/.test(msg))
    return `وعليكم السلام ورحمة الله ${name} 🌟\nكيف أقدر أخدمك اليوم؟`;
  if (/شكر|مشكور|تسلم|يعطيك|thanks|thank you/.test(msg))
    return `العفو يا ${name}، هذا واجبي 😊\nهل في أي شيء ثاني أقدر أساعدك فيه؟`;
  if (/طويل|انتظر|متى|متى يجي|متى ترد|بطيء|بطيئ/.test(msg))
    return `أعتذر على الانتظار ${name} 🙏\nأنا معك الآن، تفضل اشرح لي المشكلة بالتفصيل.`;
  if (/مشكلة|خطأ|ما يشتغل|مايفتح|ما يفتح|عطل|خربان|مساعدة|ساعدني/.test(msg))
    return `تمام، خليني أساعدك.\nممكن تشرح لي المشكلة بالتفصيل؟ وإذا في صورة أو رسالة خطأ ارسلها لي.`;
  if (/حساب|دخول|تسجيل|باسوورد|كلمة مرور|ايميل|إيميل|login|password/.test(msg))
    return `بخصوص الحساب، ممكن تعطيني الإيميل المسجل فيه أو رقم الجوال المرتبط عشان أقدر أساعدك بشكل أدق؟`;
  if (/فلوس|دفع|مبلغ|فاتورة|استرداد|ارجاع|refund|payment/.test(msg))
    return `بخصوص المبالغ، راح أراجع الطلب.\nممكن ترسل لي رقم العملية أو تفاصيل أكثر؟`;
  if (/خلاص|تم|انتهى|شكرا انتهى|ما فيه شيء|لا شيء/.test(msg))
    return `تمام، يسعدني أني قدرت أساعدك ${name} 🌟\nإذا احتجت أي شيء ثاني لا تتردد ترجع لنا. يومك سعيد!`;
  const defaults = [
    `تمام ${name}، فهمت عليك.\nخليني أشيك وأرد عليك خلال لحظات.`,
    `شكراً لتواصلك ${name}.\nممكن تعطيني تفاصيل أكثر عشان أقدر أساعدك بشكل أفضل؟`,
    `حاضر، أنا معك.\nاشرح لي أكثر لو سمحت.`,
  ];
  return defaults[Math.floor(Math.random() * defaults.length)];
}

// ---------- PUBLIC ----------
app.post('/api/tickets', (req, res) => {
  try {
    const { customerName, customerContact, subject, problemLocation, problemDetails } = req.body;
    if (!customerName || !customerName.trim()) return res.status(400).json({ error: 'الاسم مطلوب' });
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'اكتب ملخص المشكلة' });
    const accessToken = nanoid(24);
    const info = stmts.insertTicket.run(
      accessToken,
      customerName.trim(),
      (customerContact || '').trim(),
      subject.trim(),
      (problemLocation || '').trim() || null,
      (problemDetails || '').trim() || null
    );
    const id = info.lastInsertRowid;
    broadcastQueue();
    res.json({ ...ticketStatusPayload(id), accessToken });
  } catch (e) {
    console.error(e);
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

// Rating from customer
app.post('/api/tickets/:id/rate', verifyTicketToken, (req, res) => {
  const { rating, reason } = req.body;
  const r = Number(rating);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'التقييم يجب أن يكون من 1 إلى 5' });
  if (req.ticket.status !== 'closed') return res.status(400).json({ error: 'يمكن التقييم بعد إغلاق الطلب فقط' });
  if (req.ticket.rating) return res.status(400).json({ error: 'تم التقييم مسبقاً' });
  const reasonText = r < 4 ? (reason || '').trim() : null;
  if (r < 4 && !reasonText) return res.status(400).json({ error: 'يرجى كتابة سبب التقييم المنخفض' });
  stmts.rateTicket.run(r, reasonText, req.ticket.id, req.ticket.access_token);
  res.json({ ok: true, rating: r });
});

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

// ---------- ADMIN AUTH ----------
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
    console.error(e);
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
    res.status(500).json({ error: 'خطأ غير متوقع' });
  }
});
app.get('/api/admin/admins', requireAdminAuth, requireOwner, (req, res) => {
  res.json(stmts.listAdmins.all());
});
app.put('/api/admin/admins/:id', requireAdminAuth, requireOwner, (req, res) => {
  const target = getAdminById(req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'الاسم والإيميل مطلوبان' });
  try {
    stmts.updateAdmin.run(name.trim(), email.trim(), req.params.id);
    res.json(publicAdmin(getAdminById(req.params.id)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'الإيميل مستخدم' });
    res.status(500).json({ error: 'خطأ' });
  }
});
app.delete('/api/admin/admins/:id', requireAdminAuth, requireOwner, (req, res) => {
  const target = getAdminById(req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  if (target.role === 'owner') return res.status(400).json({ error: 'لا يمكن حذف المالك' });
  stmts.deleteAdmin.run(req.params.id);
  for (const [tok, id] of adminSessions) if (id === Number(req.params.id)) adminSessions.delete(tok);
  res.json({ ok: true });
});

// ---------- TICKETS ----------
app.get('/api/admin/tickets', requireAdminAuth, (req, res) => {
  const status = req.query.status;
  const rows = status ? stmts.listTicketsByStatus.all(status) : stmts.listTicketsRecent.all();
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
  io.to('ticket:' + t.id).emit('ticket:status', status);
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
  const status = ticketStatusPayload(t.id);
  // Ask for rating
  const rateMsg = stmts.insertSystemMessage.run(t.id, '⭐ تم إغلاق طلبك. الرجاء تقييم الخدمة من 1 إلى 5 نجوم.');
  const rm = stmts.getMessageById.get(rateMsg.lastInsertRowid);
  io.to('ticket:' + t.id).emit('ticket:message', rm);
  io.to('ticket:' + t.id).emit('ticket:status', status);
  io.to('admins:queue').emit('queue:update');
  res.json(status);
});

app.get('/api/admin/stats', requireAdminAuth, (req, res) => {
  res.json({
    todayResolved: stmts.todayResolved.get().c,
    totalTickets: stmts.totalTickets.get().c,
    totalResolved: stmts.totalResolved.get().c,
    waitingNow: stmts.waitingNow.get().c,
    activeNow: stmts.activeNow.get().c,
    byAdminToday: stmts.byAdminToday.all(),
    avgHandlingSeconds: avgHandlingSeconds(),
  });
});

// Owner: ratings & reviews
app.get('/api/admin/reviews', requireAdminAuth, requireOwner, (req, res) => {
  const list = stmts.adminRatings.all();
  const summary = stmts.ratingsByAdmin.all();
  res.json({ list, summary });
});
app.delete('/api/admin/tickets/:id', requireAdminAuth, requireOwner, (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'غير موجود' });
  stmts.deleteMessages.run(req.params.id);
  stmts.deleteTicket.run(req.params.id);
  res.json({ ok: true });
});


// ---------- CANNED REPLIES ----------
app.get('/api/admin/canned', requireAdminAuth, (req, res) => {
  res.json(stmts.listCanned.all());
});
app.post('/api/admin/canned', requireAdminAuth, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'العنوان والنص مطلوبان' });
  const info = stmts.insertCanned.run(title.trim(), content.trim(), req.admin.id);
  res.json(stmts.listCanned.all().find(r => r.id === Number(info.lastInsertRowid)) || { id: info.lastInsertRowid, title, content });
});
app.put('/api/admin/canned/:id', requireAdminAuth, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'العنوان والنص مطلوبان' });
  stmts.updateCanned.run(title.trim(), content.trim(), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/canned/:id', requireAdminAuth, (req, res) => {
  stmts.deleteCanned.run(req.params.id);
  res.json({ ok: true });
});

// ---------- SOCKET ----------
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
      const cmd = finalContent.toLowerCase().trim();

      if (cmd === '/auto' || cmd === '/ai') {
        autoModeTickets.add(Number(ticketId));
        const sys = stmts.insertSystemMessage.run(ticketId, '🤖 تم تفعيل المساعد الذكي');
        io.to('ticket:' + ticketId).emit('ticket:message', stmts.getMessageById.get(sys.lastInsertRowid));
        io.to('ticket:' + ticketId).emit('ticket:status', ticketStatusPayload(ticketId));
        return;
      }
      if (cmd === '/auto off' || cmd === '/ai off' || cmd === '/stop') {
        autoModeTickets.delete(Number(ticketId));
        const sys = stmts.insertSystemMessage.run(ticketId, 'تم إيقاف المساعد الذكي');
        io.to('ticket:' + ticketId).emit('ticket:message', stmts.getMessageById.get(sys.lastInsertRowid));
        return;
      }
      if (cmd === '/wait' || cmd === '/انتظار') {
        finalContent = 'الرجاء الانتظار قليلاً، سأكون معك خلال لحظات 🙏';
      }
      if (cmd === '/thanks' || cmd === '/شكر') {
        finalContent = 'شكراً لتواصلك معنا، سعداء بخدمتك 🌟';
      }
      if (cmd === '/busy') {
        finalContent = 'أعتذر، لدي ضغط حالياً. سأعود لك في أقرب وقت ممكن.';
      }
      if (cmd === '/help' || cmd === '/أوامر') {
        const help = `الأوامر المتاحة:
/auto — تفعيل المساعد الذكي
/auto off — إيقاف المساعد
/wait — رسالة انتظار
/thanks — رسالة شكر
/busy — مشغول حالياً
/hello — ترحيب
/ask — اطلب تفاصيل أكثر
/files — اطلب مرفقات
/escalate — تصعيد للمالك
/close approved — إغلاق موافقة
/close rejected — إغلاق رفض
/help — هذه القائمة`;
        const sys = stmts.insertSystemMessage.run(ticketId, help);
        io.to('ticket:' + ticketId).emit('ticket:message', stmts.getMessageById.get(sys.lastInsertRowid));
        return;
      }
      if (cmd === '/hello' || cmd === '/مرحبا') {
        finalContent = `مرحباً بك 🌟 أنا ${socket.admin.name} من فريق الدعم، كيف أقدر أخدمك؟`;
      }
      if (cmd === '/ask' || cmd === '/تفاصيل') {
        finalContent = 'ممكن تعطيني تفاصيل أكثر عن المشكلة؟ ومتى بدأت بالضبط؟';
      }
      if (cmd === '/files' || cmd === '/مرفقات') {
        finalContent = 'لو تقدر ترسل صورة أو لقطة شاشة للمشكلة يساعدني كثير 📎';
      }
      if (cmd === '/escalate' || cmd === '/تصعيد') {
        finalContent = 'تم تصعيد طلبك للمالك، سيتم متابعته في أقرب وقت.';
        const sys = stmts.insertSystemMessage.run(ticketId, '⬆️ تم تصعيد الطلب للمالك من قبل ' + socket.admin.name);
        io.to('ticket:' + ticketId).emit('ticket:message', stmts.getMessageById.get(sys.lastInsertRowid));
      }
      if (cmd.startsWith('/close approved') || cmd === '/close ok') {
        const solution = finalContent.replace(/^\/close\s+(approved|ok)\s*/i, '').trim() || 'تم حل المشكلة';
        stmts.closeTicket.run('approved', solution, ticketId);
        autoModeTickets.delete(Number(ticketId));
        const status = ticketStatusPayload(ticketId);
        const sys = stmts.insertSystemMessage.run(ticketId, '✅ تم إغلاق الطلب (موافقة)\n⭐ الرجاء تقييم الخدمة');
        io.to('ticket:' + ticketId).emit('ticket:message', stmts.getMessageById.get(sys.lastInsertRowid));
        io.to('ticket:' + ticketId).emit('ticket:status', status);
        io.to('admins:queue').emit('queue:update');
        return;
      }
      if (cmd.startsWith('/close rejected') || cmd === '/close no') {
        const solution = finalContent.replace(/^\/close\s+(rejected|no)\s*/i, '').trim() || '';
        stmts.closeTicket.run('rejected', solution, ticketId);
        autoModeTickets.delete(Number(ticketId));
        const status = ticketStatusPayload(ticketId);
        const sys = stmts.insertSystemMessage.run(ticketId, '❌ تم إغلاق الطلب\n⭐ الرجاء تقييم الخدمة');
        io.to('ticket:' + ticketId).emit('ticket:message', stmts.getMessageById.get(sys.lastInsertRowid));
        io.to('ticket:' + ticketId).emit('ticket:status', status);
        io.to('admins:queue').emit('queue:update');
        return;
      }
    } else if (socket.ticketId === String(ticketId)) {
      senderType = 'customer';
      senderName = t.customer_name;
    } else return;

    if (!finalContent && !attachmentUrl) return;

    const info = stmts.insertMessage.run(ticketId, senderType, senderName, finalContent, attachmentUrl || null, attachmentType || null);
    const msg = stmts.getMessageById.get(info.lastInsertRowid);
    io.to('ticket:' + ticketId).emit('ticket:message', msg);

    if (senderType === 'admin') {
      const t2 = getTicket(ticketId);
      if (t2 && t2.status === 'waiting') {
        stmts.acceptTicket.run(socket.admin.id, socket.admin.name, ticketId);
      }
      io.to('ticket:' + ticketId).emit('ticket:status', ticketStatusPayload(ticketId));
    }

    if (senderType === 'customer' && autoModeTickets.has(Number(ticketId)) && finalContent) {
      setTimeout(() => {
        const reply = generateAutoReply(finalContent, t);
        const autoInfo = stmts.insertMessage.run(ticketId, 'admin', 'المساعد الذكي 🤖', reply, null, null);
        io.to('ticket:' + ticketId).emit('ticket:message', stmts.getMessageById.get(autoInfo.lastInsertRowid));
      }, 700 + Math.random() * 600);
    }
  });


  // Whiteboard
  socket.on('board:join', () => {
    if (!socket.admin) return;
    boardPeers.add(socket.id);
    socket.join('board');
    socket.emit('board:state', boardStrokes);
    io.to('board').emit('board:peers', [...boardPeers]);
  });
  socket.on('board:stroke', (stroke) => {
    if (!socket.admin) return;
    boardStrokes.push(stroke);
    if (boardStrokes.length > 5000) boardStrokes.splice(0, boardStrokes.length - 4000);
    socket.to('board').emit('board:stroke', stroke);
  });
  socket.on('board:clear', () => {
    if (!socket.admin) return;
    boardStrokes.length = 0;
    io.to('board').emit('board:clear');
  });
  // Voice room
  socket.on('voice:join', () => {
    if (!socket.admin) return;
    voicePeers.add(socket.id);
    socket.join('voice');
    const others = [...voicePeers].filter(id => id !== socket.id);
    socket.emit('voice:peers', others);
    socket.to('voice').emit('voice:peers', [socket.id]);
  });
  socket.on('voice:leave', () => {
    voicePeers.delete(socket.id);
    socket.to('voice').emit('voice:left', socket.id);
  });
  socket.on('voice:offer', ({ to, sdp }) => io.to(to).emit('voice:offer', { from: socket.id, sdp }));
  socket.on('voice:answer', ({ to, sdp }) => io.to(to).emit('voice:answer', { from: socket.id, sdp }));
  socket.on('voice:ice', ({ to, candidate }) => io.to(to).emit('voice:ice', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    if (boardPeers.has(socket.id)) {
      boardPeers.delete(socket.id);
      io.to('board').emit('board:peers', [...boardPeers]);
    }
    if (voicePeers.has(socket.id)) {
      voicePeers.delete(socket.id);
      socket.to('voice').emit('voice:left', socket.id);
    }
  });

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
  console.log('ناقه — Support desk running on', PORT);
});

function shutdown() {
  server.close(() => { closeDb(); process.exit(0); });
  setTimeout(() => process.exit(1), 4000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
