const db = require('./db');
const { ENV, GAME, UPGRADES, CARDS, RANKS, SKINS, PRODUCTS, cost } = require('./config');

const q = {
  get: db.prepare('SELECT * FROM users WHERE id = ?'),
  insert: db.prepare(`INSERT INTO users(id, username, first_name, is_premium, lang, balance, total_earned,
      energy, max_energy, regen, tap_power, last_energy, last_passive, last_tap, last_seen, referrer_id, created_at)
    VALUES(@id, @username, @first_name, @is_premium, @lang, @balance, @balance,
      @energy, @energy, @regen, @tap_power, @now, @now, @now, @now, @referrer_id, @now)`),
  save: db.prepare(`UPDATE users SET username=@username, first_name=@first_name, is_premium=@is_premium,
      balance=@balance, total_earned=@total_earned, energy=@energy, max_energy=@max_energy, regen=@regen,
      tap_power=@tap_power, passive_per_hour=@passive_per_hour, last_energy=@last_energy,
      last_passive=@last_passive, last_tap=@last_tap, last_seen=@last_seen, daily_streak=@daily_streak,
      last_daily=@last_daily, skin=@skin, boost_until=@boost_until, vip_until=@vip_until, notify=@notify
    WHERE id=@id`),
  reward: db.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?'),
  levels: db.prepare('SELECT key, level FROM levels WHERE user_id = ?'),
  setLevel: db.prepare(`INSERT INTO levels(user_id, key, level) VALUES(?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET level = excluded.level`),
  skins: db.prepare('SELECT skin FROM skins_owned WHERE user_id = ?'),
  addSkin: db.prepare('INSERT OR IGNORE INTO skins_owned(user_id, skin) VALUES(?, ?)'),
  refCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?'),
  friends: db.prepare(`SELECT first_name, username, is_premium, CAST(total_earned AS INTEGER) AS total
    FROM users WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 200`),
  pendingRef: db.prepare('SELECT referrer_id FROM pending_refs WHERE user_id = ?'),
  tasks: db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY sort, id'),
  progress: db.prepare('SELECT task_id, started_at, done_at FROM task_progress WHERE user_id = ?'),
  top: db.prepare(`SELECT id, first_name, username, skin, CAST(total_earned AS INTEGER) AS total
    FROM users WHERE banned = 0 ORDER BY total_earned DESC LIMIT 50`),
  place: db.prepare('SELECT COUNT(*) + 1 AS n FROM users WHERE banned = 0 AND total_earned > ?'),
};

const levelsOf = id => Object.fromEntries(q.levels.all(id).map(r => [r.key, r.level]));
const skinsOf = id => new Set(q.skins.all(id).map(r => r.skin));

function rankOf(total) {
  let i = 0;
  while (i + 1 < RANKS.length && total >= RANKS[i + 1].min) i++;
  return i;
}

// Действующие значения с учётом VIP и турбо
function effective(u, now = Date.now()) {
  const vip = u.vip_until > now, boost = u.boost_until > now;
  return {
    vip, boost,
    tapValue: u.tap_power * (boost ? 2 : 1),
    regen: u.regen * (vip ? 1.5 : 1),
    passive: u.passive_per_hour * (vip ? 2 : 1),
  };
}

function earn(u, amount) { u.balance += amount; u.total_earned += amount; }

function getOrCreateUser(tg, startParam) {
  const now = Date.now();
  const u = q.get.get(tg.id);
  if (u) {
    u.username = tg.username || null;
    u.first_name = tg.first_name || '';
    u.is_premium = tg.is_premium ? 1 : 0;
    return u;
  }
  let referrer = null;
  const m = /^ref_(\d+)$/.exec(startParam || '');
  if (m) referrer = Number(m[1]);
  if (!referrer) referrer = q.pendingRef.get(tg.id)?.referrer_id || null;
  if (referrer === tg.id || (referrer && !q.get.get(referrer))) referrer = null;

  db.transaction(() => {
    q.insert.run({
      id: tg.id, username: tg.username || null, first_name: tg.first_name || '',
      is_premium: tg.is_premium ? 1 : 0, lang: tg.language_code || null,
      balance: referrer ? GAME.refBonusInvitee : 0,
      energy: GAME.baseEnergy, regen: GAME.baseRegen, tap_power: GAME.baseTapPower,
      referrer_id: referrer, now,
    });
    q.addSkin.run(tg.id, 'gold');
    if (referrer) {
      const bonus = tg.is_premium ? GAME.refBonusInviterPremium : GAME.refBonusInviter;
      q.reward.run(bonus, bonus, referrer);
    }
  })();
  const created = q.get.get(tg.id);
  created._new = true;
  created._referrer = referrer;
  return created;
}

// Начисляет восстановленную энергию и пассивный доход. Возвращает офлайн-доход.
function refresh(u, now = Date.now()) {
  const e = effective(u, now);
  u.energy = Math.min(u.max_energy, u.energy + e.regen * (now - u.last_energy) / 1000);
  u.last_energy = now;
  const hours = Math.min(GAME.passiveCapHours, Math.max(0, now - u.last_passive) / 3.6e6);
  const passive = e.passive * hours;
  earn(u, passive);
  u.last_passive = now;
  const offline = now - u.last_seen > 5 * 60e3 ? Math.floor(passive) : 0;
  u.last_seen = now;
  return offline;
}

function save(u) { q.save.run(u); }

const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);
const yesterdayStr = () => todayStr(new Date(Date.now() - 864e5));
function dailyInfo(u) {
  const today = todayStr();
  const alive = u.last_daily === today || u.last_daily === yesterdayStr();
  return { streak: alive ? u.daily_streak : 0, claimed_today: u.last_daily === today, rewards: GAME.daily };
}

let botUsername = '';
const setBotUsername = n => { botUsername = n; };
function inviteLink(id) {
  if (!botUsername) return null;
  return ENV.APP_SHORT_NAME
    ? `https://t.me/${botUsername}/${ENV.APP_SHORT_NAME}?startapp=ref_${id}`
    : `https://t.me/${botUsername}?start=ref_${id}`;
}

function cardLocked(card, lv) {
  if (!card.requires) return null;
  for (const [k, need] of Object.entries(card.requires)) {
    if ((lv[k] || 0) < need) return { key: k, title: CARDS[k].title, level: need };
  }
  return null;
}

function tasksFor(u, refs) {
  const prog = Object.fromEntries(q.progress.all(u.id).map(p => [p.task_id, p]));
  return q.tasks.all().map(t => ({
    id: t.id, title: t.title, icon: t.icon, reward: t.reward, type: t.type, url: t.url, need: t.need,
    progress: t.type === 'refs' ? Math.min(refs, t.need) : null,
    started: !!prog[t.id]?.started_at, done: !!prog[t.id]?.done_at,
  }));
}

function state(u, extra = {}) {
  const now = Date.now();
  const lv = levelsOf(u.id);
  const owned = skinsOf(u.id);
  const refs = q.refCount.get(u.id).n;
  const e = effective(u, now);
  const r = rankOf(u.total_earned);
  return {
    id: u.id,
    name: u.first_name,
    balance: Math.floor(u.balance),
    total_earned: Math.floor(u.total_earned),
    energy: u.energy,
    max_energy: u.max_energy,
    regen: e.regen,
    tap_value: e.tapValue,
    passive_per_hour: e.passive,
    boost_until: e.boost ? u.boost_until : 0,
    vip_until: e.vip ? u.vip_until : 0,
    rank: { index: r, ...RANKS[r], next: RANKS[r + 1] || null },
    skin: u.skin,
    skins: Object.entries(SKINS).map(([key, s]) => ({
      key, title: s.title, color: s.color, owned: owned.has(key) || (s.rank != null && r >= s.rank),
      stars: s.stars || null, rank: s.rank != null ? RANKS[s.rank].name : null,
    })),
    upgrades: Object.entries(UPGRADES).map(([key, x]) => {
      const level = lv[key] || 0;
      return { key, title: x.title, icon: x.icon, desc: x.desc, level, max: x.max, cost: level >= x.max ? null : cost(x, level) };
    }),
    cards: Object.entries(CARDS).map(([key, c]) => {
      const level = lv[key] || 0;
      return { key, title: c.title, icon: c.icon, income: c.income, level, cost: cost(c, level), locked: cardLocked(c, lv) };
    }),
    products: Object.entries(PRODUCTS).filter(([, p]) => !p.skin)
      .map(([key, p]) => ({ key, title: p.title, icon: p.icon, desc: p.desc, stars: p.stars })),
    tasks: tasksFor(u, refs),
    daily: dailyInfo(u),
    referrals: refs,
    ref_bonus: GAME.refBonusInviter,
    ref_bonus_premium: GAME.refBonusInviterPremium,
    invite_link: inviteLink(u.id),
    notify: !!u.notify,
    server_time: now,
    ...extra,
  };
}

// Выдача купленного за звёзды
function grant(u, productKey) {
  const p = PRODUCTS[productKey];
  if (!p) throw new Error('unknown product ' + productKey);
  const now = Date.now();
  refresh(u, now);
  if (productKey === 'refill') u.energy = u.max_energy;
  else if (productKey === 'boost') u.boost_until = Math.max(now, u.boost_until) + 3600e3;
  else if (productKey === 'vip') u.vip_until = Math.max(now, u.vip_until) + 30 * 864e5;
  else if (p.coins) earn(u, p.coins);
  else if (p.skin) { q.addSkin.run(u.id, p.skin); u.skin = p.skin; }
  save(u);
}

// Откат покупки при возврате звёзд
function revoke(u, productKey) {
  const p = PRODUCTS[productKey];
  if (!p) return;
  refresh(u);
  if (productKey === 'boost') u.boost_until = Math.max(0, u.boost_until - 3600e3);
  else if (productKey === 'vip') u.vip_until = Math.max(0, u.vip_until - 30 * 864e5);
  else if (p.coins) u.balance = Math.max(0, u.balance - p.coins);
  else if (p.skin) {
    db.prepare('DELETE FROM skins_owned WHERE user_id = ? AND skin = ?').run(u.id, p.skin);
    if (u.skin === p.skin) u.skin = 'gold';
  }
  save(u);
}

// Топ кэшируется на минуту
let topCache = { at: 0, rows: [] };
function leaderboard(u) {
  if (Date.now() - topCache.at > 60e3) {
    topCache = { at: Date.now(), rows: q.top.all().map(r => ({
      id: r.id, name: r.first_name || r.username || 'Игрок', skin: r.skin, total: r.total, rank: rankOf(r.total),
    })) };
  }
  return {
    top: topCache.rows.map(r => ({ ...r, me: r.id === u.id, id: undefined })),
    me: { place: q.place.get(u.total_earned).n, total: Math.floor(u.total_earned) },
  };
}

module.exports = {
  q, levelsOf, skinsOf, rankOf, effective, earn, getOrCreateUser, refresh, save, state, dailyInfo,
  todayStr, grant, revoke, leaderboard, setBotUsername, inviteLink,
};
