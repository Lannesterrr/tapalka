const express = require('express');
const db = require('./db');
const { ENV, PRODUCTS } = require('./config');
const G = require('./game');
const tg = require('./bot');
const { makeAdminToken, checkAdminToken, checkAdminPassword, rateLimit } = require('./auth');

const router = express.Router();
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const ip = req => req.ip || req.socket?.remoteAddress || 'x';

router.post('/login', rateLimit({ windowMs: 60e3, max: 5, key: ip }), (req, res) => {
  if (!ENV.ADMIN_PASSWORD) return fail(res, 'Задай ADMIN_PASSWORD в .env и перезапусти сервер', 503);
  if (!checkAdminPassword(req.body?.password)) return fail(res, 'Неверный пароль', 401);
  res.json({ token: makeAdminToken() });
});

router.use((req, res, next) => {
  const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
  if (!checkAdminToken(token)) return fail(res, 'Нужно войти заново', 401);
  next();
});

// ── Обзор ──
router.get('/stats', (req, res) => {
  const now = Date.now(), day = now - 864e5, week = now - 7 * 864e5;
  const u = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(created_at > ?),0) AS new_day,
      COALESCE(SUM(last_seen > ?),0) AS dau, COALESCE(SUM(last_seen > ?),0) AS wau,
      COALESCE(SUM(referrer_id IS NOT NULL),0) AS referred, COALESCE(SUM(stars_spent > 0),0) AS payers
    FROM users`).get(day, day, week);
  const p = db.prepare(`SELECT COALESCE(SUM(stars),0) AS total, COALESCE(SUM(CASE WHEN created_at > ? THEN stars END),0) AS day,
      COUNT(*) AS count FROM payments WHERE status = 'paid'`).get(day);

  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(now - i * 864e5).toISOString().slice(0, 10));
  const since = new Date(days[0]).getTime();
  const bucket = sql => Object.fromEntries(db.prepare(sql).all(since).map(r => [r.d, r.v]));
  const newUsers = bucket(`SELECT date(created_at/1000,'unixepoch') AS d, COUNT(*) AS v FROM users WHERE created_at >= ? GROUP BY d`);
  const stars = bucket(`SELECT date(created_at/1000,'unixepoch') AS d, SUM(stars) AS v FROM payments WHERE status='paid' AND created_at >= ? GROUP BY d`);
  const products = db.prepare(`SELECT product, COUNT(*) AS n, SUM(stars) AS stars FROM payments WHERE status='paid'
    GROUP BY product ORDER BY stars DESC`).all().map(r => ({ ...r, title: PRODUCTS[r.product]?.title || r.product }));

  res.json({
    users: u, payments: p, products,
    series: days.map(d => ({ day: d, users: newUsers[d] || 0, stars: stars[d] || 0 })),
    queue: tg.queueSize(), bot: !!tg.bot,
  });
});

// ── Игроки ──
router.get('/users', (req, res) => {
  const s = String(req.query?.q || '').trim();
  const offset = Math.max(0, Number(req.query?.offset) || 0);
  const where = s ? 'WHERE CAST(id AS TEXT) = @s OR username LIKE @like OR first_name LIKE @like' : '';
  const rows = db.prepare(`SELECT id, username, first_name, is_premium, CAST(balance AS INTEGER) AS balance,
      CAST(total_earned AS INTEGER) AS total, stars_spent, banned, last_seen, created_at,
      (SELECT COUNT(*) FROM users r WHERE r.referrer_id = users.id) AS refs
    FROM users ${where} ORDER BY total_earned DESC LIMIT 50 OFFSET @offset`)
    .all({ s, like: '%' + s.replace(/^@/, '') + '%', offset });
  res.json({ users: rows });
});

router.get('/user', (req, res) => {
  const u = G.q.get.get(Number(req.query?.id));
  if (!u) return fail(res, 'Игрок не найден', 404);
  res.json({
    user: { ...u, balance: Math.floor(u.balance), total_earned: Math.floor(u.total_earned) },
    levels: G.levelsOf(u.id),
    refs: G.q.refCount.get(u.id).n,
    payments: db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id),
  });
});

router.post('/user', (req, res) => {
  const u = G.q.get.get(Number(req.body?.id));
  if (!u) return fail(res, 'Игрок не найден', 404);
  G.refresh(u);
  const delta = Number(req.body?.balance_delta) || 0;
  if (delta) u.balance = Math.max(0, u.balance + delta);
  G.save(u);
  if (typeof req.body?.banned === 'boolean') db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(req.body.banned ? 1 : 0, u.id);
  res.json({ ok: true });
});

// ── Задания ──
router.get('/tasks', (req, res) => {
  res.json({ tasks: db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM task_progress p WHERE p.task_id = t.id AND p.done_at IS NOT NULL) AS completed
    FROM tasks t ORDER BY sort, id`).all() });
});

router.post('/tasks/save', async (req, res) => {
  const b = req.body || {};
  const t = {
    title: String(b.title || '').trim(), icon: String(b.icon || '⭐').trim() || '⭐',
    reward: Math.max(0, Math.floor(Number(b.reward) || 0)), type: String(b.type),
    url: b.url ? String(b.url).trim() : null, chat_id: b.chat_id ? String(b.chat_id).trim() : null,
    need: b.need ? Math.max(1, Math.floor(Number(b.need))) : null,
    active: b.active === false ? 0 : 1, sort: Math.floor(Number(b.sort) || 0),
  };
  if (!t.title || !t.reward) return fail(res, 'Укажи название и награду');
  if (!['channel', 'link', 'refs'].includes(t.type)) return fail(res, 'Неизвестный тип задания');
  if (t.type === 'channel' && (!t.chat_id || !t.url)) return fail(res, 'Для канала нужны @username канала и ссылка');
  if (t.type === 'link' && !t.url) return fail(res, 'Укажи ссылку');
  if (t.type === 'refs' && !t.need) return fail(res, 'Укажи, сколько друзей пригласить');
  if (t.type === 'channel' && tg.bot) {
    try {
      const me = await tg.bot.api.getChatMember(t.chat_id, tg.bot.botInfo.id);
      if (!['administrator', 'creator'].includes(me.status)) return fail(res, 'Сделай бота админом канала — иначе он не увидит подписки');
    } catch { return fail(res, 'Бот не нашёл канал. Проверь @username и добавь бота в админы'); }
  }
  if (b.id) {
    db.prepare(`UPDATE tasks SET title=@title, icon=@icon, reward=@reward, type=@type, url=@url, chat_id=@chat_id,
      need=@need, active=@active, sort=@sort WHERE id=@id`).run({ ...t, id: Number(b.id) });
  } else {
    db.prepare(`INSERT INTO tasks(title, icon, reward, type, url, chat_id, need, active, sort, created_at)
      VALUES(@title, @icon, @reward, @type, @url, @chat_id, @need, @active, @sort, @now)`).run({ ...t, now: Date.now() });
  }
  res.json({ ok: true });
});

router.post('/tasks/delete', (req, res) => {
  const id = Number(req.body?.id);
  db.transaction(() => {
    db.prepare('DELETE FROM task_progress WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

// ── Платежи ──
router.get('/payments', (req, res) => {
  const offset = Math.max(0, Number(req.query?.offset) || 0);
  const rows = db.prepare(`SELECT p.*, u.first_name, u.username FROM payments p LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.id DESC LIMIT 50 OFFSET ?`).all(offset)
    .map(r => ({ ...r, title: PRODUCTS[r.product]?.title || r.product }));
  res.json({ payments: rows });
});

router.post('/refund', async (req, res) => {
  try { await tg.refund(Number(req.body?.id)); res.json({ ok: true }); }
  catch (e) { fail(res, e.description || e.message); }
});

// ── Рассылки ──
const cleanBroadcast = b => ({
  text: String(b?.text || '').trim(),
  button_text: b?.button_text ? String(b.button_text).trim() : null,
  button_url: b?.button_url ? String(b.button_url).trim() : null,
});

router.get('/broadcasts', (req, res) => {
  res.json({ broadcasts: db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 30').all() });
});

router.post('/broadcast', (req, res) => {
  const b = cleanBroadcast(req.body);
  if (!b.text) return fail(res, 'Напиши текст рассылки');
  if (!tg.bot) return fail(res, 'Бот не запущен');
  db.prepare('INSERT INTO broadcasts(text, button_text, button_url, created_at) VALUES(?, ?, ?, ?)')
    .run(b.text, b.button_text, b.button_url, Date.now());
  res.json({ ok: true });
});

router.post('/broadcast/test', async (req, res) => {
  const b = cleanBroadcast(req.body);
  if (!b.text) return fail(res, 'Напиши текст рассылки');
  if (!ENV.ADMIN_IDS.length) return fail(res, 'Добавь свой Telegram ID в ADMIN_IDS, чтобы получать тест');
  const kb = b.button_text && b.button_url
    ? { reply_markup: { inline_keyboard: [[b.button_url === 'game'
        ? { text: b.button_text, web_app: { url: ENV.WEBAPP_URL } } : { text: b.button_text, url: b.button_url }]] } } : {};
  try {
    await Promise.all(ENV.ADMIN_IDS.map(id => tg.send(id, b.text, kb)));
    res.json({ ok: true });
  } catch (e) { fail(res, 'Telegram не принял сообщение: ' + (e.description || e.message)); }
});

router.post('/broadcast/cancel', (req, res) => {
  db.prepare("UPDATE broadcasts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running')")
    .run(Date.now(), Number(req.body?.id));
  res.json({ ok: true });
});

router.get('/products', (req, res) => res.json({ products: PRODUCTS }));

module.exports = router;
