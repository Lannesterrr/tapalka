const crypto = require('crypto');
const { Bot, InlineKeyboard } = require('grammy');
const db = require('./db');
const { ENV, PRODUCTS } = require('./config');

let bot = null;
const G = () => require('./game'); // ленивый импорт, чтобы не было циклической зависимости

const fmt = n => Math.floor(n).toLocaleString('ru-RU');
const playKeyboard = (text = '🎮 Играть') => /^https:\/\/[^/]+/.test(ENV.WEBAPP_URL)
  ? new InlineKeyboard().webApp(text, ENV.WEBAPP_URL)
  : undefined; // без HTTPS-адреса Telegram не примет кнопку Mini App

// ── Очередь отправки: Telegram разрешает ~30 сообщений в секунду ──
const queue = [];
let pausedUntil = 0;
setInterval(async () => {
  if (!queue.length || Date.now() < pausedUntil) return;
  const job = queue.shift();
  try { job.resolve(await job.fn()); }
  catch (e) {
    const retry = e?.parameters?.retry_after;
    if (e?.error_code === 429 && retry) { pausedUntil = Date.now() + retry * 1000; queue.unshift(job); return; }
    if (e?.error_code === 403) db.prepare('UPDATE users SET bot_blocked = 1 WHERE id = ?').run(job.chatId);
    job.reject(e);
  }
}, 40).unref();

function send(chatId, text, extra = {}) {
  if (!bot) return Promise.reject(new Error('bot disabled'));
  return new Promise((resolve, reject) => {
    queue.push({ chatId, resolve, reject, fn: () => bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra }) });
  });
}
const queueSize = () => queue.length;

function notifyAdmins(text) {
  for (const id of ENV.ADMIN_IDS) send(id, text).catch(() => {});
}

async function notifyReferrer(referrerId, newUser) {
  const ref = db.prepare('SELECT notify, bot_blocked FROM users WHERE id = ?').get(referrerId);
  if (!ref || !ref.notify || ref.bot_blocked) return;
  const { GAME } = require('./config');
  const bonus = newUser.is_premium ? GAME.refBonusInviterPremium : GAME.refBonusInviter;
  const name = String(newUser.first_name || 'Друг').replace(/[<>&]/g, '');
  await send(referrerId, `🎉 <b>${name}</b> присоединился по твоей ссылке!\n+${fmt(bonus)} монет на баланс`, { reply_markup: playKeyboard() });
}

async function isMember(chatId, userId) {
  if (!bot || !chatId) return false;
  try {
    const m = await bot.api.getChatMember(chatId, userId);
    return ['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member);
  } catch { return false; }
}

// ── Оплата в Telegram Stars ──
async function createInvoice(userId, productKey) {
  if (!bot) throw new Error('bot disabled');
  const p = PRODUCTS[productKey];
  const payload = `${userId}:${productKey}:${crypto.randomBytes(6).toString('hex')}`;
  return bot.api.createInvoiceLink(p.title, p.desc, payload, '', 'XTR', [{ label: p.title, amount: p.stars }]);
}

function parsePayload(s) {
  const [uid, product] = String(s || '').split(':');
  return { userId: Number(uid), product };
}

async function refund(paymentId) {
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!pay) throw new Error('Платёж не найден');
  if (pay.status === 'refunded') throw new Error('Уже возвращён');
  if (!bot) throw new Error('Бот не запущен');
  await bot.api.refundStarPayment(pay.user_id, pay.charge_id);
  db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(pay.id);
  db.prepare('UPDATE users SET stars_spent = MAX(0, stars_spent - ?) WHERE id = ?').run(pay.stars, pay.user_id);
  const u = G().q.get.get(pay.user_id);
  if (u) G().revoke(u, pay.product);
}

function setup() {
  bot.command('start', async ctx => {
    const m = /^ref_(\d+)$/.exec(ctx.match || '');
    if (m && Number(m[1]) !== ctx.from.id && !G().q.get.get(ctx.from.id)) {
      db.prepare('INSERT OR IGNORE INTO pending_refs(user_id, referrer_id) VALUES(?, ?)').run(ctx.from.id, Number(m[1]));
    }
    db.prepare('UPDATE users SET bot_blocked = 0 WHERE id = ?').run(ctx.from.id);
    await ctx.reply(
      `<b>${ENV.APP_TITLE}</b>\n\nТапай монету, строй империю и обгоняй друзей в рейтинге.\nМонеты — игровая валюта, их нельзя вывести.`,
      { parse_mode: 'HTML', reply_markup: playKeyboard('🎮 Открыть игру') });
    if (!playKeyboard()) await ctx.reply('Игра ещё настраивается — загляни чуть позже.');
  });

  // Обязательные по правилам Telegram команды для приёма оплаты
  bot.command('paysupport', ctx => ctx.reply(
    'Вопросы по покупкам: опиши проблему одним сообщением' +
    (ENV.SUPPORT_CONTACT ? ` и отправь его ${ENV.SUPPORT_CONTACT}` : ' прямо сюда') +
    '. Мы проверим платёж и при необходимости вернём звёзды.'));
  bot.command('terms', ctx => ctx.reply(
    'Покупки дают внутриигровые бонусы и не имеют денежной стоимости. Монеты нельзя вывести или обменять на деньги. ' +
    'Если покупка не пришла, напиши /paysupport.'));

  bot.command('stats', async ctx => {
    if (!ENV.ADMIN_IDS.includes(ctx.from.id)) return;
    const day = Date.now() - 864e5;
    const s = db.prepare(`SELECT COUNT(*) AS users,
      SUM(created_at > ?) AS new_day, SUM(last_seen > ?) AS dau FROM users`).get(day, day);
    const p = db.prepare(`SELECT COALESCE(SUM(stars),0) AS total, COALESCE(SUM(CASE WHEN created_at > ? THEN stars END),0) AS today
      FROM payments WHERE status = 'paid'`).get(day);
    await ctx.reply(`📊 Игроков: ${fmt(s.users)}\nНовых за сутки: ${fmt(s.new_day || 0)}\nАктивных за сутки: ${fmt(s.dau || 0)}\n⭐ Звёзд всего: ${fmt(p.total)}\n⭐ За сутки: ${fmt(p.today)}`);
  });

  bot.on('pre_checkout_query', async ctx => {
    const q = ctx.preCheckoutQuery;
    const { userId, product } = parsePayload(q.invoice_payload);
    const p = PRODUCTS[product];
    const u = G().q.get.get(userId);
    let error = null;
    if (!p || q.currency !== 'XTR' || q.total_amount !== p.stars) error = 'Товар изменился, открой магазин заново';
    else if (!u || userId !== q.from.id) error = 'Сначала открой игру';
    else if (u.banned) error = 'Аккаунт заблокирован';
    else if (p.skin && G().skinsOf(userId).has(p.skin)) error = 'Этот скин уже куплен';
    await ctx.answerPreCheckoutQuery(!error, error ? { error_message: error } : undefined);
  });

  bot.on('message:successful_payment', async ctx => {
    const sp = ctx.message.successful_payment;
    const { userId, product } = parsePayload(sp.invoice_payload);
    const ins = db.prepare(`INSERT OR IGNORE INTO payments(user_id, product, stars, charge_id, created_at)
      VALUES(?, ?, ?, ?, ?)`).run(userId, product, sp.total_amount, sp.telegram_payment_charge_id, Date.now());
    if (!ins.changes) return; // этот платёж уже обработан
    const u = G().q.get.get(userId);
    if (u) G().grant(u, product);
    db.prepare('UPDATE users SET stars_spent = stars_spent + ? WHERE id = ?').run(sp.total_amount, userId);
    await ctx.reply(`✅ Готово: ${PRODUCTS[product]?.title || product}. Спасибо за покупку!`, { reply_markup: playKeyboard('🎮 Вернуться в игру') });
    notifyAdmins(`💰 Покупка: ${PRODUCTS[product]?.title || product} — ${sp.total_amount} ⭐\nИгрок: ${userId}`);
  });

  bot.catch(err => console.error('Bot error:', err.message));
}

async function start() {
  if (!ENV.BOT_TOKEN) { console.log('BOT_TOKEN не задан — бот выключен (DEV)'); return; }
  bot = new Bot(ENV.BOT_TOKEN);
  setup();
  await bot.init();
  G().setBotUsername(bot.botInfo.username);
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть игру' },
    { command: 'paysupport', description: 'Помощь с покупками' },
    { command: 'terms', description: 'Условия' },
  ]).catch(() => {});
  if (playKeyboard()) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Играть', web_app: { url: ENV.WEBAPP_URL } } }).catch(() => {});
  }
  if (!/^https:\/\/[^/]+/.test(ENV.WEBAPP_URL)) console.warn('⚠️ WEBAPP_URL не задан или не начинается с https:// — кнопка игры не появится');
  bot.start({ allowed_updates: ['message', 'pre_checkout_query'] });
  console.log('Бот запущен: @' + bot.botInfo.username);
}

module.exports = { start, send, queueSize, isMember, createInvoice, refund, notifyReferrer, notifyAdmins, playKeyboard, get bot() { return bot; } };
