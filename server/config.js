// Все настройки игры в одном месте. Меняй цифры здесь — остальной код подстроится.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const env = process.env;

const ENV = {
  BOT_TOKEN: env.BOT_TOKEN || '',
  WEBAPP_URL: env.WEBAPP_URL || '',
  PORT: Number(env.PORT || 3000),
  DEV_MODE: env.DEV_MODE === '1',
  APP_SHORT_NAME: env.APP_SHORT_NAME || '',
  APP_TITLE: env.APP_TITLE || 'Gold Rush',
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  ADMIN_IDS: (env.ADMIN_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean),
  SUPPORT_CONTACT: env.SUPPORT_CONTACT || '',
  DATA_DIR: env.DATA_DIR || require('path').join(__dirname, 'data'),
};

const GAME = {
  baseEnergy: 1000,
  baseRegen: 3,             // энергии в секунду
  baseTapPower: 1,
  maxTapsPerSec: 15,        // антикликер
  passiveCapHours: 3,       // офлайн-доход копится максимум 3 часа
  refBonusInviter: 5000,
  refBonusInvitee: 2500,
  refBonusInviterPremium: 25000, // если друг с Telegram Premium
  daily: [500, 1000, 2000, 3000, 5000, 7500, 10000],
  linkTaskDelaySec: 10,     // через сколько секунд после перехода можно забрать награду за ссылку
};

// Бусты за монеты
const UPGRADES = {
  multitap: { title: 'Мультитап', icon: '👆', desc: '+1 монета за тап', base: 500, growth: 2, max: 25,
    apply: u => { u.tap_power += 1; } },
  energy:   { title: 'Запас энергии', icon: '🔋', desc: '+500 к запасу', base: 500, growth: 2, max: 20,
    apply: u => { u.max_energy += 500; } },
  regen:    { title: 'Восстановление', icon: '⚡', desc: '+1 энергии в секунду', base: 1000, growth: 2.2, max: 10,
    apply: u => { u.regen += 1; } },
};

// Карточки пассивного дохода. income — монет в час за каждый уровень.
// requires — открывается после нужного уровня другой карточки.
const CARDS = {
  pickaxe:  { title: 'Кирка',            icon: '⛏️', base: 300,    growth: 1.45, income: 30 },
  cart:     { title: 'Вагонетка',        icon: '🛒', base: 1000,   growth: 1.5,  income: 100 },
  mine:     { title: 'Шахта',            icon: '🏔️', base: 4000,   growth: 1.55, income: 350,  requires: { cart: 3 } },
  smelter:  { title: 'Плавильня',        icon: '🔥', base: 12000,  growth: 1.6,  income: 900,  requires: { mine: 3 } },
  jeweler:  { title: 'Ювелирная лавка',  icon: '💍', base: 40000,  growth: 1.65, income: 2600, requires: { smelter: 3 } },
  bank:     { title: 'Банк',             icon: '🏦', base: 150000, growth: 1.7,  income: 8500, requires: { jeweler: 5 } },
  railroad: { title: 'Железная дорога',  icon: '🚂', base: 600000, growth: 1.75, income: 30000, requires: { bank: 5 } },
};

// Ранги по сумме заработанного за всё время
const RANKS = [
  { name: 'Старатель', min: 0,          color: '#b98a5e' },
  { name: 'Добытчик',  min: 50_000,     color: '#c9d1dc' },
  { name: 'Мастер',    min: 250_000,    color: '#f2c14e' },
  { name: 'Магнат',    min: 1_000_000,  color: '#7fe3d0' },
  { name: 'Барон',     min: 5_000_000,  color: '#8fb4ff' },
  { name: 'Легенда',   min: 25_000_000, color: '#c79bff' },
];

// Скины монеты. stars — цена в Telegram Stars; rank — открывается бесплатно на этом ранге.
const SKINS = {
  gold:    { title: 'Золото',  color: '#f2c14e', free: true },
  silver:  { title: 'Серебро', color: '#d9dee6', rank: 1 },
  emerald: { title: 'Изумруд', color: '#2fd08a', stars: 50 },
  ruby:    { title: 'Рубин',   color: '#ff4d6d', stars: 100 },
  cosmic:  { title: 'Космос',  color: '#9b7bff', stars: 250 },
};

// Товары за Telegram Stars. Цена в звёздах (XTR).
const PRODUCTS = {
  refill:  { title: 'Полная энергия',  icon: '⚡', desc: 'Энергия восполняется сразу', stars: 10 },
  boost:   { title: 'Турбо ×2 на час', icon: '🚀', desc: 'Каждый тап приносит вдвое больше', stars: 25 },
  coins_s: { title: '250 000 монет',   icon: '💰', desc: 'Мешок монет на баланс', stars: 50,  coins: 250_000 },
  coins_m: { title: '1 500 000 монет', icon: '💎', desc: 'Сундук монет на баланс', stars: 250, coins: 1_500_000 },
  vip:     { title: 'VIP на 30 дней',  icon: '👑', desc: 'Пассивный доход ×2 и энергия быстрее в 1,5 раза', stars: 300 },
};
for (const [key, s] of Object.entries(SKINS)) {
  if (s.stars) PRODUCTS['skin_' + key] = { title: 'Скин «' + s.title + '»', icon: '🪙', desc: 'Новый вид монеты', stars: s.stars, skin: key };
}

const cost = (item, level) => Math.floor(item.base * Math.pow(item.growth, level));

module.exports = { ENV, GAME, UPGRADES, CARDS, RANKS, SKINS, PRODUCTS, cost };
