'use strict';
/* Kompte mobile : mêmes données que l'application PC, via Supabase.
   Les calculs (échéances, solde) reprennent exactement ceux de kompte.py. */

const SUPABASE_URL = 'https://scwyqwgoihdftvipfhwy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vF_QP0y9Vyr4_1kvf88DPw_MMtEfaJk'; // clé publique (protégée par RLS)
const POLL_MS = 15000;
const PAGE = 1000;

const TABLES = {
  savings_accounts: ['id', 'id,name,opening_cents'],
  items: ['id', 'id,title,kind,category,total_cents,first_date,installments,frequency,created_at'],
  fixed_groups: ['id', 'id,title,category,kind,day_of_month'],
  fixed_versions: ['id', 'id,group_id,amount_cents,start_month,end_month,day_of_month'],
  fixed_overrides: ['group_id', 'group_id,month,amount_cents'],
  savings_transfers: ['item_id', 'item_id,account_id'],
  fixed_savings_transfers: ['group_id', 'group_id,account_id'],
};

const DEFAULT_COLORS = {
  Revenus: '#4ADE80', Logement: '#6478D8', Factures: '#EAB308', Alimentation: '#F97316',
  Transport: '#A855F7', 'Véhicule': '#94A3B8', Loisirs: '#22D3EE', Shopping: '#EC4899',
  Abonnements: '#818CF8', 'Santé': '#FB7185', Animaux: '#D4A373', Vacances: '#2DD4BF',
  Cadeaux: '#F472B6', 'Épargne': '#10B981', Divers: '#9CA3AF',
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                'septembre', 'octobre', 'novembre', 'décembre'];

const DEFAULT_ACCENT = '#d33445';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const state = {
  data: null,       // tables + kv (réglages partagés)
  version: null,
  tab: 'dashboard',
  selected: todayIso().slice(0, 7),
  query: '',
  loading: false,
  again: false,     // une actualisation a été demandée pendant une autre
  chart: false,     // Accueil : graphique au lieu de la liste
  syncError: false,
  email: '',
};

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

// ------------------------------------------------------------------ outils
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad(n) { return String(n).padStart(2, '0'); }
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function monthShift(iso, offset) {
  const y = +iso.slice(0, 4), mo = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const total = y * 12 + mo - 1 + offset;
  const ny = Math.floor(total / 12), nm = total - ny * 12 + 1;
  return `${String(ny).padStart(4, '0')}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}
function nextMonth(ym) { return monthShift(ym + '-01', 1).slice(0, 7); }
function dueInMonth(ym, day) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  return `${ym}-${pad(Math.min(day, daysInMonth(y, m)))}`;
}
function frDate(iso) { return `${iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`; }
function monthLabel(ym) { const m = MONTHS[+ym.slice(5, 7) - 1]; return m[0].toUpperCase() + m.slice(1) + ' ' + ym.slice(0, 4); }
function euro(c) {
  const a = Math.abs(c);
  const whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${c < 0 ? '-' : ''}${whole},${pad(a % 100)} €`;
}
function amountText(c) { return `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)},${pad(Math.abs(c) % 100)}`; }
function utcStamp() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

/** Identifiant unique côté téléphone (le PC utilise les mêmes). */
let lastId = 0;
function newId() {
  lastId = Math.max(lastId + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
  return lastId;
}

/** Même règle que parse_amount() du PC : 1234,56 · 1 234,56 · 1.234,56 · 12 €. Renvoie des centimes. */
function parseAmount(value) {
  let text = String(value).trim();
  for (const junk of ['€', ' ', ' ', ' ', "'", '’']) text = text.split(junk).join('');
  if (!/^[+-]?[0-9.,]*[0-9][0-9.,]*$/.test(text)) throw new Error('Montant invalide.');
  let sign = '';
  if ('+-'.includes(text[0])) { sign = text[0]; text = text.slice(1); }
  const count = (c) => text.split(c).length - 1;
  let sep;
  if (text.includes(',') && text.includes('.')) {
    sep = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    text = text.split(sep === ',' ? '.' : ',').join('');
  } else if (count(',') > 1) { text = text.split(',').join(''); sep = null; }
  else if (count('.') > 1) { text = text.split('.').join(''); sep = null; }
  else if (/^\d{1,3}\.\d{3}$/.test(text)) { text = text.replace('.', ''); sep = null; } // « 1.500 » = mille cinq cents
  else sep = text.includes(',') ? ',' : text.includes('.') ? '.' : null;
  let whole = text, decimals = '';
  if (sep) {
    const i = text.indexOf(sep);
    whole = text.slice(0, i); decimals = text.slice(i + 1);
    if (decimals.includes(sep) || !/^\d+$/.test(decimals) || (whole && !/^\d+$/.test(whole))) throw new Error('Montant invalide.');
    if (decimals.length > 2) throw new Error('Maximum 2 chiffres après la virgule.');
  }
  whole = whole || '0';
  if (!/^\d+$/.test(whole) || whole.replace(/^0+/, '').length > 8) throw new Error('Montant invalide.');
  const cents = parseInt(whole, 10) * 100 + (decimals ? parseInt(decimals.padEnd(2, '0'), 10) : 0);
  if (cents >= 100000000 * 100) throw new Error('Montant invalide.');
  return sign === '-' ? -cents : cents;
}
function positiveCents(value) {
  let c;
  try { c = parseAmount(value); } catch (e) {
    if (e.message.includes('virgule')) throw e;
    throw new Error('Saisis un montant positif valide.');
  }
  if (c <= 0) throw new Error('Saisis un montant positif valide.');
  return c;
}

function parseInteger(value, label, low, high) {
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || String(value).trim() === '') throw new Error(`${label} : saisis un nombre entier.`);
  if (n < low || n > high) throw new Error(`${label} : entre ${low} et ${high}.`);
  return n;
}
function byName(a, b) { return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }); }

// --------------------------------------------------------------- catégories
function categories() {
  const saved = state.data && state.data.kv.categories;
  const list = [];
  if (saved && Array.isArray(saved.categories)) {
    const hasFlag = saved.categories.some((c) => c && typeof c === 'object' && 'savings' in c);
    for (const c of saved.categories) {
      const name = String(c.name || '').trim();
      if (!name || list.some((x) => x.name === name) || !/^#[0-9a-fA-F]{6}$/.test(String(c.color))) continue;
      list.push({ name, color: c.color, icon: c.icon || 'Divers', savings: hasFlag ? !!c.savings : name === 'Épargne' });
    }
  }
  if (list.length) return list;
  return Object.entries(DEFAULT_COLORS).map(([name, color]) => ({ name, color, icon: name, savings: name === 'Épargne' }));
}
function category(name) {
  return categories().find((c) => c.name === name) || { name, color: '#9CA3AF', icon: 'Divers', savings: false };
}
function iconSlug(icon) { return icon.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function catIcon(name) {
  const c = category(name);
  return `<span class="cat" style="--c:${c.color};--i:url('icons/cat/${iconSlug(c.icon)}.png')"></span>`;
}
function isSavings(cat, kind) { return kind === 'Dépense' && category(cat).savings; }

// ----------------------------------------------------- calculs (= kompte.py)
function fixedEvents(start, end) {
  const D = state.data;
  const overrides = new Map(D.fixed_overrides.map((o) => [`${o.group_id}|${o.month}`, o.amount_cents]));
  const groups = new Map(D.fixed_groups.map((g) => [g.id, g]));
  const out = [];
  for (const v of D.fixed_versions) {
    const g = groups.get(v.group_id);
    if (!g) continue;
    let ym = start.slice(0, 7) > v.start_month ? start.slice(0, 7) : v.start_month;
    let last = nextMonth(end.slice(0, 7));
    if (v.end_month && v.end_month < last) last = v.end_month;
    while (ym < last) {
      const due = dueInMonth(ym, v.day_of_month);
      if (start <= due && due < end) {
        const override = overrides.has(`${g.id}|${ym}`) ? overrides.get(`${g.id}|${ym}`) : null;
        const value = override === null ? v.amount_cents : override;
        if (value > 0) {
          out.push({ row: { id: -g.id, title: g.title, category: g.category, kind: g.kind, frequency: 'Mensuelle',
                            installments: 1, base_amount: v.amount_cents, override }, due, amount: value });
        }
      }
      ym = nextMonth(ym);
    }
  }
  return out;
}

function occurrences(start, end) {
  const results = [];
  for (const row of state.data.items) {
    const base = row.first_date;
    if (!(base < end)) continue;
    if (row.frequency !== 'Unique') {
      const interval = { Mensuelle: 1, Trimestrielle: 3, Annuelle: 12 }[row.frequency];
      const months = (+start.slice(0, 4) - +base.slice(0, 4)) * 12 + (+start.slice(5, 7) - +base.slice(5, 7));
      let n = Math.max(0, Math.floor(months / interval) - 1);
      for (;;) {
        const due = monthShift(base, n * interval);
        if (due >= end) break;
        if (due >= start && due >= base) results.push({ row, due, amount: row.total_cents });
        n += 1;
      }
    } else {
      const count = row.installments;
      const q = Math.floor(row.total_cents / count), rem = row.total_cents % count;
      for (let n = 0; n < count; n++) {
        const due = monthShift(base, n);
        if (due >= end) break;
        if (start <= due) results.push({ row, due, amount: q + (n < rem ? 1 : 0) });
      }
    }
  }
  results.push(...fixedEvents(start, end));
  return results.sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : b.row.id - a.row.id));
}

function summary(ym) {
  const events = occurrences(`${ym}-01`, nextMonth(ym) + '-01');
  const today = todayIso();
  let income = 0, out = 0, paid = 0;
  for (const e of events) {
    if (e.row.kind === 'Revenu') income += e.amount;
    else { out += e.amount; if (e.due <= today) paid += e.amount; }
  }
  return { income, out, paid, events };
}

const signed = (e) => (e.row.kind === 'Revenu' ? e.amount : -e.amount);

function fixedHistory(groupId) {
  return state.data.fixed_versions.filter((v) => v.group_id === groupId)
    .sort((a, b) => (a.start_month < b.start_month ? -1 : a.start_month > b.start_month ? 1 : 0));
}
function fixedVersionAt(groupId, ym) {
  const rows = fixedHistory(groupId).filter((v) => v.start_month <= ym && (!v.end_month || v.end_month > ym));
  return rows.length ? rows[rows.length - 1] : null;
}
function fixedOverrides(groupId) {
  return state.data.fixed_overrides.filter((o) => o.group_id === groupId)
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}
function fixedOverride(groupId, ym) {
  const row = state.data.fixed_overrides.find((o) => o.group_id === groupId && o.month === ym);
  return row ? row.amount_cents : null;
}
/** Mois de fin si le montant fixe a été arrêté, sinon null. */
function fixedStoppedSince(groupId) {
  const rows = fixedHistory(groupId);
  if (!rows.length || !rows.every((r) => r.end_month)) return null;
  return rows.map((r) => r.end_month).sort().pop();
}
function fixedAccountFor(groupId) {
  const row = state.data.fixed_savings_transfers.find((t) => t.group_id === groupId);
  return row ? row.account_id : null;
}

function accountBalance(accountId) {
  const D = state.data;
  const account = D.savings_accounts.find((a) => a.id === accountId);
  if (!account) return 0;
  const through = todayIso();
  let amount = 0;
  for (const t of D.savings_transfers) {
    if (t.account_id !== accountId) continue;
    const item = D.items.find((i) => i.id === t.item_id);
    if (item && item.first_date <= through) amount += item.kind === 'Dépense' ? item.total_cents : -item.total_cents;
  }
  const groups = new Set(D.fixed_savings_transfers.filter((t) => t.account_id === accountId).map((t) => t.group_id));
  if (groups.size) {
    for (const e of fixedEvents('0000-01-01', addDays(through, 1))) {
      if (groups.has(-e.row.id)) amount += e.row.kind === 'Dépense' ? e.amount : -e.amount;
    }
  }
  return account.opening_cents + amount;
}

function installmentSchedule(row) {
  const n = row.installments;
  const q = Math.floor(row.total_cents / n), rem = row.total_cents % n;
  return Array.from({ length: n }, (_, i) => ({ due: monthShift(row.first_date, i), amount: q + (i < rem ? 1 : 0) }));
}

/** Projection sur 12 mois à partir du mois choisi (page Prévisions du PC). */
function forecastData(ym) {
  const balance = getBalance();
  const tomorrow = addDays(todayIso(), 1);
  const start = `${ym}-01`, end = monthShift(start, 12);
  const totals = {};
  for (const e of occurrences(start, end)) {
    const month = e.due.slice(0, 7);
    if (!totals[month]) totals[month] = [0, 0];
    totals[month][e.row.kind === 'Revenu' ? 0 : 1] += e.amount;
  }
  const upcoming = balance !== null && end > tomorrow ? occurrences(tomorrow, end) : [];
  const months = [];
  let cumulative = 0, firstNegative = null;
  for (let i = 0; i < 12; i++) {
    const month = monthShift(start, i).slice(0, 7);
    const [income, out] = totals[month] || [0, 0];
    cumulative += income - out;
    const monthEnd = nextMonth(month) + '-01';
    let projected = null;
    if (balance !== null && monthEnd > tomorrow) {
      projected = balance + upcoming.filter((e) => e.due < monthEnd).reduce((sum, e) => sum + signed(e), 0);
      if (projected < 0 && firstNegative === null) firstNegative = month;
    }
    months.push({ month, income, out, cumulative, projected });
  }
  return { hasBalance: balance !== null, months, firstNegative };
}

/** Même fichier que l'export CSV du PC (séparateur « ; », lisible par Excel). */
function exportCsvText() {
  const D = state.data;
  const year = +todayIso().slice(0, 4);
  const starts = [...D.items.map((i) => i.first_date), ...D.fixed_versions.map((v) => v.start_month + '-01')].sort();
  const start = starts.length ? starts[0] : `${year}-01-01`;
  const events = occurrences(start, `${year + 2}-01-01`).sort((a, b) =>
    (a.due < b.due ? -1 : a.due > b.due ? 1 : a.row.title < b.row.title ? -1 : a.row.title > b.row.title ? 1 : 0));
  const cell = (v) => (/[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [['Date', 'Description', 'Type', 'Catégorie', 'Montant (€)', 'Origine']];
  for (const e of events) {
    const r = e.row;
    let origin = r.id < 0 ? 'Montant fixe' : r.installments > 1 ? 'Paiement en plusieurs fois' : 'Transaction';
    if (r.id < 0 && r.override !== null && r.override !== undefined) origin += ' (modifié ce mois)';
    lines.push([e.due, r.title, r.kind, r.category, amountText(signed(e)), origin]);
  }
  return { count: events.length, year, text: '\ufeff' + lines.map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n' };
}

function balanceReference() {
  const b = state.data && state.data.kv.balance;
  if (!b || typeof b !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(b.as_of || '') || !Number.isInteger(+b.balance_cents)) return null;
  return b;
}

function getBalance() {
  const data = balanceReference();
  if (!data) return null;
  const anchor = data.as_of, today = todayIso();
  if (anchor > today) return +data.balance_cents;
  const current = new Map();
  for (const e of occurrences(anchor, addDays(today, 1))) current.set(`${e.row.id}|${e.due}`, signed(e));
  let delta = 0;
  const baseline = data.baseline_events;
  if (baseline && typeof baseline === 'object' && !Array.isArray(baseline)) {
    for (const v of current.values()) delta += v;
    for (const [key, value] of Object.entries(baseline)) {
      const d = key.split('|').pop();
      if (anchor <= d && d <= today) delta -= parseInt(value, 10);
    }
  } else {
    for (const [key, value] of current) if (key.split('|').pop() > anchor) delta += value;
  }
  return +data.balance_cents + delta;
}

// ------------------------------------------------------------ données
async function check(promise) {
  const { data, error } = await promise;
  if (error) {
    const failure = new Error(error.message || 'Erreur réseau');
    failure.code = error.code;
    throw failure;
  }
  return data;
}

// ------------------------------------------------- écritures (= Store de kompte.py)
/** Le montant et le jour ne changent qu'à partir de startMonth, et seulement s'ils diffèrent. */
async function saveFixed({ title, category, kind, amount, startMonth, day, groupId = null, accountId = null }) {
  await loadAll(); // décide à partir des données les plus récentes
  const version = (group) => ({ id: newId(), group_id: group, amount_cents: amount, start_month: startMonth,
                                end_month: null, day_of_month: day });
  if (groupId === null) {
    groupId = newId();
    await check(sb.from('fixed_groups').insert({ id: groupId, title, category, kind, day_of_month: day }));
    await check(sb.from('fixed_versions').insert(version(groupId)));
  } else {
    await check(sb.from('fixed_groups').update({ title, category, kind, day_of_month: day }).eq('id', groupId));
    const current = fixedVersionAt(groupId, startMonth);
    const stopped = fixedStoppedSince(groupId);
    const unchanged = current !== null && current.amount_cents === amount && current.day_of_month === day
      && (stopped === null || stopped > startMonth);
    if (!unchanged) {
      await check(sb.from('fixed_versions').delete().eq('group_id', groupId).gte('start_month', startMonth));
      await check(sb.from('fixed_versions').update({ end_month: startMonth }).eq('group_id', groupId)
        .lt('start_month', startMonth).or(`end_month.is.null,end_month.gt.${startMonth}`));
      await check(sb.from('fixed_versions').insert(version(groupId)));
    }
  }
  await check(sb.from('fixed_savings_transfers').delete().eq('group_id', groupId));
  if (accountId !== null) await check(sb.from('fixed_savings_transfers').insert({ group_id: groupId, account_id: accountId }));
  return groupId;
}

/** Change le montant d'un seul mois (0 = pas de paiement ce mois-là). */
function setFixedMonth(groupId, ym, cents) {
  return check(sb.from('fixed_overrides').upsert({ group_id: groupId, month: ym, amount_cents: cents },
                                                 { onConflict: 'group_id,month' }));
}
function clearFixedMonth(groupId, ym) {
  return check(sb.from('fixed_overrides').delete().eq('group_id', groupId).eq('month', ym));
}

/** Arrête le montant fixe à partir de ym, sans effacer les mois passés. */
async function stopFixed(groupId, ym) {
  await check(sb.from('fixed_versions').delete().eq('group_id', groupId).gte('start_month', ym));
  await check(sb.from('fixed_versions').update({ end_month: ym }).eq('group_id', groupId)
    .or(`end_month.is.null,end_month.gt.${ym}`));
  await check(sb.from('fixed_overrides').delete().eq('group_id', groupId).gte('month', ym));
}

function saveCategories(list) {
  return check(sb.from('kv_settings').upsert({ key: 'categories', value: { categories: list } }, { onConflict: 'user_id,key' }));
}

async function remoteVersion() {
  const rows = await check(sb.from('sync_state').select('version'));
  return rows.length ? rows[0].version : 0;
}

async function fetchTable(table) {
  const [order, cols] = TABLES[table];
  let rows = [];
  for (let from = 0; ; from += PAGE) {
    const batch = await check(sb.from(table).select(cols).order(order).range(from, from + PAGE - 1));
    rows = rows.concat(batch);
    if (batch.length < PAGE) return rows;
  }
}

async function loadAll() {
  const version = await remoteVersion();
  const names = Object.keys(TABLES);
  const [kvRows, ...tables] = await Promise.all([check(sb.from('kv_settings').select('key,value')),
                                                 ...names.map(fetchTable)]);
  const data = { kv: {} };
  names.forEach((name, i) => { data[name] = tables[i]; });
  for (const r of kvRows) data.kv[r.key] = r.value;
  state.data = data;
  state.version = version;
  try { localStorage.setItem('kompte-cache', JSON.stringify({ data, version, email: state.email })); } catch (e) { /* stockage indisponible */ }
}

async function refresh(force = false) {
  if (state.loading) { state.again = state.again || force; return; }
  state.loading = true;
  setSync('Synchronisation…');
  try {
    if (force || state.data === null || (await remoteVersion()) !== state.version) {
      await loadAll();
      render();
    }
    state.syncError = false;
    const now = new Date();
    setSync(`À jour · ${pad(now.getHours())}:${pad(now.getMinutes())}`);
  } catch (e) {
    state.syncError = true;
    setSync('Hors ligne', true);
  } finally {
    state.loading = false;
    if (state.again) { state.again = false; refresh(true); }
  }
}

function setSync(text, error = false) {
  const el = $('#sync');
  el.textContent = text;
  el.classList.toggle('error', error);
}

// ------------------------------------------------------------- affichage
function render() {
  if (!state.data) { view.innerHTML = '<p class="empty">Chargement…</p>'; return; }
  const active = ['installments', 'accounts', 'settings'].includes(state.tab) ? 'more' : state.tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === active));
  $('#fab').hidden = state.tab !== 'dashboard'; // Transactions : lecture seule
  ({ transactions: renderTransactions, fixed: renderFixed, forecast: renderForecast, more: renderMore,
     installments: renderInstallments, accounts: renderAccounts, settings: renderSettings }[state.tab] || renderDashboard)();
}

const backButton = () => '<button type="button" class="back" data-go="more">‹ Plus</button>';
function monthBar() {
  return `<div class="monthbar">
      <button type="button" class="icon-btn" data-month="-1" aria-label="Mois précédent">‹</button>
      <span class="label">${monthLabel(state.selected)}</span>
      <button type="button" class="icon-btn" data-month="1" aria-label="Mois suivant">›</button>
    </div>
    ${state.selected === todayIso().slice(0, 7) ? '' : '<p style="text-align:center;margin:-6px 0 10px"><button type="button" class="chip" id="today">Revenir à aujourd’hui</button></p>'}`;
}

function eventRow(e) {
  const r = e.row;
  let when = frDate(e.due);
  if (r.id < 0) {
    when += ' · fixe';
    if (r.override !== null && r.override !== undefined) when += ' (modifié ce mois)';
  }
  const plus = r.kind === 'Revenu';
  return `<button type="button" class="row" data-item="${r.id}" data-due="${e.due}">
      ${catIcon(r.category)}
      <span class="body"><span class="title">${esc(r.title)}</span>
        <span class="sub">${esc(when)} · ${esc(r.category)}</span></span>
      <span class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${euro(e.amount)}</span>
    </button>`;
}

function renderDashboard() {
  const balance = getBalance();
  const ref = balanceReference();
  const ym = state.selected;
  const { income, out, paid, events } = summary(ym);
  const today = todayIso();
  // Seulement ce qui a déjà eu lieu, les 10 plus récentes (le détail est dans Transactions).
  const done = events.filter((e) => e.due <= today).slice(0, 10);
  const metric = (label, value, color, id = '') =>
    `<${id ? `button type="button" id="${id}"` : 'div'} class="metric"><small>${label}</small><b style="color:${color}">${euro(value)}</b></${id ? 'button' : 'div'}>`;
  view.innerHTML = `
    <button type="button" class="hero" id="balance">
      <small>SOLDE ACTUEL</small>
      <strong>${balance === null ? '— €' : euro(balance)}</strong>
      <span>${ref ? `Depuis le ${frDate(ref.as_of)} · touche pour modifier` : 'Touche ici pour saisir ton solde bancaire actuel'}</span>
    </button>
    ${monthBar()}
    <div class="metrics">
      ${metric('Revenus prévus', income, 'var(--green)')}
      ${metric('Dépenses prévues ›', out - paid, 'var(--red)', 'upcoming')}
      ${metric('Déjà dépensé', paid, 'var(--text)')}
      ${metric('Reste prévisionnel', income - out, 'var(--orange)')}
    </div>
    <div class="section-bar">
      <h2>${state.chart ? 'Échéances du mois' : 'Dernières opérations'}</h2>
      <button type="button" class="secondary small" id="chart-toggle">${state.chart ? 'Liste' : 'Graphique'}</button>
    </div>
    ${state.chart ? expenseChart(events, ym) : `
    <div class="list">${done.map(eventRow).join('') || '<p class="empty">Aucune opération passée ce mois-ci.</p>'}</div>
    ${done.length ? '<p class="note">Toutes les opérations du mois : onglet Transactions.</p>' : ''}`}`;
}

/** Dépenses par jour, sur la même échelle que le graphique du PC. Toucher une icône pour modifier. */
function expenseChart(events, ym) {
  const W = 343, H = 320, left = 50, right = 12, top = 14, bottom = 28;
  const days = daysInMonth(+ym.slice(0, 4), +ym.slice(5, 7));
  const expenses = events.filter((e) => e.row.kind === 'Dépense').map((e) => ({ ...e, day: +e.due.slice(8, 10) }))
    .sort((a, b) => a.day - b.day || b.amount - a.amount || (a.row.title < b.row.title ? -1 : 1));
  const biggest = Math.max(0, ...expenses.map((e) => e.amount)) / 100;
  let topEuros = 1000;
  while (topEuros < biggest) topEuros *= '15'.includes(String(topEuros)[0]) ? 2 : 2.5;
  topEuros = Math.trunc(topEuros);
  const plotW = W - left - right, plotH = H - top - bottom;
  const decades = Math.log10(topEuros / 10);
  const x = (day) => left + ((day - 1) / Math.max(1, days - 1)) * plotW;
  const y = (cents) => {
    const euros = Math.max(0, Math.min(cents, topEuros * 100) / 100);
    const baseline = top + plotH, lowBand = plotH * 0.08; // 0–10 € : segment court, puis logarithmique
    if (euros <= 10) return baseline - (euros / 10) * lowBand;
    return baseline - lowBand - (plotH - lowBand) * (Math.log10(euros / 10) / decades);
  };
  const ticks = [0, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000].filter((t) => t <= topEuros);
  if (!ticks.includes(topEuros)) ticks.push(topEuros);
  const grid = ticks.map((t) => `<line x1="${left}" x2="${W - right}" y1="${y(t * 100)}" y2="${y(t * 100)}" class="grid"/>
      <text x="${left - 6}" y="${y(t * 100) + 3.5}" text-anchor="end">${t >= 1000 ? `${t / 1000} k€` : `${t} €`}</text>`).join('');
  const dayLabels = [1, 5, 10, 15, 20, 25, days].map((d) => `<text x="${x(d)}" y="${H - 9}" text-anchor="middle">${d}</text>`).join('');
  const occupied = {};
  const dots = expenses.map((e) => {
    let xx = x(e.day), yy = y(e.amount);
    const bucket = `${e.day}|${Math.round(yy / 22)}`;
    const offset = occupied[bucket] || 0;
    occupied[bucket] = offset + 1;
    if (offset) { // dépenses proches le même jour : léger décalage pour rester touchables
      const step = Math.floor((offset + 1) / 2);
      xx = Math.min(W - right - 11, Math.max(left + 11, xx + step * (offset % 2 ? 9 : -9)));
      yy = Math.min(H - bottom - 11, Math.max(top + 11, yy + step * (offset % 2 ? 7 : -7)));
    }
    return `<button type="button" class="dot" data-item="${e.row.id}" data-due="${e.due}"
      aria-label="${esc(`${e.row.title}, ${euro(e.amount)}, le ${frDate(e.due)}`)}"
      style="left:${(xx / W) * 100}%;top:${(yy / H) * 100}%">${catIcon(e.row.category)}</button>`;
  }).join('');
  return `<div class="chart-box">
      <p class="note" style="margin:0 0 6px">Dépenses par jour · échelle logarithmique (0 à ${euro(topEuros * 100).replace(',00 €', ' €')}) · touche une icône pour modifier</p>
      <div class="chart"><svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${grid}${dayLabels}
        <line x1="${left}" x2="${left}" y1="${top}" y2="${H - bottom}" class="axis"/>
        <line x1="${left}" x2="${W - right}" y1="${H - bottom}" y2="${H - bottom}" class="axis"/></svg>${dots}</div>
    </div>`;
}

/** Dépenses qui restent à payer dans le mois (touche sur « Dépenses prévues »). */
function upcomingSheet() {
  const today = todayIso();
  const events = summary(state.selected).events.filter((e) => e.row.kind === 'Dépense' && e.due > today).reverse();
  const total = events.reduce((sum, e) => sum + e.amount, 0);
  openSheet(`
    <h3>Dépenses prévues</h3>
    <p class="hint" style="text-align:center;margin-top:0">${monthLabel(state.selected)} · encore ${euro(total)} à payer</p>
    <div class="list" style="margin-top:12px">${events.map(eventRow).join('') || '<p class="empty">Plus aucune dépense prévue ce mois-ci.</p>'}</div>
    <p class="error-text"></p>
    <div class="actions"><button type="button" class="primary" data-close>Fermer</button></div>`, async () => {});
}

/** Toutes les opérations du mois choisi (année puis mois, chacun avec ses flèches). Lecture seule. */
function renderTransactions() {
  const ym = state.selected;
  const { income, out, events } = summary(ym);
  const needle = state.query.toLowerCase();
  const shown = events.filter((e) => !needle || e.row.title.toLowerCase().includes(needle)
    || e.row.category.toLowerCase().includes(needle) || amountText(e.amount).includes(needle.replace('.', ',')));
  const rows = shown.map((e) => {
    const r = e.row;
    const plus = r.kind === 'Revenu';
    let details = `${r.category} · ${frDate(e.due)}`;
    if (r.id < 0) details += ' · fixe';
    else if (r.installments > 1) {
      const index = (+e.due.slice(0, 4) - +r.first_date.slice(0, 4)) * 12 + (+e.due.slice(5, 7) - +r.first_date.slice(5, 7));
      details += ` · ${index + 1}/${r.installments}`;
    } else if (r.frequency !== 'Unique') details += ` · ${r.frequency.toLowerCase()}`;
    return `<button type="button" class="row" data-item="${r.id}" data-due="${e.due}">
        ${catIcon(r.category)}
        <span class="body"><span class="title">${esc(r.title)}</span><span class="sub">${esc(details)}</span></span>
        <span class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${euro(e.amount)}</span>
      </button>`;
  }).join('');
  const month = MONTHS[+ym.slice(5, 7) - 1];
  view.innerHTML = `
    <div class="monthbar year">
      <button type="button" class="icon-btn" data-month="-12" aria-label="Année précédente">‹</button>
      <span class="label">${ym.slice(0, 4)}</span>
      <button type="button" class="icon-btn" data-month="12" aria-label="Année suivante">›</button>
    </div>
    <div class="monthbar">
      <button type="button" class="icon-btn" data-month="-1" aria-label="Mois précédent">‹</button>
      <span class="label">${month[0].toUpperCase() + month.slice(1)}</span>
      <button type="button" class="icon-btn" data-month="1" aria-label="Mois suivant">›</button>
    </div>
    <div class="totals"><span class="plus">+${euro(income)}</span><span class="minus">−${euro(out)}</span>
      <span>= ${euro(income - out)}</span></div>
    <input class="search" id="search" type="search" placeholder="Rechercher dans le mois…" value="${esc(state.query)}">
    <div class="list">${rows || `<p class="empty">${state.query ? 'Aucune opération trouvée.' : 'Aucune opération ce mois-ci.'}</p>`}</div>`;
}

function renderFixed() {
  const ym = state.selected;
  const shortMonth = (m) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
  const groups = [...state.data.fixed_groups].sort((a, b) => b.id - a.id);
  const cards = groups.map((g) => {
    const sign = g.kind === 'Revenu' ? '+' : '−';
    const version = fixedVersionAt(g.id, ym);
    const override = fixedOverride(g.id, ym);
    const stopped = fixedStoppedSince(g.id);
    let now, color = 'var(--text)', usual = '';
    if (version === null) { now = stopped && stopped <= ym ? 'Arrêté' : 'Pas encore actif'; color = 'var(--muted)'; }
    else if (override !== null) {
      now = override === 0 ? 'Pas de paiement' : `${sign}${euro(override)}`;
      color = 'var(--orange)';
      usual = ` · habituel ${euro(version.amount_cents)}`;
    } else now = `${sign}${euro(version.amount_cents)}`;
    const parts = fixedHistory(g.id).map((v) => `${sign}${euro(v.amount_cents)} le ${v.day_of_month} · ${v.end_month
      ? `${shortMonth(v.start_month)} → ${shortMonth(v.end_month)} exclu` : `depuis ${shortMonth(v.start_month)}`}`);
    if (stopped) parts.push(`arrêté à partir de ${shortMonth(stopped)}`);
    const exceptions = fixedOverrides(g.id);
    if (exceptions.length) {
      const listed = exceptions.slice(-4).map((o) => `${MONTHS[+o.month.slice(5, 7) - 1].slice(0, 4)}. ${o.month.slice(0, 4)} : ${
        o.amount_cents === 0 ? 'aucun' : euro(o.amount_cents)}`).join(', ');
      parts.push(`mois modifiés : ${listed}${exceptions.length > 4 ? ` (+${exceptions.length - 4})` : ''}`);
    }
    return `<button type="button" class="row top" data-fixed="${g.id}">
        ${catIcon(g.category)}
        <span class="body"><span class="title" style="color:var(--${g.kind === 'Revenu' ? 'green' : 'red'})">${esc(g.title)}</span>
          <span class="sub">${esc(g.category)}${esc(usual)}</span>
          <span class="history">${parts.map(esc).join('<br>')}</span></span>
        <span class="amount" style="color:${color}">${now}</span>
      </button>`;
  }).join('');
  view.innerHTML = `
    <h2>Montants fixes mensuels</h2>
    ${monthBar()}
    <button type="button" class="primary wide" id="add-fixed">+ Ajouter un montant fixe</button>
    <div class="list">${cards || '<p class="empty">Aucun montant fixe enregistré.</p>'}</div>`;
}

function renderForecast() {
  const { hasBalance, months, firstNegative } = forecastData(state.selected);
  const cards = months.map((m) => {
    const value = hasBalance ? m.projected : m.cumulative;
    const color = value === null ? 'var(--muted)' : value < 0 ? 'var(--red)' : 'var(--text)';
    const rest = m.income - m.out;
    return `<div class="forecast">
        <div class="line"><b>${monthLabel(m.month)}</b><b style="color:${color}">${value === null ? '—' : euro(value)}</b></div>
        <div class="line small"><span class="plus">+${euro(m.income)}</span><span class="minus">−${euro(m.out)}</span>
          <span style="color:${rest < 0 ? 'var(--red)' : 'var(--muted)'}">= ${euro(rest)}</span></div>
      </div>`;
  }).join('');
  view.innerHTML = `
    <h2>Prévisions sur 12 mois</h2>
    ${monthBar()}
    ${firstNegative ? `<p class="alert">⚠ Ton solde passerait sous zéro en ${monthLabel(firstNegative).toLowerCase()}.</p>` : ''}
    <p class="note" style="margin:0 0 6px;text-align:right">${hasBalance ? 'Solde prévu fin de mois' : 'Cumul prévisionnel'}</p>
    <div class="list">${cards}</div>
    <p class="note">${hasBalance
    ? 'Le solde prévu part de ton solde actuel et ajoute les opérations enregistrées à venir. Les mois déjà terminés affichent « — ».'
    : 'Le cumul commence à 0 au début de la période. Renseigne ton solde actuel sur l’accueil pour voir ton solde prévu à la fin de chaque mois.'}
      Les dépenses variables non enregistrées ne sont pas estimées.</p>`;
}

function renderMore() {
  const entry = (go, title, sub) => `<button type="button" class="row" data-go="${go}">
      <span class="body"><span class="title">${title}</span><span class="sub">${sub}</span></span>
      <span class="chevron">›</span></button>`;
  view.innerHTML = `
    <h2>Plus</h2>
    <div class="list">
      ${entry('installments', 'Paiements en plusieurs fois', 'Achats et échéances')}
      ${entry('accounts', 'Comptes épargne', 'Soldes et virements')}
      ${entry('settings', 'Paramètres', 'Couleur, catégories, export')}
    </div>
    <h2>Compte</h2>
    <p class="note" style="margin-top:0">Connecté avec ${esc(state.email)}.<br>
      Les modifications faites ici apparaissent sur le PC en quelques secondes, et inversement.</p>
    <div class="actions">
      <button type="button" class="secondary" id="password-change">Changer le mot de passe</button>
      <button type="button" class="secondary" id="logout">Se déconnecter</button>
    </div>`;
}

function renderInstallments() {
  const today = todayIso();
  const rows = state.data.items.filter((r) => r.installments > 1)
    .sort((a, b) => (a.first_date < b.first_date ? 1 : a.first_date > b.first_date ? -1 : b.id - a.id));
  view.innerHTML = `
    ${backButton()}
    <h2>Paiements en plusieurs fois</h2>
    <button type="button" class="primary wide" id="add-installment">+ Paiement en plusieurs fois</button>
    <div class="list">${rows.map((r) => {
    const remaining = installmentSchedule(r).filter((p) => p.due > today).reduce((sum, p) => sum + p.amount, 0);
    return `<button type="button" class="row" data-installment="${r.id}">
        ${catIcon(r.category)}
        <span class="body"><span class="title">${esc(r.title)} · ${r.installments}x</span>
          <span class="sub">Total : ${euro(r.total_cents)}</span></span>
        <span class="amount" style="color:var(--orange)">Reste : ${euro(remaining)}</span>
      </button>`;
  }).join('') || '<p class="empty">Aucun paiement fractionné enregistré.</p>'}</div>`;
}

function renderAccounts() {
  const accounts = [...state.data.savings_accounts].sort(byName);
  view.innerHTML = `
    ${backButton()}
    <h2>Comptes épargne</h2>
    <button type="button" class="primary wide" id="add-account">+ Ajouter un compte</button>
    <div class="list">${accounts.map((a) => `<button type="button" class="row" data-account="${a.id}">
        <span class="body"><span class="title">${esc(a.name)}</span></span>
        <span class="amount plus">${euro(accountBalance(a.id))}</span>
      </button>`).join('') || '<p class="empty">Aucun compte épargne. Ajoute un compte pour y affecter tes virements.</p>'}</div>
    <p class="note">Les virements futurs sont inclus dans les prévisions, mais crédités sur le compte épargne seulement à leur date.</p>`;
}

function renderSettings() {
  view.innerHTML = `
    ${backButton()}
    <h2>Couleur principale</h2>
    <div class="color-row">
      <input class="color" id="accent" type="color" value="${accentColor()}" aria-label="Couleur principale">
      <button type="button" class="secondary" id="accent-reset">Couleur d’origine</button>
    </div>
    <p class="note">Sur ce téléphone uniquement : le PC garde sa propre couleur.</p>
    <div class="section-bar">
      <h2>Catégories</h2>
      <button type="button" class="primary small" id="add-category">+ Ajouter</button>
    </div>
    <div class="list">${categories().map((c) => `<button type="button" class="row" data-category="${esc(c.name)}">
        ${catIcon(c.name)}
        <span class="body"><span class="title" style="color:${c.color}">${esc(c.name)}</span>
          ${c.savings ? '<span class="sub">Reliée aux comptes épargne</span>' : ''}</span>
        <span class="chevron">›</span>
      </button>`).join('')}</div>
    <h2>Export</h2>
    <p class="note" style="margin-top:0">Toutes les échéances dans un fichier CSV lisible par Excel.
      Les sauvegardes automatiques de la base se font sur le PC.</p>
    <div class="actions"><button type="button" class="secondary" id="export-csv">Exporter en CSV</button></div>`;
}

function renderLogin(message = '') {
  $('#tabs').hidden = true;
  $('#fab').hidden = true;
  setSync('');
  view.innerHTML = `
    <form class="login" id="login" novalidate>
      <h1>Connexion</h1>
      <p>Utilise le même compte que dans Kompte sur le PC (Paramètres › Synchronisation).</p>
      <label class="field" for="email">E-mail</label>
      <input class="input" id="email" type="email" autocomplete="username" required>
      <label class="field" for="password">Mot de passe</label>
      <input class="input" id="password" type="password" autocomplete="current-password" required>
      <p class="error-text" id="login-error">${esc(message)}</p>
      <div class="actions"><button class="primary" type="submit">Se connecter</button></div>
    </form>`;
}

// --------------------------------------------------------- fenêtres de saisie
function openSheet(html, onSubmit) {
  const form = $('#sheet-form');
  form.innerHTML = html;
  $('#sheet').hidden = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const error = form.querySelector('.error-text');
    const submit = form.querySelector('.primary');
    error.textContent = '';
    submit.disabled = true;
    try {
      await onSubmit(form);
      closeSheet();
      await refresh(true);
    } catch (e) {
      error.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  };
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-form').innerHTML = ''; }

/** Action d'un bouton de la fenêtre (hors « Enregistrer ») : même déroulé que openSheet. */
async function sheetAction(action) {
  const form = $('#sheet-form');
  try {
    await action();
    closeSheet();
    await refresh(true);
  } catch (e) {
    form.querySelector('.error-text').textContent = e.message;
  }
}

function kindButtons(kind, locked = false) {
  return `<div class="segmented" id="f-kind">
      <button type="button" data-kind="Dépense" class="${kind === 'Dépense' ? 'on' : ''}" ${locked ? 'disabled' : ''}>Dépense</button>
      <button type="button" data-kind="Revenu" class="${kind === 'Revenu' ? 'on' : ''}" ${locked ? 'disabled' : ''}>Revenu</button>
    </div>`;
}
function accountPicker(selectedId) {
  const accounts = [...state.data.savings_accounts].sort(byName);
  return `<div id="f-account-box" hidden>
      <label class="field" for="f-account">Compte épargne destinataire</label>
      <select class="input" id="f-account">${accounts.map((a) =>
    `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')
    || '<option value="">Aucun compte</option>'}</select>
    </div>`;
}
/** Boutons Type et Catégorie ; le compte épargne n'apparaît que pour un virement. */
function wirePickers(form, showAccount = true) {
  const refreshAccount = () => {
    const k = form.querySelector('#f-kind .on').dataset.kind;
    const c = form.querySelector('#cats .on').dataset.cat;
    form.querySelector('#f-account-box').hidden = !(isSavings(c, k) && showAccount);
  };
  form.querySelector('#f-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b || b.disabled) return;
    form.querySelectorAll('#f-kind button').forEach((x) => x.classList.toggle('on', x === b));
    refreshAccount();
  });
  form.querySelector('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]');
    if (!b) return;
    form.querySelectorAll('#cats button').forEach((x) => x.classList.toggle('on', x === b));
    refreshAccount();
  });
  refreshAccount();
}

function categoryPicker(selected) {
  return `<div class="cats" id="cats">${categories().map((c) =>
    `<button type="button" data-cat="${esc(c.name)}" class="${c.name === selected ? 'on' : ''}" style="--c:${c.color}">
       ${catIcon(c.name)}<span>${esc(c.name)}</span></button>`).join('')}</div>`;
}

function transactionSheet(item, installments = false) {
  const editing = !!item;
  const split = installments || (editing && item.installments > 1);
  const transfer = editing ? state.data.savings_transfers.find((t) => t.item_id === item.id) : null;
  const kind = editing ? item.kind : 'Dépense';
  const cat = editing ? item.category : (categories().find((c) => c.name === 'Alimentation') || categories()[0]).name;
  const heading = editing ? 'Modifier la transaction' : installments ? 'Paiement en plusieurs fois' : 'Nouvelle transaction';
  const html = `
    <h3>${heading}</h3>
    <label class="field" for="f-amount">Montant (€)</label>
    <input class="input big" id="f-amount" inputmode="decimal" autocomplete="off" value="${editing ? amountText(item.total_cents) : ''}">
    <label class="field" for="f-title">Description</label>
    <input class="input" id="f-title" autocomplete="off" value="${editing ? esc(item.title) : ''}">
    <label class="field">Type</label>
    ${kindButtons(kind, split)}
    <label class="field">Catégorie</label>
    ${categoryPicker(cat)}
    ${accountPicker(transfer ? transfer.account_id : null)}
    <label class="field" for="f-date">${split ? 'Date du premier paiement' : 'Date'}</label>
    <input class="input" id="f-date" type="date" value="${editing ? item.first_date : todayIso()}">
    ${split ? `<label class="field" for="f-count">Nombre de mensualités</label>
      <input class="input" id="f-count" inputmode="numeric" value="${editing ? item.installments : 4}">
      <div class="preview" id="f-preview"></div>` : ''}
    ${editing && item.frequency !== 'Unique' ? `<p class="hint">Répétition : ${esc(item.frequency)}</p>` : ''}
    <p class="error-text"></p>
    <div class="actions">
      ${editing ? '<button type="button" class="secondary danger" id="f-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`;

  openSheet(html, async (form) => {
    const title = form.querySelector('#f-title').value.trim();
    const total = positiveCents(form.querySelector('#f-amount').value);
    if (!title) throw new Error(editing ? 'La description est obligatoire.' : 'Saisis une description.');
    const due = form.querySelector('#f-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Date invalide.');
    const kindValue = form.querySelector('#f-kind .on').dataset.kind;
    const catValue = form.querySelector('#cats .on').dataset.cat;
    let n = 1;
    if (split) {
      n = parseInteger(form.querySelector('#f-count').value, 'Nombre de mensualités', 2, 120);
      if (n > total) throw new Error('Montant trop faible pour ce nombre de mensualités.');
    }
    let accountId = null;
    if (isSavings(catValue, kindValue)) {
      if (n > 1) throw new Error('Les virements épargne ne peuvent pas être fractionnés.');
      accountId = Number(form.querySelector('#f-account').value) || null;
      if (accountId === null) throw new Error('Crée un compte dans Plus › Comptes épargne avant de transférer ton épargne.');
    }
    const fields = { title, kind: kindValue, category: catValue, total_cents: total, first_date: due };
    if (editing) {
      await check(sb.from('items').update({ ...fields, installments: n, frequency: item.frequency }).eq('id', item.id));
      await check(sb.from('savings_transfers').delete().eq('item_id', item.id));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: item.id, account_id: accountId }));
      await check(sb.from('confirmations').delete().eq('item_id', item.id));
    } else {
      const id = newId();
      await check(sb.from('items').insert({ id, ...fields, installments: n, frequency: 'Unique', created_at: utcStamp() }));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: id, account_id: accountId }));
    }
  });

  const form = $('#sheet-form');
  wirePickers(form, !split);
  const preview = form.querySelector('#f-preview');
  if (preview) {
    const update = () => {
      let total, n;
      const due = form.querySelector('#f-date').value;
      try {
        total = positiveCents(form.querySelector('#f-amount').value);
        n = parseInteger(form.querySelector('#f-count').value, '', 2, 120);
        if (total < n || !due) throw new Error();
      } catch (e) {
        preview.innerHTML = '<p class="hint" style="margin:0">Saisis un montant et au moins 2 mensualités.</p>';
        return;
      }
      const schedule = installmentSchedule({ total_cents: total, installments: n, first_date: due });
      preview.innerHTML = `<b>Prévision des mensualités</b>
        ${schedule.slice(0, 6).map((p, i) => `<div class="line small"><span>${i + 1}/${n} · ${frDate(p.due)}</span><span class="minus">${euro(p.amount)}</span></div>`).join('')}
        ${n > 6 ? `<p class="hint" style="margin:2px 0 0">… et ${n - 6} échéances supplémentaires</p>` : ''}
        <p class="hint" style="color:var(--orange);margin:4px 0 0">Total : ${euro(total)} · ${n} mensualités</p>`;
    };
    for (const id of ['#f-amount', '#f-count', '#f-date']) form.querySelector(id).addEventListener('input', update);
    update();
  }
  const del = form.querySelector('#f-delete');
  if (del) {
    del.addEventListener('click', () => {
      if (confirm('Supprimer cette transaction et toutes ses échéances ?')) {
        sheetAction(() => check(sb.from('items').delete().eq('id', item.id)));
      }
    });
  }
  if (!editing) setTimeout(() => form.querySelector('#f-amount').focus(), 120);
}

function installmentSheet(item) {
  const today = todayIso();
  const schedule = installmentSchedule(item);
  const remaining = schedule.filter((p) => p.due > today).reduce((sum, p) => sum + p.amount, 0);
  openSheet(`
    <h3>${esc(item.title)}</h3>
    <p class="hint" style="text-align:center;color:var(--orange);margin-top:0">Total : ${euro(item.total_cents)} · Reste : ${euro(remaining)}</p>
    <div class="list" style="margin-top:12px">${schedule.map((p, i) => `<div class="row">
        <span class="body"><span class="sub">${i + 1}/${schedule.length} · ${frDate(p.due)}</span></span>
        <span class="amount" style="color:${p.due > today ? 'var(--orange)' : 'var(--text)'}">${euro(p.amount)}</span>
      </div>`).join('')}</div>
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary danger" id="i-delete">Supprimer</button>
      <button type="button" class="secondary" data-close>Fermer</button>
      <button type="button" class="primary" id="i-edit">Modifier</button>
    </div>`, async () => {});
  const form = $('#sheet-form');
  form.querySelector('#i-edit').addEventListener('click', () => transactionSheet(item));
  form.querySelector('#i-delete').addEventListener('click', () => {
    if (confirm('Supprimer cette transaction et toutes ses échéances ?')) {
      sheetAction(() => check(sb.from('items').delete().eq('id', item.id)));
    }
  });
}

/** Actions d'un montant fixe (toucher sa ligne dans l'onglet Fixes). */
function fixedActionsSheet(group) {
  const ym = state.selected;
  openSheet(`
    <h3>${esc(group.title)}</h3>
    <div class="stack">
      <button type="button" class="primary" id="fa-month">Modifier un mois (${monthLabel(ym).toLowerCase()})</button>
      <button type="button" class="secondary" id="fa-edit">Modifier pour tous les mois</button>
      <button type="button" class="secondary" id="fa-stop">Arrêter à partir d’un mois…</button>
      <button type="button" class="secondary danger" id="fa-delete">Supprimer (efface aussi l’historique)</button>
      <button type="button" class="secondary" data-close>Fermer</button>
    </div>
    <p class="error-text"></p>`, async () => {});
  const form = $('#sheet-form');
  form.querySelector('#fa-month').addEventListener('click', () => fixedMonthSheet(group.id, ym));
  form.querySelector('#fa-edit').addEventListener('click', () => fixedSheet(group));
  form.querySelector('#fa-stop').addEventListener('click', () => stopFixedSheet(group));
  form.querySelector('#fa-delete').addEventListener('click', () => {
    if (confirm('Supprimer ce montant fixe et TOUT son historique ?\n\nLes mois passés disparaîtront aussi (et le solde sera recalculé).\n'
      + 'Pour simplement ne plus le compter, utilise plutôt « Arrêter ».')) {
      sheetAction(() => check(sb.from('fixed_groups').delete().eq('id', group.id)));
    }
  });
}

/** Modifier le montant d'un seul mois : les autres mois ne bougent pas. */
function fixedMonthSheet(groupId, ym) {
  const group = state.data.fixed_groups.find((g) => g.id === groupId);
  if (!group) return;
  const version = fixedVersionAt(groupId, ym);
  const override = fixedOverride(groupId, ym);
  let info = 'Ce montant fixe n’est pas actif ce mois-là.', value = '';
  if (version) {
    const due = frDate(dueInMonth(ym, version.day_of_month));
    const usual = `Montant habituel : ${euro(version.amount_cents)} · échéance le ${due}`;
    value = amountText(override === null ? version.amount_cents : override);
    info = override === null ? usual
      : `Ce mois : ${override === 0 ? 'pas de paiement ce mois' : `modifié à ${euro(override)}`}<br>${usual}`;
  }
  openSheet(`
    <h3>${catIcon(group.category)} ${esc(group.title)}</h3>
    <p class="hint" style="text-align:center;margin-top:0">Change le montant d’un seul mois : les autres mois ne bougent pas.</p>
    <div class="monthbar" style="margin:12px 0">
      <button type="button" class="icon-btn" id="fm-prev" aria-label="Mois précédent">‹</button>
      <span class="label">${monthLabel(ym)}</span>
      <button type="button" class="icon-btn" id="fm-next" aria-label="Mois suivant">›</button>
    </div>
    <label class="field" for="fm-amount">Montant pour ce mois (€)</label>
    <input class="input big" id="fm-amount" inputmode="decimal" autocomplete="off" value="${value}" ${version ? '' : 'disabled'}>
    <p class="hint" style="text-align:center${override !== null ? ';color:var(--orange)' : ''}">${info}</p>
    <p class="error-text"></p>
    <div class="stack">
      <button type="submit" class="primary" ${version ? '' : 'disabled'}>Enregistrer pour ce mois seulement</button>
      <button type="button" class="secondary" id="fm-skip" ${version ? '' : 'disabled'}>Pas de paiement ce mois</button>
      ${version && override !== null ? `<button type="button" class="secondary" id="fm-reset">Rétablir le montant habituel (${euro(version.amount_cents)})</button>` : ''}
      <button type="button" class="secondary" id="fm-all">Modifier pour tous les mois…</button>
      <button type="button" class="secondary" data-close>Annuler</button>
    </div>`, async (form) => {
    const cents = positiveCents(form.querySelector('#fm-amount').value);
    if (version && cents === version.amount_cents) await clearFixedMonth(groupId, ym);
    else await setFixedMonth(groupId, ym, cents);
  });
  const form = $('#sheet-form');
  const move = (delta) => fixedMonthSheet(groupId, monthShift(ym + '-01', delta).slice(0, 7));
  form.querySelector('#fm-prev').addEventListener('click', () => move(-1));
  form.querySelector('#fm-next').addEventListener('click', () => move(1));
  form.querySelector('#fm-skip').addEventListener('click', () => sheetAction(() => setFixedMonth(groupId, ym, 0)));
  form.querySelector('#fm-all').addEventListener('click', () => fixedSheet(group));
  const reset = form.querySelector('#fm-reset');
  if (reset) reset.addEventListener('click', () => sheetAction(() => clearFixedMonth(groupId, ym)));
}

function stopFixedSheet(group) {
  openSheet(`
    <h3>Arrêter « ${esc(group.title)} »</h3>
    <p class="hint" style="text-align:center;margin-top:0">Les mois précédents sont conservés (historique et solde).<br>
      Plus aucune échéance à partir du mois choisi.</p>
    <label class="field" for="s-date">Plus d’échéance à partir du</label>
    <input class="input" id="s-date" type="date" value="${nextMonth(todayIso().slice(0, 7))}-01">
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Arrêter</button>
    </div>`, async (form) => {
    const value = form.querySelector('#s-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date invalide.');
    const ym = value.slice(0, 7);
    if (!confirm(`Plus d’échéance à partir de ${monthLabel(ym).toLowerCase()} ?`)) throw new Error('Annulé.');
    await stopFixed(group.id, ym);
  });
}

function fixedSheet(group = null) {
  const versions = group ? fixedHistory(group.id) : [];
  const selected = state.selected;
  const current = group ? (fixedVersionAt(group.id, selected) || versions[versions.length - 1] || null) : null;
  const names = categories().map((c) => c.name);
  const cat = group ? group.category : (names.includes('Factures') ? 'Factures' : names[0]);
  openSheet(`
    <h3>Montant fixe mensuel</h3>
    <label class="field" for="x-title">Description</label>
    <input class="input" id="x-title" autocomplete="off" value="${group ? esc(group.title) : ''}">
    <label class="field">Type de montant fixe</label>
    ${kindButtons(group ? group.kind : 'Dépense')}
    <label class="field">Catégorie</label>
    ${categoryPicker(cat)}
    ${accountPicker(group ? fixedAccountFor(group.id) : null)}
    <label class="field" for="x-amount">Montant mensuel habituel (€)</label>
    <input class="input big" id="x-amount" inputmode="decimal" autocomplete="off" value="${current ? amountText(current.amount_cents) : ''}">
    <label class="field" for="x-day">Jour du mois (1 à 31)</label>
    <input class="input" id="x-day" inputmode="numeric" value="${current ? current.day_of_month : 1}">
    <label class="field" for="x-start">À partir de</label>
    <input class="input" id="x-start" type="date" value="${current ? current.start_month : selected}-01">
    <p class="hint">Le nom, le type et la catégorie s’appliquent à tous les mois. Le montant et le jour s’appliquent à partir
      de la date choisie (les mois d’avant sont conservés). Les mois modifiés individuellement gardent leur montant.</p>
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const title = form.querySelector('#x-title').value.trim();
    if (!title) throw new Error('Saisis une description.');
    const amount = positiveCents(form.querySelector('#x-amount').value);
    const start = form.querySelector('#x-start').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('Date invalide.');
    const day = parseInteger(form.querySelector('#x-day').value, 'Jour du mois', 1, 31);
    const kind = form.querySelector('#f-kind .on').dataset.kind;
    const category = form.querySelector('#cats .on').dataset.cat;
    let accountId = null;
    if (isSavings(category, kind)) {
      accountId = Number(form.querySelector('#f-account').value) || null;
      if (accountId === null) throw new Error('Sélectionne un compte épargne (Plus › Comptes épargne).');
    }
    await saveFixed({ title, category, kind, amount, startMonth: start.slice(0, 7), day,
                      groupId: group ? group.id : null, accountId });
  });
  wirePickers($('#sheet-form'));
}

function accountSheet(account = null) {
  openSheet(`
    <h3>${account ? 'Modifier le compte' : 'Nouveau compte épargne'}</h3>
    <label class="field" for="a-name">Nom du compte</label>
    <input class="input" id="a-name" autocomplete="off" value="${account ? esc(account.name) : ''}">
    <label class="field" for="a-opening">Solde initial (€)</label>
    <input class="input" id="a-opening" inputmode="decimal" autocomplete="off" value="${account ? amountText(account.opening_cents) : '0'}">
    <p class="error-text"></p>
    <div class="actions">
      ${account ? '<button type="button" class="secondary danger" id="a-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const name = form.querySelector('#a-name').value.trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    const opening = parseAmount(form.querySelector('#a-opening').value);
    try {
      if (account) await check(sb.from('savings_accounts').update({ name, opening_cents: opening }).eq('id', account.id));
      else await check(sb.from('savings_accounts').insert({ id: newId(), name, opening_cents: opening }));
    } catch (e) {
      throw e.code === '23505' ? new Error('Ce nom de compte existe déjà.') : e;
    }
  });
  const del = $('#sheet-form').querySelector('#a-delete');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm('Supprimer ce compte épargne ?')) return;
      sheetAction(async () => {
        try {
          await check(sb.from('savings_accounts').delete().eq('id', account.id));
        } catch (e) {
          throw e.code === '23503' ? new Error('Ce compte possède des virements. Supprime ou réaffecte-les avant de supprimer le compte.') : e;
        }
      });
    });
  }
}

function categorySheet(original = null) {
  const current = original ? category(original) : { color: '#22D3EE', icon: 'Divers', savings: false };
  const icons = Object.keys(DEFAULT_COLORS);
  openSheet(`
    <h3>${original ? 'Modifier la catégorie' : 'Nouvelle catégorie'}</h3>
    <label class="field" for="c-name">Nom</label>
    <input class="input" id="c-name" autocomplete="off" value="${original ? esc(original) : ''}">
    <label class="field">Pictogramme</label>
    <div class="icons" id="c-icons">${icons.map((icon) => `<button type="button" data-icon="${esc(icon)}"
        class="${icon === current.icon ? 'on' : ''}" aria-label="${esc(icon)}">
        <span class="cat" style="--c:var(--text);--i:url('icons/cat/${iconSlug(icon)}.png')"></span></button>`).join('')}</div>
    <label class="field" for="c-color">Couleur</label>
    <input class="color" id="c-color" type="color" value="${current.color.toLowerCase()}">
    <label class="check"><input type="checkbox" id="c-savings" ${current.savings ? 'checked' : ''}> Virements vers un compte épargne</label>
    <p class="error-text"></p>
    <div class="actions">
      ${original ? '<button type="button" class="secondary danger" id="c-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const name = form.querySelector('#c-name').value.trim();
    const color = form.querySelector('#c-color').value;
    if (!name) throw new Error('Saisis un nom.');
    await loadAll();
    const list = categories();
    if (name !== original && list.some((c) => c.name === name)) throw new Error('Ce nom existe déjà.');
    const entry = { name, color, icon: form.querySelector('#c-icons .on').dataset.icon,
                    savings: form.querySelector('#c-savings').checked };
    if (original === null) list.push(entry);
    else {
      list[list.findIndex((c) => c.name === original)] = entry;
      if (name !== original) { // l'historique suit le nouveau nom
        await check(sb.from('items').update({ category: name }).eq('category', original));
        await check(sb.from('fixed_groups').update({ category: name }).eq('category', original));
      }
    }
    await saveCategories(list);
  });
  const form = $('#sheet-form');
  form.querySelector('#c-icons').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-icon]');
    if (b) form.querySelectorAll('#c-icons button').forEach((x) => x.classList.toggle('on', x === b));
  });
  const del = form.querySelector('#c-delete');
  if (del) {
    del.addEventListener('click', () => {
      const list = categories();
      const error = form.querySelector('.error-text');
      if (list.length <= 1) { error.textContent = 'Il faut garder au moins une catégorie.'; return; }
      if (state.data.items.some((i) => i.category === original) || state.data.fixed_groups.some((g) => g.category === original)) {
        error.textContent = 'Cette catégorie contient des opérations. Réaffecte-les avant de la supprimer.';
        return;
      }
      if (confirm(`Supprimer « ${original} » ?`)) {
        sheetAction(() => saveCategories(list.filter((c) => c.name !== original)));
      }
    });
  }
}

async function exportCsv() {
  const { count, year, text } = exportCsvText();
  const name = `kompte_echeances_${todayIso()}.csv`;
  const file = new File([text], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { return; } // partage annulé
  } else {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  }
  toast(`${count} échéances exportées (jusqu’à fin ${year + 1}).`);
}

function accentColor() {
  try { return localStorage.getItem('kompte-accent') || DEFAULT_ACCENT; } catch (e) { return DEFAULT_ACCENT; }
}
/** Texte noir ou blanc selon la couleur choisie (comme contrast_text() du PC). */
function applyAccent(color) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(color.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const root = document.documentElement.style;
  root.setProperty('--accent', color);
  root.setProperty('--on-accent', 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#101014' : '#ffffff');
}
function setAccent(color) {
  applyAccent(color);
  try { localStorage.setItem('kompte-accent', color); } catch (e) { /* stockage indisponible */ }
}

function balanceSheet() {
  const ref = balanceReference();
  openSheet(`
    <h3>Solde de référence</h3>
    <p class="hint" style="text-align:center">Indique ton solde à une date précise.<br>
      Les opérations suivantes actualiseront automatiquement le solde.</p>
    <label class="field" for="b-amount">Montant (€)</label>
    <input class="input big" id="b-amount" inputmode="decimal" autocomplete="off" value="${ref ? amountText(+ref.balance_cents) : ''}">
    <label class="field" for="b-date">Date du solde de référence</label>
    <input class="input" id="b-date" type="date" max="${todayIso()}" value="${ref ? ref.as_of : todayIso()}">
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const amount = parseAmount(form.querySelector('#b-amount').value);
    const anchor = form.querySelector('#b-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error('Date invalide.');
    if (anchor > todayIso()) throw new Error('La date de référence ne peut pas être dans le futur.');
    await loadAll(); // photographie à partir des données les plus récentes
    const baseline = {};
    for (const e of occurrences(anchor, addDays(todayIso(), 1))) baseline[`${e.row.id}|${e.due}`] = signed(e);
    await check(sb.from('kv_settings').upsert(
      { key: 'balance', value: { balance_cents: amount, as_of: anchor, baseline_events: baseline, version: 3 } },
      { onConflict: 'user_id,key' }));
  });
}

function passwordSheet() {
  openSheet(`
    <h3>Changer le mot de passe</h3>
    <p class="hint" style="text-align:center">Valable aussi sur le PC.</p>
    <label class="field" for="p-current">Mot de passe actuel</label>
    <input class="input" id="p-current" type="password" autocomplete="current-password">
    <label class="field" for="p-new">Nouveau mot de passe</label>
    <input class="input" id="p-new" type="password" autocomplete="new-password">
    <label class="field" for="p-confirm">Confirmer le nouveau mot de passe</label>
    <input class="input" id="p-confirm" type="password" autocomplete="new-password">
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Changer</button>
    </div>`, async (form) => {
    const current = form.querySelector('#p-current').value;
    const password = form.querySelector('#p-new').value;
    if (!current || !password) throw new Error('Remplis tous les champs.');
    if (password.length < 6) throw new Error('Le nouveau mot de passe doit faire au moins 6 caractères.');
    if (password !== form.querySelector('#p-confirm').value) throw new Error('Les deux nouveaux mots de passe ne correspondent pas.');
    const { error: authError } = await sb.auth.signInWithPassword({ email: state.email, password: current });
    if (authError) throw new Error('Le mot de passe actuel est incorrect.');
    const { error } = await sb.auth.updateUser({ password });
    if (error) {
      const text = (error.message || '').toLowerCase();
      if (text.includes('different')) throw new Error("Le nouveau mot de passe doit être différent de l'ancien.");
      if (text.includes('least') || text.includes('weak')) throw new Error('Mot de passe trop faible : au moins 6 caractères.');
      throw new Error(error.message);
    }
    toast('Mot de passe changé.');
  });
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ------------------------------------------------------------- événements
document.addEventListener('click', async (event) => {
  const t = event.target;
  if (t.closest('[data-close]')) { closeSheet(); return; }
  const tab = t.closest('#tabs button');
  if (tab) { state.tab = tab.dataset.tab; window.scrollTo(0, 0); render(); return; }
  if (t.closest('#fab')) { transactionSheet(null); return; }
  if (t.closest('#sync')) { refresh(true); return; }
  if (t.closest('#balance')) { balanceSheet(); return; }
  if (t.closest('#upcoming')) { upcomingSheet(); return; }
  if (t.closest('#today')) { state.selected = todayIso().slice(0, 7); render(); return; }
  if (t.closest('#chart-toggle')) { state.chart = !state.chart; render(); return; }
  if (t.closest('#add-fixed')) { fixedSheet(); return; }
  if (t.closest('#add-installment')) { transactionSheet(null, true); return; }
  if (t.closest('#add-account')) { accountSheet(); return; }
  if (t.closest('#add-category')) { categorySheet(); return; }
  if (t.closest('#export-csv')) { exportCsv(); return; }
  if (t.closest('#accent-reset')) { setAccent(DEFAULT_ACCENT); render(); return; }
  if (t.closest('#password-change')) { passwordSheet(); return; }
  if (t.closest('#logout')) {
    if (!confirm('Se déconnecter de Kompte sur ce téléphone ?')) return;
    await sb.auth.signOut();
    try { localStorage.removeItem('kompte-cache'); } catch (e) { /* rien */ }
    state.data = null;
    state.email = '';
    renderLogin();
    return;
  }
  const go = t.closest('[data-go]');
  if (go) { state.tab = go.dataset.go; window.scrollTo(0, 0); render(); return; }
  const month = t.closest('[data-month]');
  if (month) { state.selected = monthShift(state.selected + '-01', +month.dataset.month).slice(0, 7); render(); return; }
  const row = t.closest('[data-item]');
  if (row) {
    const id = Number(row.dataset.item);
    if (id < 0) { fixedMonthSheet(-id, row.dataset.due.slice(0, 7)); return; } // ce mois seulement
    const item = state.data.items.find((i) => i.id === id);
    if (item) transactionSheet(item);
    return;
  }
  const installment = t.closest('[data-installment]');
  if (installment) {
    const item = state.data.items.find((i) => i.id === Number(installment.dataset.installment));
    if (item) installmentSheet(item);
    return;
  }
  const fixed = t.closest('[data-fixed]');
  if (fixed) {
    const group = state.data.fixed_groups.find((g) => g.id === Number(fixed.dataset.fixed));
    if (group) fixedActionsSheet(group);
    return;
  }
  const account = t.closest('[data-account]');
  if (account) {
    const found = state.data.savings_accounts.find((a) => a.id === Number(account.dataset.account));
    if (found) accountSheet(found);
    return;
  }
  const cat = t.closest('[data-category]');
  if (cat) categorySheet(cat.dataset.category);
});

let searchTimer = null;
document.addEventListener('input', (event) => {
  if (event.target.id === 'accent') setAccent(event.target.value);
  if (event.target.id !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    const pos = event.target.selectionStart;
    render();
    const input = $('#search');
    input.focus();
    input.setSelectionRange(pos, pos);
  }, 300);
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'login') return;
  event.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const error = $('#login-error');
  if (!email || !password) { error.textContent = 'Saisis ton e-mail et ton mot de passe.'; return; }
  error.textContent = '';
  const { data, error: authError } = await sb.auth.signInWithPassword({ email, password });
  if (authError) {
    error.textContent = /invalid/i.test(authError.message) ? 'E-mail ou mot de passe incorrect.' : authError.message;
    return;
  }
  state.tab = 'dashboard';
  startApp(data.session);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.email) refresh();
});

function startApp(session) {
  state.email = session.user.email;
  $('#tabs').hidden = false;
  render();
  refresh(state.data === null);
}

async function boot() {
  applyAccent(accentColor());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const { data } = await sb.auth.getSession();
  if (!data.session) { renderLogin(); return; }
  try {
    const cache = JSON.parse(localStorage.getItem('kompte-cache') || 'null');
    // Un cache d'une ancienne version (table manquante) est ignoré.
    if (cache && cache.email === data.session.user.email && Object.keys(TABLES).every((t) => cache.data[t])) {
      state.data = cache.data;
      state.version = cache.version;
    }
  } catch (e) { /* cache illisible : on recharge */ }
  startApp(data.session);
}

setInterval(() => { if (document.visibilityState === 'visible' && state.email) refresh(); }, POLL_MS);
boot();
