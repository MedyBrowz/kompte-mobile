'use strict';
/* Kompte mobile : mêmes données que l'application PC, via Supabase.
   Les calculs (échéances, solde) reprennent exactement ceux de kompte.py. */

const SUPABASE_URL = 'https://scwyqwgoihdftvipfhwy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vF_QP0y9Vyr4_1kvf88DPw_MMtEfaJk'; // clé publique (protégée par RLS)
const POLL_MS = 15000;
const PAGE = 1000;

const TABLES = {
  savings_accounts: ['id', 'id,name,opening_cents,month_start'],
  items: ['id', 'id,title,kind,category,total_cents,first_date,installments,frequency,created_at,account_id'],
  fixed_groups: ['id', 'id,title,category,kind,day_of_month,account_id'],
  fixed_versions: ['id', 'id,group_id,amount_cents,start_month,end_month,day_of_month'],
  fixed_overrides: ['group_id', 'group_id,month,amount_cents'],
  savings_transfers: ['item_id', 'item_id,account_id'],
  fixed_savings_transfers: ['group_id', 'group_id,account_id'],
  notes: ['id', 'id,item_id,group_id,due_date,body,updated_at'],
};
const MAIN_ACCOUNT = null; // le compte principal n'a pas de ligne : ses opérations ont account_id null
const ALL_ACCOUNTS = 'tous';

const DEFAULT_COLORS = {
  Revenus: '#4ADE80', Logement: '#6478D8', Factures: '#EAB308', Alimentation: '#F97316',
  Transport: '#A855F7', 'Véhicule': '#94A3B8', Loisirs: '#22D3EE', Shopping: '#EC4899',
  Abonnements: '#818CF8', 'Santé': '#FB7185', Animaux: '#D4A373', Vacances: '#2DD4BF',
  Cadeaux: '#F472B6', 'Épargne': '#10B981', Remboursement: '#A3E635', Divers: '#9CA3AF',
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                'septembre', 'octobre', 'novembre', 'décembre'];

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const state = {
  data: null,       // tables + kv (réglages partagés)
  version: null,
  tab: 'dashboard',
  account: MAIN_ACCOUNT,
  selected: todayIso().slice(0, 7),
  query: '',
  category: '',     // filtre de l'onglet Transactions
  loading: false,
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
/** Mois d'un compte commençant le jour `day` : jusqu'au 15, il porte le nom du mois où il
    commence, après le 15, celui du mois où il finit (= period_bounds de kompte.py). */
function periodBounds(ym, day) {
  if (day <= 1) return [`${ym}-01`, nextMonth(ym) + '-01'];
  if (day <= 15) return [dueInMonth(ym, day), dueInMonth(nextMonth(ym), day)];
  return [dueInMonth(monthShift(ym + '-01', -1).slice(0, 7), day), dueInMonth(ym, day)];
}
function periodOf(iso, day) {
  const ym = iso.slice(0, 7);
  for (const candidate of [monthShift(ym + '-01', -1).slice(0, 7), ym, nextMonth(ym)]) {
    const [start, end] = periodBounds(candidate, day);
    if (start <= iso && iso < end) return candidate;
  }
  return ym;
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

function nowStamp() {
  const d = new Date();
  return `${todayIso()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

// ------------------------------------------------------------------ comptes
function mainAccount() {
  const saved = (state.data && state.data.kv.main_account) || {};
  return { name: String(saved.name || 'Compte principal'), month_start: Math.max(1, Math.min(31, parseInt(saved.month_start, 10) || 1)) };
}
function sortedAccounts() {
  return [...state.data.savings_accounts].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
}
function accountName(account) {
  if (account === MAIN_ACCOUNT) return mainAccount().name;
  const found = state.data.savings_accounts.find((a) => a.id === account);
  return found ? found.name : '';
}
function monthStart(account) {
  if (account === MAIN_ACCOUNT) return mainAccount().month_start;
  const found = state.data.savings_accounts.find((a) => a.id === account);
  return found ? found.month_start : 1;
}
function currentMonth() { return periodOf(todayIso(), monthStart(state.account)); }
function periodHint() {
  const day = monthStart(state.account);
  if (day <= 1) return '';
  const [start, end] = periodBounds(state.selected, day);
  return `du ${frDate(start)} au ${frDate(addDays(end, -1))}`;
}

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
          out.push({ row: { id: -g.id, title: g.title, category: g.category, kind: g.kind, account_id: g.account_id,
                            frequency: 'Mensuelle',
                            installments: 1, base_amount: v.amount_cents, override }, due, amount: value });
        }
      }
      ym = nextMonth(ym);
    }
  }
  return out;
}

function occurrences(start, end, account = ALL_ACCOUNTS) {
  let results = [];
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
  if (account !== ALL_ACCOUNTS) results = forAccount(results, account);
  return results.sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : b.row.id - a.row.id));
}

/** Les opérations du compte, plus les virements reçus, vus dans l'autre sens. */
function forAccount(events, account) {
  const linked = new Map(state.data.savings_transfers.map((t) => [t.item_id, t.account_id]));
  for (const t of state.data.fixed_savings_transfers) linked.set(-t.group_id, t.account_id);
  const kept = [];
  for (const e of events) {
    if ((e.row.account_id ?? null) === account) kept.push(e);
    else if (account !== MAIN_ACCOUNT && linked.get(e.row.id) === account) {
      kept.push({ ...e, row: { ...e.row, kind: e.row.kind === 'Revenu' ? 'Dépense' : 'Revenu' } });
    }
  }
  return kept;
}

function summary(ym, account = state.account) {
  const [start, end] = periodBounds(ym, monthStart(account));
  const events = occurrences(start, end, account);
  const today = todayIso();
  let income = 0, out = 0, paid = 0;
  for (const e of events) {
    if (e.row.kind === 'Revenu') income += e.amount;
    else { out += e.amount; if (e.due <= today) paid += e.amount; }
  }
  return { income, out, paid, events };
}

const signed = (e) => (e.row.kind === 'Revenu' ? e.amount : -e.amount);

function balanceReference() {
  const b = state.data && state.data.kv.balance;
  if (!b || typeof b !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(b.as_of || '') || !Number.isInteger(+b.balance_cents)) return null;
  return b;
}

function accountBalance(accountId) {
  const account = state.data.savings_accounts.find((a) => a.id === accountId);
  if (!account) return 0;
  return account.opening_cents + occurrences('0000-01-01', addDays(todayIso(), 1), accountId).reduce((sum, e) => sum + signed(e), 0);
}

function getBalance(account = state.account) {
  if (account !== MAIN_ACCOUNT) return accountBalance(account);
  const data = balanceReference();
  if (!data) return null;
  const anchor = data.as_of, today = todayIso();
  if (anchor > today) return +data.balance_cents;
  const current = new Map();
  for (const e of occurrences(anchor, addDays(today, 1), MAIN_ACCOUNT)) current.set(`${e.row.id}|${e.due}`, signed(e));
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

async function remoteVersion() {
  const rows = await check(sb.from('sync_state').select('version'));
  return rows.length ? rows[0].version : 0;
}

function noteKeys() {
  return new Set(state.data.notes.map((n) => `${n.item_id ?? -n.group_id}|${n.due_date}`));
}
function noteOf(rowId, due) {
  const column = rowId < 0 ? 'group_id' : 'item_id', owner = Math.abs(rowId);
  const rows = state.data.notes.filter((n) => n[column] === owner && n.due_date === due)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return rows.length ? rows[0].body : '';
}
/** Le commentaire d'une échéance (vide = supprimé). */
async function saveNote(rowId, due, body) {
  const column = rowId < 0 ? 'group_id' : 'item_id', owner = Math.abs(rowId);
  await check(sb.from('notes').delete().eq(column, owner).eq('due_date', due));
  if (body.trim()) {
    await check(sb.from('notes').insert({ id: newId(), [column]: owner, due_date: due, body: body.trim(), updated_at: nowStamp() }));
  }
}
function noteField(rowId, due) {
  return `<label class="field" for="note-body">Commentaire (${frDate(due)})</label>
    <textarea class="input" id="note-body" rows="2">${esc(noteOf(rowId, due))}</textarea>`;
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

let pendingMonthReset = false; // le jour de début de mois a pu changer

async function refresh(force = false) {
  if (state.loading) { state.again = state.again || force; return; }
  state.loading = true;
  setSync('Synchronisation…');
  try {
    if (force || state.data === null || (await remoteVersion()) !== state.version) {
      await loadAll();
      if (pendingMonthReset) { pendingMonthReset = false; state.selected = currentMonth(); }
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
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('#fab').hidden = state.tab !== 'dashboard'; // Transactions : lecture seule
  if (state.account !== MAIN_ACCOUNT && !state.data.savings_accounts.some((a) => a.id === state.account)) {
    state.account = MAIN_ACCOUNT; // compte supprimé depuis le PC
    state.selected = currentMonth();
  }
  if (state.tab === 'transactions') renderTransactions();
  else if (state.tab === 'fixed') renderFixed();
  else if (state.tab === 'notes') renderNotes();
  else if (state.tab === 'account') renderAccount();
  else renderDashboard();
}

function accountBar() {
  const option = (value, name) => `<option value="${value}" ${String(state.account ?? '') === String(value) ? 'selected' : ''}>${esc(name)}</option>`;
  return `<select class="input account-select" id="account" aria-label="Compte affiché">
      ${option('', mainAccount().name)}${sortedAccounts().map((a) => option(a.id, a.name)).join('')}
    </select>`;
}

function eventRow(e) {
  const r = e.row;
  let when = frDate(e.due);
  if (r.id < 0) {
    when += ' · fixe';
    if (r.override !== null && r.override !== undefined) when += ' (modifié ce mois)';
  }
  if (noteKeys().has(`${r.id}|${e.due}`)) when += ' · note';
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
  const isToday = ym === currentMonth();
  const hint = periodHint();
  const today = todayIso();
  // Seulement ce qui a déjà eu lieu, les 10 plus récentes (le détail est dans Transactions).
  const done = events.filter((e) => e.due <= today).slice(0, 10);
  const metric = (label, value, color, id = '') =>
    `<${id ? `button type="button" id="${id}"` : 'div'} class="metric"><small>${label}</small><b style="color:${color}">${euro(value)}</b></${id ? 'button' : 'div'}>`;
  view.innerHTML = `
    ${accountBar()}
    <button type="button" class="hero" id="balance">
      <small>SOLDE ACTUEL</small>
      <strong>${balance === null ? '— €' : euro(balance)}</strong>
      <span>${state.account !== MAIN_ACCOUNT ? 'Touche pour modifier le compte'
    : ref ? `Depuis le ${frDate(ref.as_of)} · touche pour modifier` : 'Touche ici pour saisir ton solde bancaire actuel'}</span>
    </button>
    <div class="monthbar">
      <button type="button" class="icon-btn" data-month="-1" aria-label="Mois précédent">‹</button>
      <span class="label">${monthLabel(ym)}</span>
      <button type="button" class="icon-btn" data-month="1" aria-label="Mois suivant">›</button>
    </div>
    ${hint ? `<p class="period">${hint}</p>` : ''}
    ${isToday ? '' : '<p style="text-align:center;margin:-6px 0 10px"><button type="button" class="chip" id="today">Revenir à aujourd’hui</button></p>'}
    <div class="metrics">
      ${metric('Revenus prévus', income, 'var(--green)')}
      ${metric('Dépenses prévues ›', out - paid, 'var(--red)', 'upcoming')}
      ${metric('Déjà dépensé', paid, 'var(--text)')}
      ${metric('Reste prévisionnel', income - out, 'var(--orange)')}
    </div>
    <h2>Dernières opérations</h2>
    <div class="list">${done.map(eventRow).join('') || '<p class="empty">Aucune opération passée ce mois-ci.</p>'}</div>
    ${done.length ? '<p class="note">Toutes les opérations du mois : onglet Transactions.</p>' : ''}`;
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
  let { income, out, events } = summary(ym);
  const names = categories().map((c) => c.name);
  const chosen = names.includes(state.category) ? state.category : '';
  const needle = state.query.toLowerCase();
  const shown = events.filter((e) => (!chosen || e.row.category === chosen) && (!needle || e.row.title.toLowerCase().includes(needle)
    || e.row.category.toLowerCase().includes(needle) || amountText(e.amount).includes(needle.replace('.', ','))));
  let totals = `<span class="plus">+${euro(income)}</span><span class="minus">−${euro(out)}</span><span>= ${euro(income - out)}</span>`;
  if (chosen || needle) {
    // Totaux de ce qui est affiché ; la différence n'a de sens qu'avec les deux.
    income = shown.filter((e) => e.row.kind === 'Revenu').reduce((sum, e) => sum + e.amount, 0);
    out = shown.filter((e) => e.row.kind === 'Dépense').reduce((sum, e) => sum + e.amount, 0);
    totals = `${income ? `<span class="plus">+${euro(income)}</span>` : ''}${out ? `<span class="minus">−${euro(out)}</span>` : ''}
      ${income && out ? `<span>= ${euro(income - out)}</span>` : ''}`;
  }
  const noted = noteKeys();
  const rows = shown.map((e) => {
    const r = e.row;
    const plus = r.kind === 'Revenu';
    let details = `${r.category} · ${frDate(e.due)}`;
    if (r.id < 0) details += ' · fixe';
    else if (r.installments > 1) {
      const index = (+e.due.slice(0, 4) - +r.first_date.slice(0, 4)) * 12 + (+e.due.slice(5, 7) - +r.first_date.slice(5, 7));
      details += ` · ${index + 1}/${r.installments}`;
    } else if (r.frequency !== 'Unique') details += ` · ${r.frequency.toLowerCase()}`;
    if (noted.has(`${r.id}|${e.due}`)) details += ' · note';
    return `<button type="button" class="row" data-item="${r.id}" data-due="${e.due}">
        ${catIcon(r.category)}
        <span class="body"><span class="title">${esc(r.title)}</span><span class="sub">${esc(details)}</span></span>
        <span class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${euro(e.amount)}</span>
      </button>`;
  }).join('');
  const month = MONTHS[+ym.slice(5, 7) - 1];
  const hint = periodHint();
  view.innerHTML = `
    ${accountBar()}
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
    ${hint ? `<p class="period">${hint}</p>` : ''}
    <div class="totals">${totals}</div>
    <select class="input filter" id="category-filter" aria-label="Filtrer par catégorie">
      <option value="">Toutes les catégories</option>
      ${names.map((n) => `<option ${n === chosen ? 'selected' : ''}>${esc(n)}</option>`).join('')}
    </select>
    <input class="search" id="search" type="search" placeholder="Rechercher dans le mois…" value="${esc(state.query)}">
    <div class="list">${rows || `<p class="empty">${state.query || chosen ? 'Aucune opération trouvée.' : 'Aucune opération ce mois-ci.'}</p>`}</div>`;
}

/** Montants fixes : on peut en ajouter ici ; les modifier reste sur le PC. */
function renderFixed() {
  const ym = todayIso().slice(0, 7);
  const groups = state.data.fixed_groups.filter((g) => (g.account_id ?? null) === state.account).sort((a, b) => b.id - a.id);
  const rows = groups.map((g) => {
    const version = state.data.fixed_versions.filter((v) => v.group_id === g.id && v.start_month <= ym
      && (!v.end_month || v.end_month > ym)).sort((a, b) => (a.start_month < b.start_month ? 1 : -1))[0];
    const plus = g.kind === 'Revenu';
    return `<div class="row">
        ${catIcon(g.category)}
        <span class="body"><span class="title">${esc(g.title)}</span>
          <span class="sub">${esc(g.category)}${version ? ` · le ${version.day_of_month} du mois` : ''}</span></span>
        ${version ? `<span class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${euro(version.amount_cents)}</span>`
    : '<span class="sub">Pas actif ce mois-ci</span>'}
      </div>`;
  }).join('');
  view.innerHTML = `
    ${accountBar()}
    <h2>Montants fixes</h2>
    <button type="button" class="primary wide" id="add-fixed">+ Ajouter un montant fixe</button>
    <div class="list">${rows || '<p class="empty">Aucun montant fixe enregistré.</p>'}</div>
    <p class="note">Pour modifier ou arrêter un montant fixe, passe par le PC.</p>`;
}

function renderNotes() {
  const groups = new Map(state.data.fixed_groups.map((g) => [g.id, g]));
  const items = new Map(state.data.items.map((i) => [i.id, i]));
  const rows = [...state.data.notes].sort((a, b) => (a.due_date === b.due_date
    ? (a.updated_at < b.updated_at ? 1 : -1) : a.due_date < b.due_date ? 1 : -1));
  view.innerHTML = `
    <h2>Notes</h2>
    <div class="list">${rows.map((n) => {
    const owner = n.item_id !== null ? items.get(n.item_id) : groups.get(n.group_id);
    if (!owner) return '';
    return `<button type="button" class="row top" data-item="${n.item_id ?? -n.group_id}" data-due="${n.due_date}">
        ${catIcon(owner.category)}
        <span class="body"><span class="title">${esc(owner.title)}</span>
          <span class="sub">${frDate(n.due_date)} · ${esc(accountName(owner.account_id ?? null))}</span>
          <span class="note-body">${esc(n.body)}</span></span>
      </button>`;
  }).join('') || '<p class="empty">Aucune note. Touche une transaction pour écrire un commentaire.</p>'}</div>`;
}

function renderAccount() {
  const line = (id, name, balance, day) => `<button type="button" class="row" data-account="${id}">
      <span class="body"><span class="title">${esc(name)}</span><span class="sub">Le mois commence le ${day}</span></span>
      <span class="amount ${balance !== null && balance < 0 ? 'minus' : 'plus'}">${balance === null ? '—' : euro(balance)}</span>
    </button>`;
  const main = mainAccount();
  view.innerHTML = `
    <h2>Comptes</h2>
    <div class="actions" style="margin-top:0">
      <button type="button" class="primary" id="add-account">+ Ajouter</button>
      <button type="button" class="secondary" id="transfer">Virement</button>
    </div>
    <div class="list" style="margin-top:12px">
      ${line('main', main.name, getBalance(MAIN_ACCOUNT), main.month_start)}
      ${sortedAccounts().map((a) => line(a.id, a.name, accountBalance(a.id), a.month_start)).join('')}
    </div>
    <h2>Connexion</h2>
    <p class="note" style="margin-top:0">Connecté avec ${esc(state.email)}.<br>
      Les modifications faites ici apparaissent sur le PC en quelques secondes, et inversement.</p>
    <p class="note">La modification des montants fixes et les catégories se font sur le PC ;
      ils sont pris en compte ici dans les calculs.</p>
    <div class="actions">
      <button type="button" class="secondary" id="password-change">Changer le mot de passe</button>
      <button type="button" class="secondary" id="logout">Se déconnecter</button>
    </div>`;
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

function categoryPicker(selected) {
  return `<div class="cats" id="cats">${categories().map((c) =>
    `<button type="button" data-cat="${esc(c.name)}" class="${c.name === selected ? 'on' : ''}" style="--c:${c.color}">
       ${catIcon(c.name)}<span>${esc(c.name)}</span></button>`).join('')}</div>`;
}

function accountOptions(selectedId, exclude = MAIN_ACCOUNT) {
  return sortedAccounts().filter((a) => a.id !== exclude).map((a) => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')
    || '<option value="">Aucun compte</option>';
}

/** Boutons Type et Catégorie ; le compte épargne n'apparaît que pour un virement. */
function wirePickers(form, split = false) {
  const refreshAccount = () => {
    const k = form.querySelector('#f-kind .on').dataset.kind;
    const c = form.querySelector('#cats .on').dataset.cat;
    form.querySelector('#f-account-box').hidden = !(isSavings(c, k) && !split);
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

function fixedSheet() {
  const names = categories().map((c) => c.name);
  const ym = todayIso().slice(0, 7);
  openSheet(`
    <h3>Nouveau montant fixe</h3>
    <label class="field" for="x-amount">Montant mensuel (€)</label>
    <input class="input big" id="x-amount" inputmode="decimal" autocomplete="off">
    <label class="field" for="x-title">Description</label>
    <input class="input" id="x-title" autocomplete="off">
    <label class="field">Type</label>
    <div class="segmented" id="f-kind">
      <button type="button" data-kind="Dépense" class="on">Dépense</button>
      <button type="button" data-kind="Revenu">Revenu</button>
    </div>
    <label class="field">Catégorie</label>
    ${categoryPicker(names.includes('Factures') ? 'Factures' : names[0])}
    <div id="f-account-box" hidden>
      <label class="field" for="f-account">Compte destinataire</label>
      <select class="input" id="f-account">${accountOptions(null, state.account)}</select>
    </div>
    <label class="field" for="x-day">Jour du mois (1 à 31)</label>
    <input class="input" id="x-day" inputmode="numeric" value="1">
    <label class="field" for="x-start">À partir de</label>
    <input class="input" id="x-start" type="date" value="${ym}-01">
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
    const day = Number(form.querySelector('#x-day').value.trim());
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Jour du mois : entre 1 et 31.');
    const kind = form.querySelector('#f-kind .on').dataset.kind;
    const cat = form.querySelector('#cats .on').dataset.cat;
    let accountId = null;
    if (isSavings(cat, kind)) {
      accountId = Number(form.querySelector('#f-account').value) || null;
      if (accountId === null) throw new Error('Crée d’abord un autre compte (onglet Comptes).');
    }
    const groupId = newId();
    await check(sb.from('fixed_groups').insert({ id: groupId, title, category: cat, kind, day_of_month: day, account_id: state.account }));
    await check(sb.from('fixed_versions').insert({ id: newId(), group_id: groupId, amount_cents: amount,
                                                   start_month: start.slice(0, 7), end_month: null, day_of_month: day }));
    if (accountId !== null) await check(sb.from('fixed_savings_transfers').insert({ group_id: groupId, account_id: accountId }));
  });
  wirePickers($('#sheet-form'));
  setTimeout(() => $('#sheet-form').querySelector('#x-amount').focus(), 120);
}

function transactionSheet(item, due = null) {
  const editing = !!item;
  const split = editing && item.installments > 1;
  const transfer = editing ? state.data.savings_transfers.find((t) => t.item_id === item.id) : null;
  const kind = editing ? item.kind : 'Dépense';
  const cat = editing ? item.category : (categories().find((c) => c.name === 'Alimentation') || categories()[0]).name;
  const html = `
    <h3>${editing ? 'Modifier la transaction' : 'Nouvelle transaction'}</h3>
    <label class="field" for="f-amount">Montant (€)</label>
    <input class="input big" id="f-amount" inputmode="decimal" autocomplete="off" value="${editing ? amountText(item.total_cents) : ''}">
    <label class="field" for="f-title">Description</label>
    <input class="input" id="f-title" autocomplete="off" value="${editing ? esc(item.title) : ''}">
    <label class="field">Type</label>
    <div class="segmented" id="f-kind">
      <button type="button" data-kind="Dépense" class="${kind === 'Dépense' ? 'on' : ''}" ${split ? 'disabled' : ''}>Dépense</button>
      <button type="button" data-kind="Revenu" class="${kind === 'Revenu' ? 'on' : ''}" ${split ? 'disabled' : ''}>Revenu</button>
    </div>
    <label class="field">Catégorie</label>
    ${categoryPicker(cat)}
    <div id="f-account-box" hidden>
      <label class="field" for="f-account">Compte destinataire</label>
      <select class="input" id="f-account">${accountOptions(transfer ? transfer.account_id : null, editing ? item.account_id ?? null : state.account)}</select>
    </div>
    <label class="field" for="f-date">${split ? 'Date du premier paiement' : 'Date'}</label>
    <input class="input" id="f-date" type="date" value="${editing ? item.first_date : todayIso()}">
    ${split ? `<label class="field" for="f-count">Nombre de mensualités</label>
      <input class="input" id="f-count" inputmode="numeric" value="${item.installments}">` : ''}
    ${editing && item.frequency !== 'Unique' ? `<p class="hint">Répétition : ${esc(item.frequency)}</p>` : ''}
    ${editing && due ? noteField(item.id, due) : ''}
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
    const first = form.querySelector('#f-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error('Date invalide.');
    const kindValue = form.querySelector('#f-kind .on').dataset.kind;
    const catValue = form.querySelector('#cats .on').dataset.cat;
    let n = 1;
    if (split) {
      n = Number(form.querySelector('#f-count').value.trim());
      if (!Number.isInteger(n)) throw new Error('Nombre de mensualités : saisis un nombre entier.');
      if (n < 2 || n > 120) throw new Error('Nombre de mensualités : entre 2 et 120.');
      if (n > total) throw new Error('Montant trop faible pour ce nombre de mensualités.');
    }
    let accountId = null;
    if (isSavings(catValue, kindValue)) {
      if (n > 1) throw new Error('Les virements épargne ne peuvent pas être fractionnés.');
      accountId = Number(form.querySelector('#f-account').value) || null;
      if (accountId === null) throw new Error('Crée d’abord un autre compte (onglet Comptes).');
    }
    const fields = { title, kind: kindValue, category: catValue, total_cents: total, first_date: first };
    if (editing) {
      await check(sb.from('items').update({ ...fields, installments: n, frequency: item.frequency }).eq('id', item.id));
      await check(sb.from('savings_transfers').delete().eq('item_id', item.id));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: item.id, account_id: accountId }));
      await check(sb.from('confirmations').delete().eq('item_id', item.id));
      if (due) {
        const single = item.frequency === 'Unique' && n === 1; // le commentaire suit la date
        if (single && first !== due) await saveNote(item.id, due, '');
        await saveNote(item.id, single ? first : due, form.querySelector('#note-body').value);
      }
    } else {
      const id = newId();
      await check(sb.from('items').insert({ id, ...fields, installments: 1, frequency: 'Unique', created_at: utcStamp(), account_id: state.account }));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: id, account_id: accountId }));
    }
  });

  const form = $('#sheet-form');
  wirePickers(form, split);
  const del = form.querySelector('#f-delete');
  if (del) {
    del.addEventListener('click', async () => {
      if (!confirm('Supprimer cette transaction et toutes ses échéances ?')) return;
      try {
        await check(sb.from('items').delete().eq('id', item.id));
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = e.message;
      }
    });
  }
  if (!editing) setTimeout(() => form.querySelector('#f-amount').focus(), 120);
}

/** Commentaire d'une échéance de montant fixe (le montant se modifie sur le PC). */
function fixedNoteSheet(groupId, due) {
  const group = state.data.fixed_groups.find((g) => g.id === groupId);
  if (!group) return;
  openSheet(`
    <h3>${esc(group.title)}</h3>
    <p class="hint" style="text-align:center;margin-top:0">Montant fixe : le montant se modifie sur le PC.</p>
    ${noteField(-groupId, due)}
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => { await saveNote(-groupId, due, form.querySelector('#note-body').value); });
}

/** Virement : une seule ligne, vue des deux côtés. Vers le compte principal, c'est un revenu
    du principal venant du compte source (= save_transfer de kompte.py). */
function transferSheet(item = null, due = null) {
  const accounts = sortedAccounts();
  if (!accounts.length) { toast('Ajoute d’abord un deuxième compte.'); return; }
  const linked = item ? state.data.savings_transfers.find((t) => t.item_id === item.id).account_id : null;
  const source = item ? (item.kind === 'Revenu' ? linked : item.account_id ?? null) : state.account;
  const target = item ? (item.kind === 'Revenu' ? MAIN_ACCOUNT : linked)
    : (source === MAIN_ACCOUNT ? accounts[0].id : MAIN_ACCOUNT);
  const options = (selected) => [[MAIN_ACCOUNT, mainAccount().name], ...accounts.map((a) => [a.id, a.name])]
    .map(([id, name]) => `<option value="${id ?? ''}" ${id === selected ? 'selected' : ''}>${esc(name)}</option>`).join('');
  openSheet(`
    <h3>${item ? 'Modifier le virement' : 'Virement entre comptes'}</h3>
    <label class="field" for="t-amount">Montant (€)</label>
    <input class="input big" id="t-amount" inputmode="decimal" autocomplete="off" value="${item ? amountText(item.total_cents) : ''}">
    <label class="field" for="t-from">Depuis</label>
    <select class="input" id="t-from">${options(source)}</select>
    <label class="field" for="t-to">Vers</label>
    <select class="input" id="t-to">${options(target)}</select>
    <label class="field" for="t-title">Description</label>
    <input class="input" id="t-title" autocomplete="off" value="${item ? esc(item.title) : 'Virement'}">
    <label class="field" for="t-date">Date</label>
    <input class="input" id="t-date" type="date" value="${item ? item.first_date : todayIso()}">
    ${item ? noteField(item.id, due || item.first_date) : ''}
    <p class="error-text"></p>
    <div class="actions">
      ${item ? '<button type="button" class="secondary danger" id="t-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const value = (id) => { const v = form.querySelector(id).value; return v === '' ? MAIN_ACCOUNT : Number(v); };
    const from = value('#t-from'), to = value('#t-to');
    if (from === to) throw new Error('Choisis deux comptes différents.');
    const title = form.querySelector('#t-title').value.trim();
    if (!title) throw new Error('Saisis une description.');
    const total = positiveCents(form.querySelector('#t-amount').value);
    const first = form.querySelector('#t-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error('Date invalide.');
    const toMain = to === MAIN_ACCOUNT;
    const savings = categories().find((c) => c.savings);
    const fields = { title, total_cents: total, first_date: first, kind: toMain ? 'Revenu' : 'Dépense', account_id: toMain ? MAIN_ACCOUNT : from };
    const other = toMain ? from : to;
    if (item) {
      await check(sb.from('items').update(fields).eq('id', item.id));
      await check(sb.from('savings_transfers').update({ account_id: other }).eq('item_id', item.id));
      const original = due || item.first_date;
      const single = item.frequency === 'Unique';
      if (single && first !== original) await saveNote(item.id, original, '');
      await saveNote(item.id, single ? first : original, form.querySelector('#note-body').value);
    } else {
      const id = newId();
      await check(sb.from('items').insert({ id, ...fields, category: savings ? savings.name : 'Épargne', installments: 1,
                                            frequency: 'Unique', created_at: utcStamp() }));
      await check(sb.from('savings_transfers').insert({ item_id: id, account_id: other }));
    }
  });
  const form = $('#sheet-form');
  if (item) {
    form.querySelector('#t-delete').addEventListener('click', async () => {
      if (!confirm('Supprimer ce virement ?')) return;
      try {
        await check(sb.from('items').delete().eq('id', item.id));
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = e.message;
      }
    });
  } else setTimeout(() => form.querySelector('#t-amount').focus(), 120);
}

/** Compte : `account` null = nouveau, 'main' = compte principal. */
function accountSheet(account = null) {
  const isMain = account === 'main';
  const current = isMain ? mainAccount() : account;
  openSheet(`
    <h3>${isMain ? 'Compte principal' : account ? 'Modifier le compte' : 'Nouveau compte'}</h3>
    <label class="field" for="a-name">Nom du compte</label>
    <input class="input" id="a-name" autocomplete="off" value="${current ? esc(current.name) : ''}">
    ${isMain ? '' : `<label class="field" for="a-opening">Solde initial (€)</label>
    <input class="input" id="a-opening" inputmode="decimal" autocomplete="off" value="${account ? amountText(account.opening_cents) : '0'}">`}
    <label class="field" for="a-day">Le mois commence le (1 à 31)</label>
    <input class="input" id="a-day" inputmode="numeric" value="${current ? current.month_start : 1}">
    <p class="hint">Ex. le 18 : le mois va du 18 au 17. Il porte le nom du mois où il compte le plus de jours (jusqu’au 15, celui où il commence).</p>
    <p class="error-text"></p>
    <div class="actions">
      ${account && !isMain ? '<button type="button" class="secondary danger" id="a-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const name = form.querySelector('#a-name').value.trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    const day = Number(form.querySelector('#a-day').value.trim());
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Début du mois : entre 1 et 31.');
    const taken = isMain ? state.data.savings_accounts.some((a) => a.name === name) : name === mainAccount().name;
    if (taken) throw new Error('Ce nom de compte existe déjà.');
    if (isMain) {
      await check(sb.from('kv_settings').upsert({ key: 'main_account', value: { name, month_start: day } }, { onConflict: 'user_id,key' }));
    } else {
      const fields = { name, opening_cents: parseAmount(form.querySelector('#a-opening').value), month_start: day };
      try {
        if (account) await check(sb.from('savings_accounts').update(fields).eq('id', account.id));
        else await check(sb.from('savings_accounts').insert({ id: newId(), ...fields }));
      } catch (e) {
        throw e.code === '23505' ? new Error('Ce nom de compte existe déjà.') : e;
      }
    }
    pendingMonthReset = true;
  });
  const del = $('#sheet-form').querySelector('#a-delete');
  if (del) {
    del.addEventListener('click', async () => {
      if (!confirm('Supprimer ce compte ?')) return;
      const form = $('#sheet-form');
      try {
        await check(sb.from('savings_accounts').delete().eq('id', account.id));
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = e.code === '23503'
          ? 'Ce compte possède des opérations ou des virements. Supprime ou réaffecte-les avant de supprimer le compte.' : e.message;
      }
    });
  }
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
    for (const e of occurrences(anchor, addDays(todayIso(), 1), MAIN_ACCOUNT)) baseline[`${e.row.id}|${e.due}`] = signed(e);
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
  if (t.closest('#balance')) {
    if (state.account === MAIN_ACCOUNT) balanceSheet();
    else accountSheet(state.data.savings_accounts.find((a) => a.id === state.account));
    return;
  }
  if (t.closest('#add-account')) { accountSheet(); return; }
  if (t.closest('#transfer')) { transferSheet(); return; }
  if (t.closest('#upcoming')) { upcomingSheet(); return; }
  if (t.closest('#today')) { state.selected = currentMonth(); render(); return; }
  if (t.closest('#add-fixed')) { fixedSheet(); return; }
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
  const month = t.closest('[data-month]');
  if (month) { state.selected = monthShift(state.selected + '-01', +month.dataset.month).slice(0, 7); render(); return; }
  const row = t.closest('[data-item]');
  if (row) {
    const id = Number(row.dataset.item);
    if (id < 0) { fixedNoteSheet(-id, row.dataset.due); return; }
    const item = state.data.items.find((i) => i.id === id);
    if (!item) return;
    if (state.data.savings_transfers.some((tr) => tr.item_id === id)) transferSheet(item, row.dataset.due);
    else transactionSheet(item, row.dataset.due);
    return;
  }
  const account = t.closest('[data-account]');
  if (account) {
    const id = account.dataset.account;
    accountSheet(id === 'main' ? 'main' : state.data.savings_accounts.find((a) => a.id === Number(id)));
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'account') {
    const wasCurrent = state.selected === currentMonth();
    state.account = event.target.value === '' ? MAIN_ACCOUNT : Number(event.target.value);
    if (wasCurrent) state.selected = currentMonth();
    render();
  } else if (event.target.id === 'category-filter') {
    state.category = event.target.value;
    render();
  }
});

let searchTimer = null;
document.addEventListener('input', (event) => {
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
  if (state.data) state.selected = currentMonth();
  else pendingMonthReset = true;
  render();
  refresh(state.data === null);
}

async function boot() {
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
