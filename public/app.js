const tg = window.Telegram?.WebApp;
const inTelegram = !!tg?.initData;
try {
  tg?.ready(); tg?.expand();
  tg?.setHeaderColor?.('#0b1026'); tg?.setBackgroundColor?.('#0b1026'); tg?.setBottomBarColor?.('#0b1026');
  tg?.disableVerticalSwipes?.();
} catch {}

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => {
  n = Math.floor(n);
  const a = Math.abs(n);
  const cut = (v, s) => { let t = v.toFixed(Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0); if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, ''); return t.replace('.', ',') + s; };
  if (a >= 1e9) return cut(n / 1e9, 'B');
  if (a >= 1e6) return cut(n / 1e6, 'M');
  if (a >= 1e5) return cut(n / 1e3, 'K');
  return n.toLocaleString('ru-RU');
};
const full = n => Math.floor(n).toLocaleString('ru-RU');
const dur = ms => { const m = Math.max(0, Math.ceil(ms / 60e3)); return m >= 60 * 24 ? Math.floor(m / 1440) + ' дн.' : m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин'; };

// ── сеть ──
const qs = new URLSearchParams(location.search);
const headers = { 'Content-Type': 'application/json' };
if (inTelegram) headers['X-Init-Data'] = tg.initData;
else { headers['X-Dev-User'] = qs.get('dev') || '1'; if (qs.get('ref')) headers['X-Dev-Ref'] = qs.get('ref'); }

async function api(path, body) {
  const r = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, keepalive: true });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Нет связи с сервером. Проверь интернет'); e.status = r.status; throw e; }
  return j;
}

// ── отклик ──
function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2400); }
const haptic = {
  tap: () => { try { tg.HapticFeedback.impactOccurred('light'); } catch {} },
  hard: () => { try { tg.HapticFeedback.impactOccurred('medium'); } catch {} },
  ok: () => { try { tg.HapticFeedback.notificationOccurred('success'); } catch {} },
  err: () => { try { tg.HapticFeedback.notificationOccurred('error'); } catch {} },
};

// ── состояние ──
let S = null, pending = 0, inflight = false, coin = null, clockSkew = 0;
const now = () => Date.now() + clockSkew;

function apply(r) {
  S = r;
  clockSkew = r.server_time - Date.now();
  S.energy -= pending * S.tap_value;
  S.balance += pending * S.tap_value;
  S.total_earned += pending * S.tap_value;
  renderAll();
}
async function sync() {
  if (!pending || inflight) return;
  const n = pending; pending = 0; inflight = true;
  try { apply(await api('/tap', { count: n })); } catch (e) { if (e.status === 403) fatal(e.message); }
  inflight = false;
}
async function flush() { while (inflight) await sleep(25); await sync(); while (inflight) await sleep(25); }

async function act(path, body, okText) {
  try {
    await flush();
    const r = await api(path, body);
    apply(r); haptic.ok();
    if (okText) toast(typeof okText === 'function' ? okText(r) : okText);
    return r;
  } catch (e) { haptic.err(); toast(e.message); return null; }
}

// ── отрисовка ──
function renderTop() {
  if (!S) return;
  $('#balance').textContent = full(S.balance);
  $('#eNow').textContent = full(S.energy);
  $('#eMax').textContent = full(S.max_energy);
  $('#eFill').style.width = Math.max(0, S.energy / S.max_energy * 100) + '%';
  $('#ebar').classList.toggle('low', S.energy < S.tap_value * 10);
  document.querySelectorAll('button[data-cost]').forEach(b => { b.disabled = S.balance < Number(b.dataset.cost); });
  const r = S.rank, total = S.total_earned;
  $('#rankName').textContent = r.name;
  $('#rankNext').textContent = r.next ? `${fmt(r.next.min - total)} до «${r.next.name}»` : 'Высший ранг';
  $('#rankProg').style.width = r.next ? Math.min(100, (total - r.min) / (r.next.min - r.min) * 100) + '%' : '100%';
  $('#ava').style.background = r.color;
}

function renderEffects() {
  const t = now(), fx = [];
  if (S.boost_until > t) fx.push(`<span class="fx boost">🚀 Турбо ×2 · ${dur(S.boost_until - t)}</span>`);
  if (S.vip_until > t) fx.push(`<span class="fx vip">👑 VIP · ${dur(S.vip_until - t)}</span>`);
  $('#effects').innerHTML = fx.join('');
}

function renderAll() {
  $('#ava').textContent = (S.name || '?').trim().charAt(0).toUpperCase() || '?';
  $('#rTap').textContent = '+' + fmt(S.tap_value);
  $('#rHour').textContent = fmt(S.passive_per_hour);
  renderEffects();

  $('#cards').innerHTML = S.cards.map(c => c.locked ? `
    <div class="li locked"><div class="ic">${c.icon}</div>
      <div class="tx"><b>${esc(c.title)}</b><small>Откроется, когда «${esc(c.locked.title)}» будет на ${c.locked.level} уровне</small></div>
      <span class="lvl">🔒</span></div>` : `
    <div class="li"><div class="ic">${c.icon}</div>
      <div class="tx"><b>${esc(c.title)} <span class="lvl">ур. ${c.level}</span></b>
        <small><em>+${fmt(c.income)}/ч</em> · окупится за ${payback(c.cost, c.income)}</small></div>
      <button class="price" data-up="${c.key}" data-cost="${c.cost}">${fmt(c.cost)}</button></div>`).join('');

  $('#boosts').innerHTML = S.upgrades.map(u => `
    <div class="li"><div class="ic">${u.icon}</div>
      <div class="tx"><b>${esc(u.title)} <span class="lvl">${u.level}/${u.max}</span></b><small>${esc(u.desc)}</small></div>
      ${u.cost === null ? '<button class="price done" disabled>Максимум</button>'
        : `<button class="price" data-up="${u.key}" data-cost="${u.cost}">${fmt(u.cost)}</button>`}</div>`).join('');

  $('#products').innerHTML = S.products.map(p => `
    <div class="li"><div class="ic">${p.icon}</div>
      <div class="tx"><b>${esc(p.title)}</b><small>${esc(p.desc)}</small></div>
      <button class="price stars" data-buy="${p.key}">⭐ ${p.stars}</button></div>`).join('');

  $('#skins').innerHTML = S.skins.map(s => {
    const on = S.skin === s.key;
    const note = on ? 'Выбран' : s.owned ? 'Нажми, чтобы выбрать' : s.stars ? `⭐ ${s.stars}` : `Ранг «${esc(s.rank)}»`;
    return `<button class="skin${on ? ' on' : ''}" data-skin="${s.key}" data-owned="${s.owned ? 1 : 0}" style="--c:${s.color}">
      <div class="disc"></div><b>${esc(s.title)}</b><small>${note}</small></button>`;
  }).join('');

  const d = S.daily, idx = Math.min(d.streak, d.rewards.length - 1);
  $('#days').innerHTML = d.rewards.map((r, i) => {
    const got = d.claimed_today ? i < d.streak : i < d.streak;
    const today = !d.claimed_today && i === idx;
    return `<div class="${got ? 'got' : ''}${today ? ' today' : ''}">День ${i + 1}<b>${fmt(r)}</b></div>`;
  }).join('');
  $('#dailyBtn').disabled = d.claimed_today;
  $('#dailyBtn').textContent = d.claimed_today ? 'Следующая награда завтра' : `Забрать ${full(d.rewards[idx])}`;

  $('#tasks').innerHTML = S.tasks.length ? S.tasks.map(t => {
    let btn;
    if (t.done) btn = '<button class="price done" disabled>Готово</button>';
    else if (t.type === 'refs') btn = t.progress >= t.need ? `<button class="price" data-claim="${t.id}">Забрать</button>` : `<button class="price ghost" disabled>${t.progress}/${t.need}</button>`;
    else btn = t.started ? `<button class="price" data-claim="${t.id}">Проверить</button>` : `<button class="price ghost" data-start="${t.id}">Открыть</button>`;
    return `<div class="li"><div class="ic">${esc(t.icon)}</div>
      <div class="tx"><b>${esc(t.title)}</b><small><em>+${fmt(t.reward)}</em> монет</small></div>${btn}</div>`;
  }).join('') : '<div class="empty">Скоро здесь появятся новые задания</div>';

  $('#bonus1').textContent = '+' + fmt(S.ref_bonus);
  $('#bonus2').textContent = '+' + fmt(S.ref_bonus_premium);
  $('#friendsTitle').textContent = S.referrals ? `Твои друзья · ${S.referrals}` : 'Твои друзья';

  // точка на «Задания», если есть что забрать
  const claimable = !S.daily.claimed_today || S.tasks.some(t => !t.done && t.type === 'refs' && t.progress >= t.need);
  const tb = document.querySelector('nav.dock [data-p="tasks"]');
  tb.querySelector('.badge')?.remove();
  if (claimable) tb.insertAdjacentHTML('beforeend', '<i class="badge"></i>');

  const skin = S.skins.find(s => s.key === S.skin);
  if (skin) { coin?.setSkin(skin.color); $('#coinFallback')?.style.setProperty('--skin', skin.color); }
  renderTop();
}
const payback = (cost, income) => { const h = cost / income; return h < 1 ? Math.max(1, Math.round(h * 60)) + ' мин' : h < 48 ? Math.round(h) + ' ч' : Math.round(h / 24) + ' дн.'; };

// ── монета ──
async function initCoin() {
  const wrap = $('#coinWrap');
  const letter = (document.title || 'G').trim().charAt(0).toUpperCase();
  try {
    const mod = await Promise.race([import('./coin3d.js'), sleep(6000).then(() => { throw new Error('timeout'); })]);
    coin = mod.createCoin(wrap, { letter });
  } catch (e) {
    console.warn('3D недоступно, обычная монета', e);
    wrap.insertAdjacentHTML('beforeend', `<div id="coinFallback">${letter}</div>`);
  }
  if (S) renderAll();
}

function onTap(e) {
  e.preventDefault();
  if (!S) return;
  if (S.energy < S.tap_value) { haptic.err(); toast('Энергия закончилась — подожди или пополни в магазине'); return; }
  S.energy -= S.tap_value; S.balance += S.tap_value; S.total_earned += S.tap_value; pending++;
  const boosted = S.boost_until > now();
  const box = e.currentTarget.getBoundingClientRect();
  coin?.tap(((e.clientX - box.left) / box.width) * 2 - 1, ((e.clientY - box.top) / box.height) * 2 - 1, boosted);
  const fb = $('#coinFallback');
  if (fb) { fb.classList.add('press'); setTimeout(() => fb.classList.remove('press'), 80); }

  const pop = document.createElement('div');
  pop.className = 'pop num' + (boosted ? ' boost' : '');
  pop.textContent = '+' + fmt(S.tap_value);
  pop.style.left = e.clientX + 'px'; pop.style.top = e.clientY + 'px';
  document.body.appendChild(pop); setTimeout(() => pop.remove(), 850);
  for (let i = 0; i < 5; i++) {
    const sp = document.createElement('i');
    const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 50;
    sp.className = 'spark';
    sp.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d}px;${boosted ? 'background:var(--ember)' : ''}`;
    document.body.appendChild(sp); setTimeout(() => sp.remove(), 600);
  }
  const glow = $('#glow'); glow.style.opacity = 1; clearTimeout(glow._h); glow._h = setTimeout(() => glow.style.opacity = '', 250);
  boosted ? haptic.hard() : haptic.tap();
  renderTop();
}
$('#coinWrap').addEventListener('pointerdown', onTap);

// ── шторки ──
function openSheet(html, onClick) {
  $('#sheetBody').innerHTML = '<div class="grab"></div>' + html;
  $('#sheet').classList.add('on');
  $('#sheetBody').onclick = onClick || null;
  tg?.BackButton?.show();
}
function closeSheet() { $('#sheet').classList.remove('on'); if (currentPage === 'tap') tg?.BackButton?.hide(); }
$('#sheet .shade').onclick = closeSheet;

async function showTop() {
  openSheet('<h2>Рейтинг</h2><p class="lead">Лучшие добытчики по сумме заработанного</p><div id="topList" class="empty">Загружаем…</div>');
  try {
    await flush();
    const { top, me } = await api('/top');
    const colors = Object.fromEntries(S.skins.map(s => [s.key, s.color]));
    $('#topList').className = '';
    $('#topList').innerHTML = top.map((r, i) => `
      <div class="toprow${r.me ? ' me' : ''}"><span class="pl${i < 3 ? ' m' + (i + 1) : ''}">${i + 1}</span>
        <span class="dsc" style="--c:${colors[r.skin] || '#f2c14e'}"></span><span class="nm">${esc(r.name)}</span><span class="sc">${fmt(r.total)}</span></div>`).join('')
      + (top.some(r => r.me) ? '' : `<div class="toprow me" style="margin-top:8px"><span class="pl">${me.place}</span><span class="nm">Ты</span><span class="sc">${fmt(me.total)}</span></div>`);
  } catch (e) { $('#topList').textContent = e.message; }
}
$('#rankBtn').onclick = showTop;

function showSettings() {
  openSheet(`<h2>Настройки</h2>
    <div class="toggle"><div><b>Напоминания в боте</b><small>Скажем, когда энергия восстановится и накопится доход</small></div>
      <button class="sw${S.notify ? ' on' : ''}" id="swNotify" aria-label="Напоминания"></button></div>
    <div class="toggle"><div><b>Помощь с покупками</b><small>Напиши боту /paysupport</small></div></div>
    <p class="lead" style="margin-top:16px;font-size:12.5px">Монеты — игровая валюта. Их нельзя вывести или обменять на деньги.</p>`,
  async e => {
    if (e.target.closest('#swNotify')) {
      const r = await act('/settings', { notify: !S.notify });
      if (r) $('#swNotify').classList.toggle('on', r.notify);
    }
  });
}
$('#settingsBtn').onclick = showSettings;

// ── навигация ──
let currentPage = 'tap';
function go(p) {
  currentPage = p;
  document.querySelectorAll('nav.dock button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  document.querySelectorAll('.page').forEach(s => s.classList.toggle('on', s.id === 'p-' + p));
  document.body.classList.toggle('page-off', p !== 'tap');
  if (p === 'friends') loadFriends();
  if (p === 'tap') tg?.BackButton?.hide(); else tg?.BackButton?.show();
  try { tg.HapticFeedback.selectionChanged(); } catch {}
}
document.querySelectorAll('nav.dock button').forEach(b => b.onclick = () => go(b.dataset.p));
tg?.BackButton?.onClick(() => { if ($('#sheet').classList.contains('on')) closeSheet(); else go('tap'); });

document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
  $('#cards').hidden = b.dataset.seg !== 'cards';
  $('#boosts').hidden = b.dataset.seg !== 'boosts';
});

// ── действия ──
document.addEventListener('click', async e => {
  const up = e.target.closest('[data-up]');
  if (up) {
    up.disabled = true;
    await act('/upgrade', { key: up.dataset.up }, 'Улучшено!');
    return;
  }
  const buy = e.target.closest('[data-buy]');
  if (buy) return purchase(buy.dataset.buy);

  const sk = e.target.closest('[data-skin]');
  if (sk) {
    if (sk.dataset.owned === '1') { if (S.skin !== sk.dataset.skin) await act('/skin', { key: sk.dataset.skin }); return; }
    const s = S.skins.find(x => x.key === sk.dataset.skin);
    if (s.stars) return purchase('skin_' + s.key);
    return toast(`Скин откроется на ранге «${s.rank}»`);
  }

  const st = e.target.closest('[data-start]');
  if (st) {
    const t = S.tasks.find(x => x.id == st.dataset.start);
    openLink(t.url);
    await act('/task/start', { id: t.id });
    return;
  }
  const cl = e.target.closest('[data-claim]');
  if (cl) {
    cl.disabled = true;
    const r = await act('/task/claim', { id: Number(cl.dataset.claim) }, r => `+${full(r.reward)} монет!`);
    if (!r) cl.disabled = false;
  }
});

$('#dailyBtn').onclick = () => act('/daily', {}, r => `+${full(r.reward)} монет! Возвращайся завтра`);

function openLink(url) {
  if (!url) return;
  if (/^https:\/\/t\.me\//.test(url) && tg?.openTelegramLink) tg.openTelegramLink(url);
  else if (tg?.openLink) tg.openLink(url);
  else window.open(url, '_blank');
}

async function purchase(product) {
  if (!inTelegram) return toast('Оплата звёздами работает только внутри Telegram');
  let link;
  try { await flush(); link = (await api('/buy', { product })).link; }
  catch (e) { haptic.err(); return toast(e.message); }
  tg.openInvoice(link, async status => {
    if (status === 'paid') {
      haptic.ok(); toast('Оплачено! Начисляем…');
      // бот получает подтверждение оплаты через пару секунд — подождём
      for (let i = 0; i < 6; i++) { await sleep(1200); try { apply(await api('/state')); } catch {} }
    } else if (status === 'failed') { haptic.err(); toast('Оплата не прошла. Попробуй ещё раз'); }
  });
}

// ── друзья ──
async function loadFriends() {
  try {
    const { friends } = await api('/friends');
    $('#friends').innerHTML = friends.length ? friends.map(f => `
      <div class="li"><div class="ic">${f.premium ? '⭐' : '👤'}</div>
        <div class="tx"><b>${esc(f.name)}</b><small>Добыл ${fmt(f.total)}</small></div></div>`).join('')
      : '<div class="empty">Пока никого. Отправь ссылку другу — бонус придёт, как только он зайдёт в игру.</div>';
  } catch (e) { toast(e.message); }
}
$('#inviteBtn').onclick = () => {
  if (!S.invite_link) return toast('Ссылка появится, когда бот будет запущен');
  const text = 'Добываю золото в шахте — присоединяйся, дам стартовый бонус ⛏️';
  openLink(`https://t.me/share/url?url=${encodeURIComponent(S.invite_link)}&text=${encodeURIComponent(text)}`);
};
$('#copyBtn').onclick = async () => {
  if (!S.invite_link) return toast('Ссылка появится, когда бот будет запущен');
  try { await navigator.clipboard.writeText(S.invite_link); haptic.ok(); toast('Ссылка скопирована'); }
  catch { toast(S.invite_link); }
};

// ── тики ──
setInterval(() => {
  if (!S) return;
  S.energy = Math.min(S.max_energy, S.energy + S.regen / 10);
  const inc = S.passive_per_hour / 36000;
  S.balance += inc; S.total_earned += inc;
  renderTop();
}, 100);
setInterval(sync, 1500);
setInterval(() => S && renderEffects(), 30e3);
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return sync();
  try { await flush(); apply(await api('/state')); } catch {}
});
window.addEventListener('pagehide', sync);

function fatal(msg) {
  $('#loader').style.display = '';
  $('#loader').style.opacity = 1;
  $('#loaderText').textContent = msg;
  $('#loader .mini').style.animation = 'none';
}

// ── старт ──
(async () => {
  initCoin();
  try {
    const r = await api('/state');
    apply(r);
    $('#loader').style.opacity = 0; setTimeout(() => $('#loader').style.display = 'none', 400);
    if (r.is_new) {
      openSheet(`<div class="hero"><div style="font-size:54px">⛏️</div><h2>Добро пожаловать в шахту!</h2></div>
        <p class="lead">Тапай монету — каждый тап приносит золото и тратит энергию. Энергия восстанавливается сама.</p>
        <p class="lead">Покупай карточки в «Прокачке»: они добывают монеты, даже когда тебя нет в игре.</p>
        <p class="lead">Зови друзей и выполняй задания, чтобы расти быстрее и подниматься в рейтинге.</p>
        <button class="wide" id="startBtn">Начать добычу</button>`, e => { if (e.target.closest('#startBtn')) closeSheet(); });
    } else if (r.offline_earned > 0) {
      openSheet(`<div class="hero"><div>Пока тебя не было, шахта добыла</div><div class="big num">+${full(r.offline_earned)}</div>
        <div style="color:var(--soft);font-size:13px">Доход копится до 3 часов — заходи почаще</div></div>
        <button class="wide" id="okBtn">Забрать</button>`, e => { if (e.target.closest('#okBtn')) { closeSheet(); haptic.ok(); } });
    }
  } catch (e) { fatal(e.message); }
})();
