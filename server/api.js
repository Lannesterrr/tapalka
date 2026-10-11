const express = require('express');
const db = require('./db');
const { ENV, GAME, UPGRADES, CARDS, SKINS, PRODUCTS, cost } = require('./config');
const G = require('./game');
const { checkInitData, rateLimit } = require('./auth');
const tg = require('./bot');

const router = express.Router();

router.use((req, res, next) => {
  let auth = checkInitData(req.get('X-Init-Data'));
  if (!auth && ENV.DEV_MODE && req.get('X-Dev-User')) {
    auth = { user: { id: Number(req.get('X-Dev-User')), first_name: 'Dev ' + req.get('X-Dev-User') }, startParam: req.get('X-Dev-Ref') || null };
  }
  if (!auth?.user?.id) return res.status(401).json({ error: 'Открой игру через Telegram' });
  req.tgUser = auth.user;
  req.startParam = auth.startParam;
  next();
});

router.use(rateLimit({ windowMs: 10e3, max: 60, key: req => req.tgUser.id }));

router.use((req, res, next) => {
  const u = G.getOrCreateUser(req.tgUser, req.startParam);
  if (u.banned) return res.status(403).json({ error: 'Аккаунт заблокирован. Напиши в поддержку, если это ошибка' });
  if (u._new && u._referrer) tg.notifyReferrer(u._referrer, u).catch(() => {});
  req.offline = G.refresh(u);
  req.u = u;
  next();
});

const reply = (req, res, extra) => { G.save(req.u); res.json(G.state(req.u, extra)); };
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });

router.get('/state', (req, res) => reply(req, res, { offline_earned: req.offline, is_new: !!req.u._new }));

router.post('/tap', (req, res) => {
  const u = req.u, now = Date.now();
  const count = Math.max(0, Math.floor(Number(req.body?.count) || 0));
  const value = G.effective(u, now).tapValue;
  const elapsed = Math.min(10, Math.max(1, (now - u.last_tap) / 1000));
  const allowed = Math.min(count, Math.floor(elapsed * GAME.maxTapsPerSec), Math.floor(u.energy / value));
  u.energy -= allowed * value;
  G.earn(u, allowed * value);
  u.last_tap = now;
  reply(req, res);
});

router.post('/upgrade', (req, res) => {
  const u = req.u, key = String(req.body?.key || '');
  const item = UPGRADES[key] || CARDS[key];
  if (!item) return fail(res, 'Такого улучшения нет');
  const lv = G.levelsOf(u.id);
  const level = lv[key] || 0;
  if (item.max && level >= item.max) return fail(res, 'Уже максимальный уровень');
  if (item.requires) {
    for (const [k, need] of Object.entries(item.requires)) {
      if ((lv[k] || 0) < need) return fail(res, `Сначала прокачай «${CARDS[k].title}» до ${need} уровня`);
    }
  }
  const price = cost(item, level);
  if (u.balance < price) return fail(res, 'Не хватает монет');
  u.balance -= price;
  if (UPGRADES[key]) item.apply(u); else u.passive_per_hour += item.income;
  db.transaction(() => { G.q.setLevel.run(u.id, key, level + 1); G.save(u); })();
  res.json(G.state(u));
});

router.post('/daily', (req, res) => {
  const u = req.u, info = G.dailyInfo(u);
  if (info.claimed_today) return fail(res, 'Сегодняшняя награда уже получена');
  u.daily_streak = info.streak + 1;
  u.last_daily = G.todayStr();
  const reward = GAME.daily[Math.min(u.daily_streak, GAME.daily.length) - 1];
  G.earn(u, reward);
  reply(req, res, { reward });
});

const getTask = id => db.prepare('SELECT * FROM tasks WHERE id = ? AND active = 1').get(Number(id));
const getProg = (uid, tid) => db.prepare('SELECT * FROM task_progress WHERE user_id = ? AND task_id = ?').get(uid, tid);

router.post('/task/start', (req, res) => {
  const t = getTask(req.body?.id);
  if (!t) return fail(res, 'Задание не найдено');
  db.prepare('INSERT OR IGNORE INTO task_progress(user_id, task_id, started_at) VALUES(?, ?, ?)').run(req.u.id, t.id, Date.now());
  reply(req, res);
});

router.post('/task/claim', async (req, res) => {
  const u = req.u, t = getTask(req.body?.id);
  if (!t) return fail(res, 'Задание не найдено');
  const p = getProg(u.id, t.id);
  if (p?.done_at) return fail(res, 'Награда уже получена');
  if (t.type === 'refs') {
    const n = G.q.refCount.get(u.id).n;
    if (n < t.need) return fail(res, `Приглашено ${n} из ${t.need}`);
  } else if (t.type === 'link') {
    if (!p?.started_at) return fail(res, 'Сначала перейди по ссылке');
    if (Date.now() - p.started_at < GAME.linkTaskDelaySec * 1000) return fail(res, 'Проверяем… попробуй через несколько секунд');
  } else if (t.type === 'channel') {
    if (!(await tg.isMember(t.chat_id, u.id))) return fail(res, 'Подписка не найдена. Подпишись и нажми «Проверить» ещё раз');
  }
  G.earn(u, t.reward);
  db.transaction(() => {
    db.prepare(`INSERT INTO task_progress(user_id, task_id, started_at, done_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(user_id, task_id) DO UPDATE SET done_at = excluded.done_at`).run(u.id, t.id, p?.started_at || Date.now(), Date.now());
    G.save(u);
  })();
  res.json(G.state(u, { reward: t.reward }));
});

router.get('/friends', (req, res) => {
  G.save(req.u);
  res.json({ friends: G.q.friends.all(req.u.id).map(f => ({ name: f.first_name || f.username || 'Игрок', premium: !!f.is_premium, total: f.total })) });
});

router.get('/top', (req, res) => { G.save(req.u); res.json(G.leaderboard(req.u)); });

router.post('/skin', (req, res) => {
  const key = String(req.body?.key || '');
  const s = G.state(req.u).skins.find(x => x.key === key);
  if (!s) return fail(res, 'Такого скина нет');
  if (!s.owned) return fail(res, 'Этот скин ещё не открыт');
  req.u.skin = key;
  reply(req, res);
});

router.post('/settings', (req, res) => {
  if (typeof req.body?.notify === 'boolean') req.u.notify = req.body.notify ? 1 : 0;
  reply(req, res);
});

router.post('/buy', async (req, res) => {
  const key = String(req.body?.product || '');
  const p = PRODUCTS[key];
  if (!p) return fail(res, 'Такого товара нет');
  if (p.skin && G.skinsOf(req.u.id).has(p.skin)) return fail(res, 'Этот скин уже твой');
  G.save(req.u);
  try {
    res.json({ link: await tg.createInvoice(req.u.id, key) });
  } catch (e) {
    console.error('invoice error', e.message);
    fail(res, 'Оплата сейчас недоступна, попробуй позже', 503);
  }
});

module.exports = router;
