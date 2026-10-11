const crypto = require('crypto');
const { ENV } = require('./config');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Проверка подписи данных, которые Telegram передаёт в Mini App
function checkInitData(initData) {
  if (!ENV.BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(ENV.BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (!safeEq(calc, hash)) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  try { return { user: JSON.parse(params.get('user')), startParam: params.get('start_param') }; }
  catch { return null; }
}

// Токен админа: срок + подпись. Меняешь ADMIN_PASSWORD — старые токены перестают работать.
const adminKey = () => crypto.createHash('sha256').update('admin:' + ENV.ADMIN_PASSWORD + ':' + ENV.BOT_TOKEN).digest();
function makeAdminToken() {
  const exp = String(Date.now() + 7 * 864e5);
  return exp + '.' + crypto.createHmac('sha256', adminKey()).update(exp).digest('hex');
}
function checkAdminToken(token) {
  if (!ENV.ADMIN_PASSWORD || !token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, crypto.createHmac('sha256', adminKey()).update(exp).digest('hex'));
}
const checkAdminPassword = p => !!ENV.ADMIN_PASSWORD && safeEq(p || '', ENV.ADMIN_PASSWORD);

// Простой лимит запросов в памяти
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: 'Слишком много запросов, подожди немного' });
    next();
  };
}

module.exports = { checkInitData, makeAdminToken, checkAdminToken, checkAdminPassword, rateLimit };
