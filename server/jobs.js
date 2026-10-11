// Фоновые задачи: рассылки, напоминания игрокам, ежедневные бэкапы базы
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { ENV, GAME } = require('./config');
const tg = require('./bot');
const { effective } = require('./game');

const fmt = n => Math.floor(n).toLocaleString('ru-RU');

// ── Рассылки ──
let broadcasting = false;
async function runBroadcasts() {
  if (broadcasting || !tg.bot) return;
  const b = db.prepare("SELECT * FROM broadcasts WHERE status IN ('queued','running') ORDER BY id LIMIT 1").get();
  if (!b) return;
  broadcasting = true;
  try {
    if (b.status === 'queued') {
      const total = db.prepare('SELECT COUNT(*) AS n FROM users WHERE bot_blocked = 0 AND banned = 0').get().n;
      db.prepare("UPDATE broadcasts SET status = 'running', total = ? WHERE id = ?").run(total, b.id);
    }
    const users = db.prepare('SELECT id FROM users WHERE id > ? AND bot_blocked = 0 AND banned = 0 ORDER BY id LIMIT 25').all(b.cursor);
    if (!users.length) {
      db.prepare("UPDATE broadcasts SET status = 'done', finished_at = ? WHERE id = ?").run(Date.now(), b.id);
      tg.notifyAdmins(`📨 Рассылка #${b.id} завершена: доставлено ${fmt(b.sent)}, ошибок ${fmt(b.failed)}`);
      return;
    }
    const kb = b.button_text && b.button_url
      ? { reply_markup: { inline_keyboard: [[b.button_url === 'game'
          ? { text: b.button_text, web_app: { url: ENV.WEBAPP_URL } }
          : { text: b.button_text, url: b.button_url }]] } }
      : {};
    const results = await Promise.allSettled(users.map(u => tg.send(u.id, b.text, kb)));
    const sent = results.filter(r => r.status === 'fulfilled').length;
    const cur = db.prepare('SELECT status FROM broadcasts WHERE id = ?').get(b.id);
    db.prepare(`UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ?, status = ? WHERE id = ?`)
      .run(users[users.length - 1].id, sent, results.length - sent, cur.status === 'cancelled' ? 'cancelled' : 'running', b.id);
  } catch (e) {
    console.error('broadcast error', e.message);
  } finally {
    broadcasting = false;
  }
}

// ── Напоминания: энергия восстановилась, доход накопился ──
async function runReminders() {
  if (!tg.bot) return;
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM users WHERE notify = 1 AND bot_blocked = 0 AND banned = 0
    AND last_seen < ? AND last_seen > ? AND last_notified < ? LIMIT 300`)
    .all(now - 3 * 3600e3, now - 14 * 864e5, now - 20 * 3600e3);
  for (const u of rows) {
    const e = effective(u, now);
    const hours = Math.min(GAME.passiveCapHours, (now - u.last_passive) / 3.6e6);
    const income = e.passive * hours;
    const text = income >= 100
      ? `⛏ Шахта работала без тебя: накопилось <b>${fmt(income)}</b> монет, а энергия снова полная. Забери, пока копилка не переполнилась!`
      : '⚡ Энергия восстановилась — самое время потапать!';
    db.prepare('UPDATE users SET last_notified = ? WHERE id = ?').run(now, u.id);
    tg.send(u.id, text, { reply_markup: tg.playKeyboard('⛏ Забрать') }).catch(() => {});
  }
}

// ── Бэкапы: раз в сутки, хранятся последние 7 ──
async function runBackup() {
  if (typeof db.backup !== 'function') return;
  const dir = path.join(ENV.DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `game-${new Date().toISOString().slice(0, 10)}.db`);
  try {
    await db.backup(file);
    const old = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().slice(0, -7);
    old.forEach(f => fs.unlinkSync(path.join(dir, f)));
    console.log('Бэкап сохранён:', file);
  } catch (e) { console.error('backup error', e.message); }
}

function start() {
  setInterval(runBroadcasts, 1500).unref();
  setInterval(runReminders, 10 * 60e3).unref();
  setTimeout(runBackup, 60e3).unref();
  setInterval(runBackup, 24 * 3600e3).unref();
}

module.exports = { start, runBroadcasts, runReminders, runBackup };
