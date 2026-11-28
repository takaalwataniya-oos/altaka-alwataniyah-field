'use strict';
/**
 * ALTAKA-ALWATANIYAH — برنامج الحسابات المتكامل (خادم الحاسبة الأم، ويندوز)
 * Node.js 22.13+ بدون مكتبات خارجية — قاعدة بيانات SQLite المدمجة (node:sqlite).
 *
 * الأقسام: دليل الحسابات (النظام المحاسبي الموحد) · القيود اليومية · سندات القبض والصرف ·
 * المبيعات (عروض الأسعار والفواتير والزبائن) · المشتريات (الفواتير والموردون) · المخازن
 * (المواد، الصرف للمشاريع، الجرد، المتوسط المرجّح) · المشاريع ومراكز الكلفة · التقارير والقوائم المالية.
 * العملة الأساسية الدينار العراقي، ويُسجَّل الدولار مع سعر الصرف لكل حركة.
 */
process.removeAllListeners('warning');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const CHART = require('./chart');

const ROOT = __dirname;
const DATA = process.env.ACC_DATA_DIR || path.join(ROOT, 'data');
const BACKUPS = path.join(DATA, 'backups');
fs.mkdirSync(BACKUPS, { recursive: true });
const CONFIG_FILE = path.join(DATA, 'config.json');

/* ---------------- الإعدادات ---------------- */
const config = (() => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  let ch = false;
  if (!c.port) { c.port = Number(process.env.PORT) || 8790; ch = true; }
  if (ch) fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  return c;
})();

/* ---------------- قاعدة البيانات ---------------- */
const db = new DatabaseSync(path.join(DATA, 'accounting.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, name TEXT, role TEXT, pass_hash TEXT, active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS accounts (code TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT, type TEXT NOT NULL, is_group INTEGER DEFAULT 0, active INTEGER DEFAULT 1, notes TEXT);
CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, address TEXT, currency TEXT DEFAULT 'IQD', account_code TEXT, credit_limit REAL, notes TEXT, active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS warehouses (id INTEGER PRIMARY KEY, name TEXT NOT NULL, notes TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, unit TEXT, category TEXT, stock INTEGER DEFAULT 1, inv_account TEXT, revenue_account TEXT, sale_price REAL, sale_currency TEXT DEFAULT 'IQD', min_qty REAL, notes TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, customer_id INTEGER, capacity TEXT, location TEXT, contract_value REAL, currency TEXT DEFAULT 'IQD', status TEXT DEFAULT 'active', start_date TEXT, end_date TEXT, erp_ref TEXT, notes TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS rates (date TEXT, currency TEXT, rate REAL, PRIMARY KEY(date, currency));
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER);
CREATE TABLE IF NOT EXISTS journals (id INTEGER PRIMARY KEY, no TEXT, date TEXT NOT NULL, kind TEXT, ref_type TEXT, ref_id INTEGER, memo TEXT, status TEXT DEFAULT 'posted', created_by TEXT, created_at TEXT, void_reason TEXT);
CREATE TABLE IF NOT EXISTS journal_lines (id INTEGER PRIMARY KEY, journal_id INTEGER NOT NULL REFERENCES journals(id), account_code TEXT NOT NULL REFERENCES accounts(code), party_id INTEGER, project_id INTEGER, debit REAL DEFAULT 0, credit REAL DEFAULT 0, currency TEXT DEFAULT 'IQD', rate REAL DEFAULT 1, fc_debit REAL DEFAULT 0, fc_credit REAL DEFAULT 0, memo TEXT);
CREATE INDEX IF NOT EXISTS jl_acc ON journal_lines(account_code);
CREATE INDEX IF NOT EXISTS jl_party ON journal_lines(party_id);
CREATE INDEX IF NOT EXISTS jl_proj ON journal_lines(project_id);
CREATE INDEX IF NOT EXISTS j_date ON journals(date);
CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, type TEXT NOT NULL, no TEXT, date TEXT, due_date TEXT, party_id INTEGER, project_id INTEGER, warehouse_id INTEGER, currency TEXT, rate REAL, subtotal REAL, discount REAL DEFAULT 0, tax REAL DEFAULT 0, total REAL, notes TEXT, supplier_ref TEXT, quote_id INTEGER, status TEXT DEFAULT 'posted', journal_id INTEGER, created_by TEXT, created_at TEXT, void_reason TEXT);
CREATE TABLE IF NOT EXISTS invoice_lines (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, item_id INTEGER, description TEXT, qty REAL, unit_price REAL, total REAL, account_code TEXT, unit_cost REAL);
CREATE TABLE IF NOT EXISTS quotations (id INTEGER PRIMARY KEY, no TEXT, date TEXT, valid_until TEXT, party_id INTEGER, customer_name TEXT, customer_phone TEXT, project_id INTEGER, currency TEXT, rate REAL, lines TEXT, subtotal REAL, discount REAL DEFAULT 0, total REAL, terms TEXT, status TEXT DEFAULT 'draft', invoice_id INTEGER, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS vouchers (id INTEGER PRIMARY KEY, type TEXT NOT NULL, no TEXT, date TEXT, party_id INTEGER, counter_account TEXT, cash_account TEXT, project_id INTEGER, currency TEXT, rate REAL, amount REAL, payee TEXT, method TEXT, cheque_no TEXT, memo TEXT, invoice_id INTEGER, status TEXT DEFAULT 'posted', journal_id INTEGER, created_by TEXT, created_at TEXT, void_reason TEXT);
CREATE TABLE IF NOT EXISTS stock_docs (id INTEGER PRIMARY KEY, type TEXT NOT NULL, no TEXT, date TEXT, warehouse_id INTEGER, to_warehouse_id INTEGER, project_id INTEGER, memo TEXT, status TEXT DEFAULT 'posted', journal_id INTEGER, created_by TEXT, created_at TEXT, void_reason TEXT);
CREATE TABLE IF NOT EXISTS stock_moves (id INTEGER PRIMARY KEY, date TEXT, item_id INTEGER NOT NULL, warehouse_id INTEGER, qty REAL NOT NULL, unit_cost REAL, ref_type TEXT, ref_id INTEGER, project_id INTEGER, void INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS sm_item ON stock_moves(item_id);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT, user TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT, ip TEXT);
`);

const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
class Bad extends Error { constructor(msg, code) { super(msg); this.status = code || 400; } }
const getSet = k => { const r = one('SELECT value FROM settings WHERE key=?', k); return r ? r.value : null; };
const setSet = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v == null ? null : String(v));

/* بذر البيانات الأساسية */
if (!one('SELECT 1 x FROM accounts LIMIT 1')) {
  tx(() => {
    const ins = db.prepare('INSERT INTO accounts(code,name,parent,type,is_group) VALUES(?,?,?,?,?)');
    for (const [code, name, type, g] of CHART) {
      let parent = null;
      for (let i = code.length - 1; i > 0; i--) { const p = code.slice(0, i); if (CHART.some(c => c[0] === p)) { parent = p; break; } }
      ins.run(code, name, parent, type, g ? 1 : 0);
    }
    run("INSERT INTO warehouses(name) VALUES('المخزن الرئيسي – الحلة')");
    const defs = {
      company_ar: 'الطاقة الوطنية للمقاولات والتجارة العامة والطاقة المتجددة', company_en: 'ALTAKA-ALWATANIYAH',
      company_address: 'الحلة – شارع اربعين قرب حلويات السموأل', company_phone: '07765656559',
      base_currency: 'IQD', usd_rate: '1310', lock_date: '',
      acc_customers: '1611', acc_suppliers: '2611', acc_advances: '1652', acc_cash_iqd: '1811', acc_cash_usd: '1812',
      acc_bank_iqd: '1831', acc_bank_usd: '1832', acc_sales: '411', acc_services: '413', acc_cogs: '34',
      acc_inventory: '1369', acc_discount_allowed: '391', acc_discount_earned: '491', acc_tax: '2664',
      acc_stock_loss: '392', acc_stock_gain: '492', acc_opening: '229', acc_purchases_service: '339'
    };
    for (const k in defs) setSet(k, defs[k]);
  });
}

/* ترحيلات: أعمدة جديدة وحسابات الصناديق */
function addCol(t, c, type) { if (!all(`PRAGMA table_info(${t})`).some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`); }
addCol('items', 'price_wholesale', 'REAL'); addCol('items', 'price_agent', 'REAL'); addCol('items', 'pack_unit', 'TEXT'); addCol('items', 'pack_qty', 'REAL');
addCol('invoice_lines', 'pack_unit', 'TEXT'); addCol('invoice_lines', 'pack_count', 'REAL'); addCol('invoice_lines', 'pack_price', 'REAL');
if (!getSet('mig_cash_v1')) tx(() => {
  const add = [['1813', 'السنايا – دينار', '181'], ['1814', 'السنايا – دولار', '181'], ['1833', 'البطاقة الرئيسية', '183'], ['1834', 'البطاقة الثانوية', '183'], ['1835', 'حساب التوفير', '183']];
  add.forEach(([c, n, pa]) => { if (!one('SELECT 1 x FROM accounts WHERE code=?', c)) run('INSERT INTO accounts(code,name,parent,type,is_group) VALUES(?,?,?,?,0)', c, n, pa, 'asset'); });
  // يُلغى الحساب الجاري لدى المصرف (يُعطَّل؛ ويبقى ظاهراً فقط إن كان عليه رصيد)
  ['1831', '1832'].forEach(c => run('UPDATE accounts SET active=0 WHERE code=?', c));
  setSet('acc_bank_iqd', '1833');
  setSet('dash_cash', '1811,1812,1833,1834,1835,1813,1814');
  setSet('mig_cash_v1', '1');
});

/* ---------------- كلمات المرور والجلسات ---------------- */
function hashPass(p) { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(String(p), s, 32).toString('hex'); }
function checkPass(p, h) {
  if (!h || !h.includes(':')) return false;
  const [s, x] = h.split(':'); const a = crypto.scryptSync(String(p), s, 32), b = Buffer.from(x, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map();
const tooMany = k => { const f = fails.get(k); return f && f.n >= 5 && Date.now() < f.until; };
const fail = k => { const f = fails.get(k); fails.set(k, { n: f && Date.now() < f.until ? f.n + 1 : 1, until: Date.now() + 15 * 60e3 }); };
const SESSION_IDLE_H = 12;

/* الأدوار والصلاحيات (يطبّقها الخادم) */
/* المهام (الصلاحيات) المتاحة لإسنادها إلى الأدوار */
const PERMS = [
  ['gl', 'القيود اليومية ودليل الحسابات والسندات'],
  ['sales', 'عروض الأسعار وفواتير البيع والزبائن'],
  ['purchases', 'فواتير الشراء والموردون'],
  ['store', 'المواد والمخازن وحركات المخزن'],
  ['projects', 'المشاريع ومراكز الكلفة'],
  ['void', 'إلغاء المستندات'],
  ['reports', 'كل التقارير'],
  ['reports.sales', 'تقارير المبيعات والزبائن والمشاريع'],
  ['reports.store', 'تقارير المخزون']
];
const PERM_KEYS = PERMS.map(x => x[0]);
const DEFAULT_ROLES = {
  admin: { t: 'مدير النظام', d: 'كل شيء، والإعدادات والمستخدمون وقفل الفترات', p: ['*'] },
  accountant: { t: 'محاسب', d: 'كل العمليات المحاسبية والتقارير والإلغاء', p: ['gl', 'sales', 'purchases', 'store', 'projects', 'reports', 'void'] },
  sales: { t: 'مبيعات', d: 'عروض الأسعار وفواتير البيع والزبائن والمشاريع وتقارير المبيعات', p: ['sales', 'projects', 'reports.sales'] },
  purchases: { t: 'مشتريات', d: 'فواتير الشراء والموردون والمواد وتقارير المخزون', p: ['purchases', 'store', 'reports.store'] },
  store: { t: 'أمين مخزن', d: 'المواد وحركات المخزن وتقارير المخزون', p: ['store', 'reports.store'] },
  viewer: { t: 'اطلاع على التقارير', d: 'كل التقارير بدون أي تعديل', p: ['reports'] }
};
/* الأدوار تُحفظ في الإعدادات (roles_json) ويمكن تعديلها من نافذة المستخدمين والصلاحيات */
const ROLES = {};
function loadRoles() {
  let saved = null; try { saved = JSON.parse(getSet('roles_json') || 'null'); } catch { saved = null; }
  const src = saved && typeof saved === 'object' ? saved : DEFAULT_ROLES;
  for (const k of Object.keys(ROLES)) delete ROLES[k];
  for (const [k, v] of Object.entries(src)) ROLES[k] = { t: String(v.t || k), d: String(v.d || ''), p: Array.isArray(v.p) ? v.p.filter(x => PERM_KEYS.includes(x)) : [] };
  ROLES.admin = { ...DEFAULT_ROLES.admin, d: (src.admin && src.admin.d) || DEFAULT_ROLES.admin.d }; /* المدير دائماً بكل الصلاحيات */
}
loadRoles();
function can(u, p) {
  const ps = (ROLES[u.role] || {}).p || [];
  return ps.includes('*') || ps.includes(p) || (p.startsWith('reports.') && ps.includes('reports'));
}

/* ---------------- أدوات مشتركة ---------------- */
function nextNo(prefix, date) {
  const y = String(date || today()).slice(0, 4), key = prefix + '-' + y;
  const r = one('SELECT n FROM counters WHERE key=?', key);
  const n = (r ? r.n : 0) + 1;
  run('INSERT INTO counters(key,n) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET n=excluded.n', key, n);
  return `${prefix}-${y}-${String(n).padStart(4, '0')}`;
}
function audit(u, action, entity, id, details, ip) {
  run('INSERT INTO audit(at,user,action,entity,entity_id,details,ip) VALUES(?,?,?,?,?,?,?)', nowIso(), u ? u.username : '', action, entity, String(id == null ? '' : id), details ? JSON.stringify(details).slice(0, 4000) : null, ip || null);
}
function checkDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) throw new Bad('التاريخ غير صحيح');
  const lock = getSet('lock_date');
  if (lock && d <= lock) throw new Bad('الفترة مقفلة حتى ' + lock + ' — لا يمكن التسجيل أو الإلغاء بتاريخ سابق');
}
function rateOf(currency, rate) {
  if ((currency || 'IQD') === 'IQD') return 1;
  const r = Number(rate) || Number(getSet('usd_rate'));
  if (!(r > 0)) throw new Bad('سعر الصرف مطلوب');
  return r;
}
function account(code) {
  const a = one('SELECT * FROM accounts WHERE code=?', String(code || ''));
  if (!a) throw new Bad('الحساب غير موجود: ' + code);
  if (a.is_group) throw new Bad('لا يمكن القيد على حساب تجميعي: ' + a.code + ' ' + a.name);
  if (!a.active) throw new Bad('الحساب معطّل: ' + a.code);
  return a;
}
function party(id, kind) {
  if (!id) return null;
  const p = one('SELECT * FROM parties WHERE id=?', Number(id));
  if (!p) throw new Bad('الجهة غير موجودة');
  if (kind && p.kind !== kind && !(kind === 'customer' && p.kind === 'both') && !(kind === 'supplier' && p.kind === 'both')) throw new Bad('نوع الجهة غير مناسب');
  return p;
}
function partyAccount(p) {
  if (p.account_code) return p.account_code;
  return getSet(p.kind === 'supplier' ? 'acc_suppliers' : p.kind === 'employee' ? 'acc_advances' : 'acc_customers');
}

/**
 * ترحيل قيد: lines = [{account, debit|credit بعملة القيد, party_id, project_id, memo}]
 * المبالغ تُحوَّل إلى الدينار بسعر الصرف وتُحفظ بالعملة الأصلية أيضاً. يجب أن يتوازن القيد.
 */
function postJournal(j, user) {
  checkDate(j.date);
  const cur = j.currency || 'IQD', rate = rateOf(cur, j.rate);
  const lines = (j.lines || []).filter(l => (r2(l.debit) || r2(l.credit)) && (l.iqd == null || r2(l.iqd)));
  if (lines.length < 2) throw new Bad('القيد يحتاج طرفين على الأقل');
  let td = 0, tc = 0;
  const rows = lines.map(l => {
    account(l.account);
    // iqd: مبلغ محدد بالدينار (كلفة المخزون) — يُحفظ كما هو ويُشتق المبلغ الأجنبي منه
    const fd = l.iqd != null && l.debit ? r2(l.iqd / rate) : r2(l.debit), fc = l.iqd != null && l.credit ? r2(l.iqd / rate) : r2(l.credit);
    if (fd < 0 || fc < 0) throw new Bad('لا تُقبل المبالغ السالبة');
    const d = l.iqd != null && l.debit ? r2(l.iqd) : cur === 'IQD' ? fd : r2(fd * rate), c = l.iqd != null && l.credit ? r2(l.iqd) : cur === 'IQD' ? fc : r2(fc * rate);
    td += d; tc += c;
    return { a: String(l.account), party: l.party_id || null, proj: l.project_id || null, d, c, fd, fc, memo: l.memo || null };
  });
  const diff = r2(td - tc);
  if (Math.abs(diff) > 0.009) {
    if (cur !== 'IQD' && Math.abs(diff) <= 1) { const x = rows[rows.length - 1]; if (x.d) x.d = r2(x.d - diff); else x.c = r2(x.c + diff); }
    else throw new Bad('القيد غير متوازن: المدين ' + r2(td) + ' والدائن ' + r2(tc));
  }
  const no = nextNo('JV', j.date);
  const jid = Number(run('INSERT INTO journals(no,date,kind,ref_type,ref_id,memo,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    no, j.date, j.kind || 'manual', j.ref_type || null, j.ref_id || null, j.memo || null, 'posted', user ? user.username : '', nowIso()).lastInsertRowid);
  const ins = db.prepare('INSERT INTO journal_lines(journal_id,account_code,party_id,project_id,debit,credit,currency,rate,fc_debit,fc_credit,memo) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  rows.forEach(x => ins.run(jid, x.a, x.party, x.proj, x.d, x.c, cur, rate, x.fd, x.fc, x.memo));
  return jid;
}
function voidJournal(jid, reason) { if (jid) run("UPDATE journals SET status='void', void_reason=? WHERE id=?", reason || null, jid); }

/* المخزون: كمية ورصيد بالمتوسط المرجّح (بالدينار) */
function stockState(itemId, whId) {
  const r = one(`SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(qty*unit_cost),0) v FROM stock_moves WHERE item_id=? AND void=0 ${whId ? 'AND warehouse_id=?' : ''}`, ...(whId ? [itemId, whId] : [itemId]));
  return { qty: Math.round(r.q * 1000) / 1000, value: r2(r.v) };
}
function avgCost(itemId) { const s = stockState(itemId); return s.qty > 0 ? s.value / s.qty : (one('SELECT unit_cost c FROM stock_moves WHERE item_id=? AND void=0 AND qty>0 ORDER BY id DESC LIMIT 1', itemId) || {}).c || 0; }
function move(date, item, wh, qty, cost, refType, refId, proj) {
  run('INSERT INTO stock_moves(date,item_id,warehouse_id,qty,unit_cost,ref_type,ref_id,project_id) VALUES(?,?,?,?,?,?,?,?)', date, item, wh, qty, cost, refType, refId, proj || null);
}
function needStock(item, wh, qty) {
  const s = stockState(item.id, wh);
  if (s.qty + 1e-9 < qty) throw new Bad(`الكمية غير كافية في المخزن للمادة «${item.name}»: المتوفر ${s.qty} والمطلوب ${qty}`);
}
const itemInv = it => it.inv_account || getSet('acc_inventory');

/* ---------------- المستندات ---------------- */
function cleanLines(lines) {
  return (lines || []).map(l => {
    const o = { item_id: l.item_id ? Number(l.item_id) : null, description: String(l.description || '').trim(), qty: Number(l.qty) || 0, unit_price: r2(l.unit_price), account_code: l.account_code || null };
    // الكمية بوحدة التعبئة (كارتون/ربطة…): تُخزَّن بالقطع، والسعر للتعبئة يبقى دقيقاً
    const pc = Number(l.pack_count) || 0, it = o.item_id && pc > 0 ? one('SELECT pack_unit, pack_qty FROM items WHERE id=?', o.item_id) : null;
    if (it && it.pack_unit && it.pack_qty > 1) {
      o.pack_unit = it.pack_unit; o.pack_count = pc; o.pack_price = r2(l.pack_price);
      o.qty = pc * it.pack_qty; o.unit_price = r2(pc * o.pack_price) / o.qty;
    }
    return o;
  }).filter(l => l.qty && (l.item_id || l.description));
}
function createInvoice(b, user) {
  const type = b.type === 'purchase' ? 'purchase' : 'sale';
  return tx(() => {
    const date = b.date || today(); checkDate(date);
    const p = party(b.party_id, type === 'sale' ? 'customer' : 'supplier'); if (!p) throw new Bad(type === 'sale' ? 'اختر الزبون' : 'اختر المورد');
    const cur = b.currency === 'USD' ? 'USD' : 'IQD', rate = rateOf(cur, b.rate);
    const wh = Number(b.warehouse_id) || (one('SELECT id FROM warehouses WHERE active=1 ORDER BY id') || {}).id;
    const proj = b.project_id ? Number(b.project_id) : null;
    const lines = cleanLines(b.lines); if (!lines.length) throw new Bad('أضف سطراً واحداً على الأقل');
    let sub = 0;
    lines.forEach(l => { if (l.qty <= 0) throw new Bad('الكمية يجب أن تكون أكبر من صفر'); l.total = l.pack_unit ? r2(l.pack_count * l.pack_price) : r2(l.qty * l.unit_price); sub += l.total; l.item = l.item_id ? one('SELECT * FROM items WHERE id=?', l.item_id) : null; if (l.item_id && !l.item) throw new Bad('مادة غير موجودة'); if (!l.description && l.item) l.description = l.item.name; });
    sub = r2(sub); const disc = r2(b.discount), tax = r2(b.tax), total = r2(sub - disc + tax);
    if (disc < 0 || disc > sub) throw new Bad('الخصم غير صحيح');
    const no = nextNo(type === 'sale' ? 'SI' : 'PI', date);
    const id = Number(run('INSERT INTO invoices(type,no,date,due_date,party_id,project_id,warehouse_id,currency,rate,subtotal,discount,tax,total,notes,supplier_ref,quote_id,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      type, no, date, b.due_date || null, p.id, proj, wh, cur, rate, sub, disc, tax, total, b.notes || null, b.supplier_ref || null, b.quote_id || null, 'posted', user.username, nowIso()).lastInsertRowid);
    const insL0 = db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,description,qty,unit_price,total,account_code,unit_cost,pack_unit,pack_count,pack_price) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    let curL = null; const insL = { run: (...a) => insL0.run(...a, curL && curL.pack_unit || null, curL && curL.pack_count || null, curL && curL.pack_price || null) };
    const jl = []; const pAcc = partyAccount(p);
    let costIqd = 0;
    if (type === 'sale') {
      jl.push({ account: pAcc, debit: total, party_id: p.id, project_id: proj, memo: 'فاتورة بيع ' + no });
      lines.forEach(l => {
        const rev = l.account_code || (l.item && l.item.revenue_account) || (l.item && l.item.stock ? getSet('acc_sales') : getSet('acc_services'));
        account(rev);
        let uc = null;
        if (l.item && l.item.stock) {
          needStock(l.item, wh, l.qty); uc = avgCost(l.item.id); move(date, l.item.id, wh, -l.qty, uc, 'invoice', id, proj);
          const c = r2(uc * l.qty); costIqd += c;
          jl.push({ account: getSet('acc_cogs'), debit: 1, iqd: c, project_id: proj, memo: 'كلفة ' + l.description });
          jl.push({ account: itemInv(l.item), credit: 1, iqd: c, project_id: proj, memo: 'إخراج مخزني ' + l.description });
        }
        curL = l; insL.run(id, l.item_id, l.description, l.qty, l.unit_price, l.total, rev, uc);
        jl.push({ account: rev, credit: l.total, project_id: proj, memo: l.description });
      });
      if (disc) jl.push({ account: getSet('acc_discount_allowed'), debit: disc, project_id: proj, memo: 'خصم مسموح به' });
      if (tax) jl.push({ account: getSet('acc_tax'), credit: tax, memo: 'ضريبة' });
    } else {
      jl.push({ account: pAcc, credit: total, party_id: p.id, project_id: proj, memo: 'فاتورة شراء ' + no + (b.supplier_ref ? ' (' + b.supplier_ref + ')' : '') });
      // الخصم المكتسب يوزَّع على كلفة المواد بالنسبة
      const ratio = sub ? (sub - disc) / sub : 1;
      lines.forEach(l => { l.net = r2(l.total * ratio); });
      const nd = r2(sub - disc - lines.reduce((s, l) => s + l.net, 0)); if (nd) lines[lines.length - 1].net = r2(lines[lines.length - 1].net + nd);
      lines.forEach(l => {
        const net = l.net;
        if (l.item && l.item.stock) {
          const uc = (net * rate) / l.qty;
          move(date, l.item.id, wh, l.qty, uc, 'invoice', id, proj);
          curL = l; insL.run(id, l.item_id, l.description, l.qty, l.unit_price, l.total, itemInv(l.item), uc);
          jl.push({ account: itemInv(l.item), debit: net, project_id: proj, memo: l.description });
        } else {
          const ex = l.account_code || getSet('acc_purchases_service'); account(ex);
          curL = l; insL.run(id, l.item_id, l.description, l.qty, l.unit_price, l.total, ex, null);
          jl.push({ account: ex, debit: net, project_id: proj, memo: l.description });
        }
      });
      if (tax) jl.push({ account: getSet('acc_tax'), debit: tax, memo: 'ضريبة' });
    }
    const jid = postJournal({ date, currency: cur, rate, kind: type === 'sale' ? 'sale' : 'purchase', ref_type: 'invoice', ref_id: id, memo: (type === 'sale' ? 'فاتورة بيع ' : 'فاتورة شراء ') + no + ' – ' + p.name, lines: jl }, user);
    run('UPDATE invoices SET journal_id=? WHERE id=?', jid, id);
    if (b.quote_id) run("UPDATE quotations SET status='invoiced', invoice_id=?, updated_at=? WHERE id=?", id, nowIso(), Number(b.quote_id));
    return id;
  });
}
function voidDoc(table, id, reason, user) {
  return tx(() => {
    const d = one(`SELECT * FROM ${table} WHERE id=?`, Number(id));
    if (!d) throw new Bad('المستند غير موجود', 404);
    if (d.status === 'void') throw new Bad('المستند ملغى مسبقاً');
    checkDate(d.date);
    const refType = table === 'invoices' ? 'invoice' : table === 'stock_docs' ? 'stock' : null;
    if (refType) {
      // منع إلغاء مستند إدخال إذا كانت الكمية قد صُرفت
      for (const m of all('SELECT * FROM stock_moves WHERE ref_type=? AND ref_id=? AND void=0 AND qty>0', refType, d.id)) {
        const s = stockState(m.item_id, m.warehouse_id);
        if (s.qty + 1e-9 < m.qty) throw new Bad('لا يمكن الإلغاء: كمية من هذا المستند صُرفت لاحقاً. ألغِ المستندات اللاحقة أو سجّل تسوية.');
      }
      run('UPDATE stock_moves SET void=1 WHERE ref_type=? AND ref_id=?', refType, d.id);
    }
    if (table === 'invoices' && d.type === 'sale' && d.quote_id) run("UPDATE quotations SET status='accepted', invoice_id=NULL WHERE id=?", d.quote_id);
    run(`UPDATE ${table} SET status='void', void_reason=? WHERE id=?`, reason || null, d.id);
    voidJournal(d.journal_id, reason);
    return d;
  });
}
function createVoucher(b, user) {
  const type = b.type === 'payment' ? 'payment' : 'receipt';
  return tx(() => {
    const date = b.date || today(); checkDate(date);
    const cur = b.currency === 'USD' ? 'USD' : 'IQD', rate = rateOf(cur, b.rate);
    const amount = r2(b.amount); if (!(amount > 0)) throw new Bad('المبلغ مطلوب');
    const cash = account(b.cash_account || getSet(cur === 'USD' ? 'acc_cash_usd' : 'acc_cash_iqd')).code;
    const p = b.party_id ? party(b.party_id) : null;
    const counter = p ? partyAccount(p) : b.counter_account;
    if (!counter) throw new Bad('اختر الجهة أو الحساب المقابل'); account(counter);
    const proj = b.project_id ? Number(b.project_id) : null;
    const no = nextNo(type === 'receipt' ? 'RV' : 'PV', date);
    const id = Number(run('INSERT INTO vouchers(type,no,date,party_id,counter_account,cash_account,project_id,currency,rate,amount,payee,method,cheque_no,memo,invoice_id,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      type, no, date, p ? p.id : null, counter, cash, proj, cur, rate, amount, b.payee || (p && p.name) || null, b.method || 'cash', b.cheque_no || null, b.memo || null, b.invoice_id || null, 'posted', user.username, nowIso()).lastInsertRowid);
    const memo = (type === 'receipt' ? 'سند قبض ' : 'سند صرف ') + no + (b.memo ? ' – ' + b.memo : '');
    const lines = type === 'receipt'
      ? [{ account: cash, debit: amount, project_id: proj, memo }, { account: counter, credit: amount, party_id: p ? p.id : null, project_id: proj, memo }]
      : [{ account: counter, debit: amount, party_id: p ? p.id : null, project_id: proj, memo }, { account: cash, credit: amount, project_id: proj, memo }];
    const jid = postJournal({ date, currency: cur, rate, kind: type, ref_type: 'voucher', ref_id: id, memo, lines }, user);
    run('UPDATE vouchers SET journal_id=? WHERE id=?', jid, id);
    return id;
  });
}
function createManualJournal(b, user) {
  return tx(() => {
    const jid = postJournal({ date: b.date || today(), currency: b.currency === 'USD' ? 'USD' : 'IQD', rate: b.rate, kind: b.kind === 'opening' ? 'opening' : 'manual', memo: b.memo, lines: (b.lines || []).map(l => ({ account: l.account, debit: l.debit, credit: l.credit, party_id: l.party_id ? Number(l.party_id) : null, project_id: l.project_id ? Number(l.project_id) : null, memo: l.memo })) }, user);
    return jid;
  });
}
/* حركات المخزن: إدخال افتتاحي، صرف لمشروع، تسوية جرد، تحويل بين مخازن */
function createStockDoc(b, user) {
  const type = ['opening', 'issue', 'adjust', 'transfer', 'return'].includes(b.type) ? b.type : null;
  if (!type) throw new Bad('نوع الحركة غير صحيح');
  return tx(() => {
    const date = b.date || today(); checkDate(date);
    const wh = Number(b.warehouse_id); if (!one('SELECT 1 x FROM warehouses WHERE id=?', wh)) throw new Bad('اختر المخزن');
    const to = type === 'transfer' ? Number(b.to_warehouse_id) : null;
    if (type === 'transfer' && (!to || to === wh)) throw new Bad('اختر المخزن المحوَّل إليه');
    const proj = b.project_id ? Number(b.project_id) : null;
    if ((type === 'issue' || type === 'return') && !proj) throw new Bad('اختر المشروع');
    const lines = (b.lines || []).map(l => ({ item: one('SELECT * FROM items WHERE id=?', Number(l.item_id)), qty: Number(l.qty) || 0, cost: Number(l.unit_cost) || 0 })).filter(l => l.item && l.qty);
    if (!lines.length) throw new Bad('أضف مادة واحدة على الأقل');
    const no = nextNo({ opening: 'OS', issue: 'SO', adjust: 'SA', transfer: 'ST', return: 'SR' }[type], date);
    const id = Number(run('INSERT INTO stock_docs(type,no,date,warehouse_id,to_warehouse_id,project_id,memo,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', type, no, date, wh, to, proj, b.memo || null, 'posted', user.username, nowIso()).lastInsertRowid);
    const jl = [];
    for (const l of lines) {
      if (!l.item.stock) throw new Bad('المادة «' + l.item.name + '» خدمية وليست مخزنية');
      const inv = itemInv(l.item);
      if (type === 'opening') {
        if (l.qty <= 0 || l.cost < 0) throw new Bad('الكمية والكلفة مطلوبتان');
        move(date, l.item.id, wh, l.qty, l.cost, 'stock', id); const v = r2(l.qty * l.cost);
        if (v) { jl.push({ account: inv, debit: v, memo: 'رصيد افتتاحي ' + l.item.name }); jl.push({ account: getSet('acc_opening'), credit: v, memo: 'رصيد افتتاحي ' + l.item.name }); }
      } else if (type === 'issue') {
        if (l.qty <= 0) throw new Bad('الكمية يجب أن تكون موجبة');
        needStock(l.item, wh, l.qty); const c = avgCost(l.item.id); move(date, l.item.id, wh, -l.qty, c, 'stock', id, proj); const v = r2(c * l.qty);
        if (v) { jl.push({ account: getSet('acc_cogs'), debit: v, project_id: proj, memo: 'صرف للمشروع: ' + l.item.name }); jl.push({ account: inv, credit: v, project_id: proj, memo: 'صرف للمشروع: ' + l.item.name }); }
      } else if (type === 'return') {
        if (l.qty <= 0) throw new Bad('الكمية يجب أن تكون موجبة');
        const c = avgCost(l.item.id); move(date, l.item.id, wh, l.qty, c, 'stock', id, proj); const v = r2(c * l.qty);
        if (v) { jl.push({ account: inv, debit: v, project_id: proj, memo: 'إرجاع من المشروع: ' + l.item.name }); jl.push({ account: getSet('acc_cogs'), credit: v, project_id: proj, memo: 'إرجاع من المشروع: ' + l.item.name }); }
      } else if (type === 'adjust') {
        // qty = الفرق (موجب زيادة، سالب عجز)
        const c = avgCost(l.item.id) || l.cost; if (l.qty < 0) needStock(l.item, wh, -l.qty);
        move(date, l.item.id, wh, l.qty, c, 'stock', id); const v = r2(Math.abs(l.qty) * c);
        if (v) {
          if (l.qty > 0) { jl.push({ account: inv, debit: v, memo: 'زيادة جرد ' + l.item.name }); jl.push({ account: getSet('acc_stock_gain'), credit: v, memo: 'زيادة جرد ' + l.item.name }); }
          else { jl.push({ account: getSet('acc_stock_loss'), debit: v, memo: 'عجز جرد ' + l.item.name }); jl.push({ account: inv, credit: v, memo: 'عجز جرد ' + l.item.name }); }
        }
      } else if (type === 'transfer') {
        if (l.qty <= 0) throw new Bad('الكمية يجب أن تكون موجبة');
        needStock(l.item, wh, l.qty); const c = avgCost(l.item.id);
        move(date, l.item.id, wh, -l.qty, c, 'stock', id); move(date, l.item.id, to, l.qty, c, 'stock', id);
      }
    }
    if (jl.length) { const jid = postJournal({ date, kind: 'stock', ref_type: 'stock', ref_id: id, memo: 'مستند مخزني ' + no + (b.memo ? ' – ' + b.memo : ''), lines: jl }, user); run('UPDATE stock_docs SET journal_id=? WHERE id=?', jid, id); }
    return id;
  });
}

/* ---------------- التقارير ---------------- */
const LIVE = "j.status='posted'";
function balances(from, to, extra, params) {
  return all(`SELECT l.account_code code, SUM(CASE WHEN j.date < ? THEN l.debit-l.credit ELSE 0 END) open,
      SUM(CASE WHEN j.date >= ? AND j.date <= ? THEN l.debit ELSE 0 END) d, SUM(CASE WHEN j.date >= ? AND j.date <= ? THEN l.credit ELSE 0 END) c
    FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE ${LIVE} AND j.date <= ? ${extra || ''} GROUP BY l.account_code`,
    from, from, to, from, to, to, ...(params || []));
}
function rollup(rows) {
  // تجميع الأرصدة على الحسابات الأب
  const accs = all('SELECT * FROM accounts ORDER BY code');
  const map = new Map(accs.map(a => [a.code, Object.assign({}, a, { open: 0, d: 0, c: 0 })]));
  for (const r of rows) {
    let a = map.get(r.code);
    while (a) { a.open += r.open || 0; a.d += r.d || 0; a.c += r.c || 0; a = a.parent ? map.get(a.parent) : null; }
  }
  return [...map.values()].map(a => Object.assign(a, { open: r2(a.open), d: r2(a.d), c: r2(a.c), close: r2(a.open + a.d - a.c) }));
}
const REPORTS = {
  trial(q) {
    const from = q.from || '1900-01-01', to = q.to || today();
    let rows = rollup(balances(from, to));
    const lvl = Number(q.level) || 0;
    if (lvl) rows = rows.filter(a => a.code.length <= lvl || (!a.is_group && a.code.length < lvl));
    rows = rows.filter(a => a.open || a.d || a.c);
    const leaf = rows.filter(a => !a.is_group || (lvl && a.code.length === lvl));
    const top = rows.filter(a => !a.parent);
    return { from, to, rows, totals: { open: r2(top.reduce((s, a) => s + a.open, 0)), d: r2(top.reduce((s, a) => s + a.d, 0)), c: r2(top.reduce((s, a) => s + a.c, 0)) }, leafCount: leaf.length };
  },
  ledger(q) {
    const a = one('SELECT * FROM accounts WHERE code=?', String(q.account || ''));
    if (!a) throw new Bad('اختر الحساب');
    const from = q.from || '1900-01-01', to = q.to || today();
    const like = a.code + '%';
    const op = one(`SELECT COALESCE(SUM(l.debit-l.credit),0) b, COALESCE(SUM(l.fc_debit-l.fc_credit),0) fb FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE ${LIVE} AND l.account_code LIKE ? AND j.date < ?`, like, from);
    const rows = all(`SELECT j.id jid, j.no, j.date, j.kind, j.ref_type, j.ref_id, j.memo jmemo, l.account_code, l.memo, l.debit, l.credit, l.currency, l.rate, l.fc_debit, l.fc_credit, p.name party, pr.name project
      FROM journal_lines l JOIN journals j ON j.id=l.journal_id LEFT JOIN parties p ON p.id=l.party_id LEFT JOIN projects pr ON pr.id=l.project_id
      WHERE ${LIVE} AND l.account_code LIKE ? AND j.date BETWEEN ? AND ? ORDER BY j.date, j.id, l.id`, like, from, to);
    let bal = r2(op.b); rows.forEach(r => { bal = r2(bal + r.debit - r.credit); r.balance = bal; });
    return { account: a, from, to, opening: r2(op.b), rows, closing: bal };
  },
  income(q) {
    const from = q.from || (today().slice(0, 4) + '-01-01'), to = q.to || today();
    const extra = q.project_id ? 'AND l.project_id=?' : ''; const ps = q.project_id ? [Number(q.project_id)] : [];
    const rows = rollup(balances(from, to, extra, ps)).filter(a => (a.type === 'revenue' || a.type === 'expense') && (a.d || a.c));
    rows.forEach(a => { a.amount = a.type === 'revenue' ? r2(a.c - a.d) : r2(a.d - a.c); });
    const rev = r2(rows.filter(a => a.type === 'revenue' && !a.parent).reduce((s, a) => s + a.amount, 0));
    const exp = r2(rows.filter(a => a.type === 'expense' && !a.parent).reduce((s, a) => s + a.amount, 0));
    return { from, to, rows, revenue: rev, expense: exp, net: r2(rev - exp) };
  },
  balance(q) {
    const to = q.to || today();
    const rows = rollup(balances('1900-01-01', to));
    const net = r2(rows.filter(a => !a.parent && (a.type === 'revenue' || a.type === 'expense')).reduce((s, a) => s - a.close, 0));
    const pick = t => rows.filter(a => a.type === t && a.close && a.code !== '2');
    const assets = pick('asset'), liab = pick('liability'), eq = pick('equity');
    const sumLeaf = (t, sign) => r2(rows.filter(a => a.type === t && !a.is_group).reduce((s, a) => s + sign * a.close, 0));
    const ta = sumLeaf('asset', 1), tl = sumLeaf('liability', -1), te = sumLeaf('equity', -1);
    return { to, assets, liabilities: liab, equity: eq, totalAssets: ta, totalLiabilities: tl, totalEquity: te, netIncome: net, check: r2(ta - tl - te - net) };
  },
  parties(q) {
    const kind = q.kind || 'customer', to = q.to || today();
    const rows = all(`SELECT p.id, p.name, p.phone, p.currency, p.kind, COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN l.debit-l.credit END),0) bal,
        COALESCE(SUM(CASE WHEN j.id IS NOT NULL AND l.currency='USD' THEN l.fc_debit-l.fc_credit END),0) usd,
        COALESCE(SUM(CASE WHEN j.id IS NOT NULL AND l.currency='IQD' THEN l.debit-l.credit END),0) iqd,
        MAX(j.date) last
      FROM parties p LEFT JOIN journal_lines l ON l.party_id=p.id LEFT JOIN journals j ON j.id=l.journal_id AND ${LIVE} AND j.date<=?
      WHERE p.kind=? OR (p.kind='both' AND ?<>'employee') GROUP BY p.id ORDER BY p.name`, to, kind, kind);
    rows.forEach(r => { r.bal = r2(r.bal); r.usd = r2(r.usd); r.iqd = r2(r.iqd); });
    // أعمار الذمم (للزبائن): الفواتير غير المسددة بطريقة الأقدم أولاً
    if (kind === 'customer' || kind === 'supplier') {
      const t = kind === 'customer' ? 'sale' : 'purchase', sign = kind === 'customer' ? 1 : -1;
      rows.forEach(r => {
        let open = sign * r.bal; const ag = { a0: 0, a30: 0, a60: 0, a90: 0 };
        for (const inv of all("SELECT date, total*rate t FROM invoices WHERE party_id=? AND type=? AND status='posted' AND date<=? ORDER BY date DESC, id DESC", r.id, t, to)) {
          if (open <= 0.009) break; const x = Math.min(open, inv.t); open -= x;
          const days = (Date.parse(to) - Date.parse(inv.date)) / 864e5;
          ag[days <= 30 ? 'a0' : days <= 60 ? 'a30' : days <= 90 ? 'a60' : 'a90'] += x;
        }
        if (open > 0.009) ag.a90 += open;
        Object.keys(ag).forEach(k => r[k] = r2(ag[k]));
      });
    }
    return { kind, to, rows };
  },
  statement(q) {
    const p = party(q.party_id); if (!p) throw new Bad('اختر الجهة');
    const from = q.from || '1900-01-01', to = q.to || today();
    const op = one(`SELECT COALESCE(SUM(l.debit-l.credit),0) b, COALESCE(SUM(CASE WHEN l.currency='USD' THEN l.fc_debit-l.fc_credit ELSE 0 END),0) u FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE ${LIVE} AND l.party_id=? AND j.date<?`, p.id, from);
    const rows = all(`SELECT j.no, j.date, j.kind, j.ref_type, j.ref_id, j.memo jmemo, l.memo, l.debit, l.credit, l.currency, l.rate, l.fc_debit, l.fc_credit, pr.name project
      FROM journal_lines l JOIN journals j ON j.id=l.journal_id LEFT JOIN projects pr ON pr.id=l.project_id WHERE ${LIVE} AND l.party_id=? AND j.date BETWEEN ? AND ? ORDER BY j.date, j.id, l.id`, p.id, from, to);
    let b = r2(op.b), u = r2(op.u); rows.forEach(r => { b = r2(b + r.debit - r.credit); if (r.currency === 'USD') u = r2(u + r.fc_debit - r.fc_credit); r.balance = b; r.usdBalance = u; });
    return { party: p, from, to, opening: r2(op.b), openingUsd: r2(op.u), rows, closing: b, closingUsd: u };
  },
  inventory(q) {
    const wh = q.warehouse_id ? Number(q.warehouse_id) : null;
    const rows = all(`SELECT i.*, COALESCE(SUM(CASE WHEN m.void=0 ${wh ? 'AND m.warehouse_id=' + wh : ''} THEN m.qty END),0) qty,
        COALESCE(SUM(CASE WHEN m.void=0 THEN m.qty END),0) tq, COALESCE(SUM(CASE WHEN m.void=0 THEN m.qty*m.unit_cost END),0) tv
      FROM items i LEFT JOIN stock_moves m ON m.item_id=i.id WHERE i.stock=1 GROUP BY i.id ORDER BY i.category, i.name`);
    rows.forEach(r => { r.qty = Math.round(r.qty * 1000) / 1000; r.avg = r.tq > 0 ? r2(r.tv / r.tq) : 0; r.value = wh ? r2(r.qty * r.tv / (r.tq || 1)) : r2(r.tv); r.low = r.min_qty != null && r.qty <= r.min_qty; });
    return { rows, total: r2(rows.reduce((s, r) => s + r.value, 0)) };
  },
  itemcard(q) {
    const it = one('SELECT * FROM items WHERE id=?', Number(q.item_id)); if (!it) throw new Bad('اختر المادة');
    const rows = all(`SELECT m.*, w.name wh, pr.name project, CASE m.ref_type WHEN 'invoice' THEN (SELECT (CASE type WHEN 'sale' THEN 'بيع ' ELSE 'شراء ' END)||no FROM invoices WHERE id=m.ref_id) ELSE (SELECT no FROM stock_docs WHERE id=m.ref_id) END doc
      FROM stock_moves m LEFT JOIN warehouses w ON w.id=m.warehouse_id LEFT JOIN projects pr ON pr.id=m.project_id WHERE m.item_id=? AND m.void=0 ORDER BY m.date, m.id`, it.id);
    let q2 = 0, v = 0; rows.forEach(r => { q2 += r.qty; v += r.qty * r.unit_cost; r.balance = Math.round(q2 * 1000) / 1000; r.value = r2(v); });
    return { item: it, rows };
  },
  projects(q) {
    const from = q.from || '1900-01-01', to = q.to || today();
    const rows = all(`SELECT p.*, c.name customer,
        COALESCE(SUM(CASE WHEN a.type='revenue' THEN l.credit-l.debit END),0) revenue,
        COALESCE(SUM(CASE WHEN a.type='expense' THEN l.debit-l.credit END),0) cost,
        COALESCE(SUM(CASE WHEN l.account_code=? THEN l.debit-l.credit END),0) materials
      FROM projects p LEFT JOIN parties c ON c.id=p.customer_id
      LEFT JOIN journal_lines l ON l.project_id=p.id LEFT JOIN journals j ON j.id=l.journal_id AND ${LIVE} AND j.date BETWEEN ? AND ?
      LEFT JOIN accounts a ON a.code=l.account_code AND j.id IS NOT NULL
      GROUP BY p.id ORDER BY p.id DESC`, getSet('acc_cogs'), from, to);
    rows.forEach(r => { r.revenue = r2(r.revenue); r.cost = r2(r.cost); r.materials = r2(r.materials); r.profit = r2(r.revenue - r.cost); r.margin = r.revenue ? Math.round((r.profit / r.revenue) * 1000) / 10 : null;
      const rec = one(`SELECT COALESCE(SUM(l.credit-l.debit),0) x FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE ${LIVE} AND l.project_id=? AND j.kind='receipt' AND l.account_code=?`, r.id, getSet('acc_customers'));
      r.collected = r2(rec.x); });
    return { from, to, rows };
  },
  sales(q) {
    const from = q.from || (today().slice(0, 7) + '-01'), to = q.to || today(), t = q.type === 'purchase' ? 'purchase' : 'sale';
    const rows = all(`SELECT i.*, p.name party, pr.name project FROM invoices i LEFT JOIN parties p ON p.id=i.party_id LEFT JOIN projects pr ON pr.id=i.project_id
      WHERE i.type=? AND i.date BETWEEN ? AND ? ORDER BY i.date, i.id`, t, from, to);
    const live = rows.filter(r => r.status === 'posted');
    return { type: t, from, to, rows, total: r2(live.reduce((s, r) => s + r.total * r.rate, 0)), count: live.length,
      byParty: all(`SELECT p.name, COUNT(*) n, SUM(i.total*i.rate) t FROM invoices i JOIN parties p ON p.id=i.party_id WHERE i.type=? AND i.status='posted' AND i.date BETWEEN ? AND ? GROUP BY p.id ORDER BY t DESC LIMIT 20`, t, from, to) };
  },
  cash(q) {
    const to = q.to || today();
    const order = String(getSet('dash_cash') || '').split(',').filter(Boolean);
    const codes = all("SELECT code,name,active FROM accounts WHERE is_group=0 AND (code LIKE '181%' OR code LIKE '183%') ORDER BY code")
      .sort((a, b) => ((order.indexOf(a.code) + 1) || 999) - ((order.indexOf(b.code) + 1) || 999));
    return { to, rows: codes.map(a => { const r = one(`SELECT COALESCE(SUM(l.debit-l.credit),0) b, COALESCE(SUM(l.fc_debit-l.fc_credit),0) f, MAX(l.currency) cur FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE ${LIVE} AND l.account_code=? AND j.date<=?`, a.code, to);
      return Object.assign(a, { balance: r2(r.b), usd: /دولار/.test(a.name) ? r2(r.f) : null }); }).filter(a => a.active || Math.abs(a.balance) > 0.004) };
  },
  dashboard() {
    const y = today().slice(0, 4) + '-01-01', m = today().slice(0, 7) + '-01', t = today();
    const inc = REPORTS.income({ from: y, to: t }), incM = REPORTS.income({ from: m, to: t });
    const cash = REPORTS.cash({ to: t });
    const rec = one(`SELECT COALESCE(SUM(l.debit-l.credit),0) x FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE ${LIVE} AND l.account_code LIKE ?`, getSet('acc_customers') + '%').x;
    const pay = one(`SELECT COALESCE(SUM(l.credit-l.debit),0) x FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE ${LIVE} AND l.account_code LIKE ?`, getSet('acc_suppliers') + '%').x;
    const inv = REPORTS.inventory({});
    const monthly = all(`SELECT substr(j.date,1,7) ym, SUM(CASE WHEN a.type='revenue' THEN l.credit-l.debit ELSE 0 END) rev, SUM(CASE WHEN a.type='expense' THEN l.debit-l.credit ELSE 0 END) exp
      FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account_code WHERE ${LIVE} AND j.date >= date(?, '-11 months', 'start of month') GROUP BY ym ORDER BY ym`, t);
    return { year: { revenue: inc.revenue, expense: inc.expense, net: inc.net }, month: { revenue: incM.revenue, expense: incM.expense, net: incM.net },
      cash: cash.rows, cashTotal: r2(cash.rows.reduce((s, r) => s + r.balance, 0)), receivables: r2(rec), payables: r2(pay), inventory: inv.total,
      lowStock: inv.rows.filter(r => r.low).map(r => ({ name: r.name, qty: r.qty, min: r.min_qty })), monthly: monthly.map(x => ({ ym: x.ym, rev: r2(x.rev), exp: r2(x.exp) })),
      recent: all(`SELECT no, date, kind, memo FROM journals WHERE status='posted' ORDER BY id DESC LIMIT 8`),
      quotesOpen: one("SELECT COUNT(*) n FROM quotations WHERE status IN ('draft','sent','accepted')").n };
  },
  audit(q) { return { rows: all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', Math.min(Number(q.limit) || 300, 2000)) }; }
};
const REPORT_PERM = { trial: 'reports', ledger: 'reports', income: 'reports', balance: 'reports', parties: 'reports.sales', statement: 'reports.sales', inventory: 'reports.store', itemcard: 'reports.store', projects: 'reports.sales', sales: 'reports.sales', cash: 'reports', dashboard: 'reports.sales', audit: 'admin' };

/* ---------------- HTTP ---------------- */
function send(res, code, obj, headers) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }, headers || {}));
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const ch = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 5e6) { reject(new Bad('الطلب كبير جداً', 413)); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (_) { reject(new Bad('بيانات غير صالحة')); } });
    req.on('error', reject);
  });
}
const clientIp = req => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
function authUser(req) {
  const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  const s = one('SELECT * FROM sessions WHERE token=?', t); if (!s) return null;
  if (Date.now() - Date.parse(s.last_seen) > SESSION_IDLE_H * 3600e3) { run('DELETE FROM sessions WHERE token=?', t); return null; }
  const u = one('SELECT id,username,name,role,active FROM users WHERE id=?', s.user_id);
  if (!u || !u.active) return null;
  if (Date.now() - Date.parse(s.last_seen) > 60e3) run('UPDATE sessions SET last_seen=? WHERE token=?', nowIso(), t);
  u.token = t; return u;
}
const routes = [];
function route(method, pattern, perm, handler) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, perm, handler });
}
function need(u, perm) { if (perm && perm !== 'auth' && !(perm === 'admin' ? u.role === 'admin' : can(u, perm))) throw new Bad('ليست لديك صلاحية لهذه العملية', 403); }

/* الإعداد الأول */
route('GET', '/api/status', null, () => ({ ok: true, setup: !one('SELECT 1 x FROM users LIMIT 1'), company: getSet('company_ar'), app: 'altaka-accounting', version: 1 }));
route('POST', '/api/setup', null, async (req) => {
  if (one('SELECT 1 x FROM users LIMIT 1')) throw new Bad('تم الإعداد مسبقاً', 403);
  const ip = clientIp(req);
  if (req.headers['cf-connecting-ip'] || !/^(::1|127\.|::ffff:127\.)/.test(ip)) throw new Bad('الإعداد الأول من الحاسبة الأم فقط (http://localhost:' + config.port + ')', 403);
  const b = await readJson(req);
  if (!b.username || String(b.password || '').length < 8) throw new Bad('اسم المستخدم وكلمة مرور من 8 أحرف على الأقل');
  run('INSERT INTO users(username,name,role,pass_hash,created_at) VALUES(?,?,?,?,?)', String(b.username).trim(), b.name || 'مدير النظام', 'admin', hashPass(b.password), nowIso());
  if (b.usd_rate) setSet('usd_rate', Number(b.usd_rate));
  audit({ username: b.username }, 'setup', 'system', '', null, ip);
  return { ok: true };
});
route('POST', '/api/login', null, async (req) => {
  const b = await readJson(req); const un = String(b.username || '').trim().toLowerCase(), ip = clientIp(req);
  if (tooMany('u:' + un) || tooMany('ip:' + ip)) throw new Bad('محاولات خاطئة كثيرة — حاول بعد 15 دقيقة', 429);
  const u = one('SELECT * FROM users WHERE username=? AND active=1', un);
  if (!u || !checkPass(b.password || '', u.pass_hash)) { fail('u:' + un); fail('ip:' + ip); throw new Bad('اسم المستخدم أو كلمة المرور غير صحيحة', 401); }
  fails.delete('u:' + un);
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token,user_id,created_at,last_seen) VALUES(?,?,?,?)', token, u.id, nowIso(), nowIso());
  audit(u, 'login', 'user', u.id, null, ip);
  return { token, user: { id: u.id, username: u.username, name: u.name, role: u.role } };
});
route('POST', '/api/logout', 'auth', (req, u) => { run('DELETE FROM sessions WHERE token=?', u.token); return { ok: true }; });
route('POST', '/api/password', 'auth', async (req, u) => {
  const b = await readJson(req); const full = one('SELECT * FROM users WHERE id=?', u.id);
  if (!checkPass(b.old || '', full.pass_hash)) throw new Bad('كلمة المرور الحالية غير صحيحة');
  if (String(b.password || '').length < 8) throw new Bad('كلمة المرور الجديدة 8 أحرف على الأقل');
  run('UPDATE users SET pass_hash=? WHERE id=?', hashPass(b.password), u.id); run('DELETE FROM sessions WHERE user_id=? AND token<>?', u.id, u.token);
  audit(u, 'password', 'user', u.id); return { ok: true };
});

/* البيانات الأساسية */
route('GET', '/api/meta', 'auth', (req, u) => {
  const s = Object.fromEntries(all('SELECT key,value FROM settings').map(r => [r.key, r.value]));
  return {
    user: { id: u.id, username: u.username, name: u.name, role: u.role, roleName: (ROLES[u.role] || {}).t, perms: (ROLES[u.role] || {}).p },
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.t])), settings: s,
    accounts: all('SELECT code,name,parent,type,is_group,active FROM accounts ORDER BY code'),
    parties: all('SELECT id,kind,name,phone,address,currency,account_code,credit_limit,notes,active FROM parties ORDER BY name'),
    items: all('SELECT * FROM items ORDER BY name'), warehouses: all('SELECT * FROM warehouses ORDER BY id'),
    projects: all('SELECT p.*, c.name customer FROM projects p LEFT JOIN parties c ON c.id=p.customer_id ORDER BY p.id DESC'), today: today()
  };
});
function upsert(table, cols, b, extraCheck) {
  const vals = cols.map(c => b[c] === '' ? null : b[c] === undefined ? null : b[c]);
  if (b.id) { run(`UPDATE ${table} SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`, ...vals, Number(b.id)); return Number(b.id); }
  return Number(run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid);
}
route('POST', '/api/accounts', 'gl', async (req, u) => {
  const b = await readJson(req); const code = String(b.code || '').trim();
  if (!/^\d{1,8}$/.test(code)) throw new Bad('رمز الحساب أرقام فقط');
  if (!b.name) throw new Bad('اسم الحساب مطلوب');
  if (!['asset', 'liability', 'equity', 'expense', 'revenue'].includes(b.type)) throw new Bad('نوع الحساب مطلوب');
  const parent = b.parent ? one('SELECT * FROM accounts WHERE code=?', String(b.parent)) : null;
  if (b.parent && !parent) throw new Bad('الحساب الأب غير موجود');
  if (parent && !parent.is_group) {
    if (one('SELECT 1 x FROM journal_lines WHERE account_code=? LIMIT 1', parent.code)) throw new Bad('الحساب الأب عليه حركات ولا يمكن أن يصبح تجميعياً');
    run('UPDATE accounts SET is_group=1 WHERE code=?', parent.code);
  }
  const ex = one('SELECT * FROM accounts WHERE code=?', code);
  if (ex) {
    if (Number(b.is_group) && !ex.is_group && one('SELECT 1 x FROM journal_lines WHERE account_code=? LIMIT 1', code)) throw new Bad('الحساب عليه حركات ولا يمكن جعله تجميعياً');
    run('UPDATE accounts SET name=?, type=?, is_group=?, active=?, notes=? WHERE code=?', b.name, b.type, Number(b.is_group) ? 1 : 0, b.active === false || b.active === 0 ? 0 : 1, b.notes || null, code);
  } else run('INSERT INTO accounts(code,name,parent,type,is_group,notes) VALUES(?,?,?,?,?,?)', code, b.name, parent ? parent.code : null, b.type, Number(b.is_group) ? 1 : 0, b.notes || null);
  audit(u, ex ? 'update' : 'create', 'account', code, b); return { ok: true };
});
route('POST', '/api/parties', 'auth', async (req, u) => {
  const b = await readJson(req);
  if (!['customer', 'supplier', 'both', 'employee', 'other'].includes(b.kind)) throw new Bad('نوع الجهة مطلوب');
  need(u, b.kind === 'supplier' ? 'purchases' : b.kind === 'customer' ? 'sales' : 'gl');
  if (!b.name) throw new Bad('الاسم مطلوب');
  if (b.account_code) account(b.account_code);
  b.currency = b.currency === 'USD' ? 'USD' : 'IQD'; b.active = b.active === false || b.active === 0 ? 0 : 1; if (!b.id) b.created_at = nowIso();
  const id = upsert('parties', ['kind', 'name', 'phone', 'address', 'currency', 'account_code', 'credit_limit', 'notes', 'active'].concat(b.id ? [] : ['created_at']), b);
  audit(u, b.id ? 'update' : 'create', 'party', id, b); return { ok: true, id };
});
route('POST', '/api/items', 'store', async (req, u) => {
  const b = await readJson(req); if (!b.name) throw new Bad('اسم المادة مطلوب');
  if (b.inv_account) account(b.inv_account); if (b.revenue_account) account(b.revenue_account);
  if (b.code && one('SELECT 1 x FROM items WHERE code=? AND id<>?', b.code, Number(b.id) || 0)) throw new Bad('رمز المادة مستخدم');
  b.stock = b.stock === false || b.stock === 0 || b.stock === '0' ? 0 : 1; b.active = b.active === false || b.active === 0 ? 0 : 1;
  if (b.id && !b.stock && one('SELECT 1 x FROM stock_moves WHERE item_id=? AND void=0 LIMIT 1', Number(b.id))) throw new Bad('للمادة حركات مخزنية ولا يمكن جعلها خدمية');
  b.unit = String(b.unit || '').trim() || 'قطعة';
  b.pack_unit = String(b.pack_unit || '').trim() || null; b.pack_qty = b.pack_unit ? Number(b.pack_qty) : null;
  if (b.pack_unit && !(b.pack_qty > 1)) throw new Bad('حدّد عدد ال' + b.unit + ' في ال' + b.pack_unit + ' (أكبر من 1)');
  const id = upsert('items', ['code', 'name', 'unit', 'category', 'stock', 'inv_account', 'revenue_account', 'sale_price', 'price_wholesale', 'price_agent', 'sale_currency', 'min_qty', 'notes', 'active', 'pack_unit', 'pack_qty'], b);
  audit(u, b.id ? 'update' : 'create', 'item', id, b); return { ok: true, id };
});
route('POST', '/api/warehouses', 'store', async (req, u) => { const b = await readJson(req); if (!b.name) throw new Bad('اسم المخزن مطلوب'); b.active = b.active === false ? 0 : 1; const id = upsert('warehouses', ['name', 'notes', 'active'], b); audit(u, 'save', 'warehouse', id, b); return { ok: true, id }; });
route('POST', '/api/projects', 'projects', async (req, u) => {
  const b = await readJson(req); if (!b.name) throw new Bad('اسم المشروع مطلوب');
  if (!b.code) b.code = nextNo('PRJ', today());
  if (one('SELECT 1 x FROM projects WHERE code=? AND id<>?', b.code, Number(b.id) || 0)) throw new Bad('رمز المشروع مستخدم');
  b.active = b.active === false ? 0 : 1; b.currency = b.currency === 'USD' ? 'USD' : 'IQD';
  const id = upsert('projects', ['code', 'name', 'customer_id', 'capacity', 'location', 'contract_value', 'currency', 'status', 'start_date', 'end_date', 'erp_ref', 'notes', 'active'], b);
  audit(u, b.id ? 'update' : 'create', 'project', id, b); return { ok: true, id };
});
route('GET', '/api/users', 'admin', () => all('SELECT id,username,name,role,active,created_at FROM users ORDER BY id'));
route('POST', '/api/users', 'admin', async (req, u) => {
  const b = await readJson(req); if (!ROLES[b.role]) throw new Bad('الدور مطلوب');
  if (b.id) {
    if (Number(b.id) === u.id && (b.role !== 'admin' || b.active === false)) throw new Bad('لا يمكنك إزالة صلاحية المدير عن حسابك');
    const old = one('SELECT username FROM users WHERE id=?', Number(b.id)); if (!old) throw new Bad('المستخدم غير موجود', 404);
    if (b.username !== undefined) {
      const un = String(b.username || '').trim();
      if (!un) throw new Bad('اسم المستخدم مطلوب');
      if (/\s/.test(un)) throw new Bad('اسم المستخدم بدون مسافات');
      if (un !== old.username) {
        if (one('SELECT 1 x FROM users WHERE username=? AND id<>?', un, Number(b.id))) throw new Bad('اسم المستخدم موجود');
        run('UPDATE users SET username=? WHERE id=?', un, Number(b.id));
        audit(u, 'rename', 'user', b.id, { from: old.username, to: un });
      }
    }
    run('UPDATE users SET name=?, role=?, active=? WHERE id=?', b.name || '', b.role, b.active === false ? 0 : 1, Number(b.id));
    if (b.password) { if (String(b.password).length < 8) throw new Bad('كلمة المرور 8 أحرف على الأقل'); run('UPDATE users SET pass_hash=? WHERE id=?', hashPass(b.password), Number(b.id)); run('DELETE FROM sessions WHERE user_id=?', Number(b.id)); }
    if (b.active === false) run('DELETE FROM sessions WHERE user_id=?', Number(b.id));
  } else {
    if (!b.username || String(b.password || '').length < 8) throw new Bad('اسم المستخدم وكلمة مرور من 8 أحرف على الأقل');
    if (one('SELECT 1 x FROM users WHERE username=?', b.username)) throw new Bad('اسم المستخدم موجود');
    run('INSERT INTO users(username,name,role,pass_hash,created_at) VALUES(?,?,?,?,?)', String(b.username).trim(), b.name || '', b.role, hashPass(b.password), nowIso());
  }
  audit(u, 'save', 'user', b.id || b.username, { role: b.role, active: b.active }); return { ok: true };
});
/* الأدوار ومهامها: عرض وتعديل وإضافة وحذف (للمدير فقط) */
const saveRoles = () => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'roles_json', JSON.stringify(ROLES));
route('GET', '/api/roles', 'admin', () => ({
  perms: PERMS.map(([k, t]) => ({ k, t })),
  roles: Object.entries(ROLES).map(([k, v]) => ({ k, t: v.t, d: v.d, p: v.p, locked: k === 'admin', users: (one('SELECT COUNT(*) n FROM users WHERE role=?', k) || {}).n || 0 }))
}));
route('POST', '/api/roles', 'admin', async (req, u) => {
  const b = await readJson(req);
  const t = String(b.t || '').trim(); if (!t) throw new Bad('اسم الدور مطلوب');
  let k = String(b.k || '').trim();
  if (!k) { k = 'role' + Date.now().toString(36); }
  if (!/^[a-z][a-z0-9_]{1,30}$/i.test(k)) throw new Bad('رمز الدور غير صالح');
  if (Object.entries(ROLES).some(([kk, v]) => kk !== k && v.t === t)) throw new Bad('يوجد دور بنفس الاسم');
  if (k === 'admin') { ROLES.admin.d = String(b.d || ROLES.admin.d); saveRoles(); audit(u, 'update', 'role', k, { d: b.d }); return { ok: true, k }; }
  const p = Array.isArray(b.p) ? [...new Set(b.p.filter(x => PERM_KEYS.includes(x)))] : [];
  const isNew = !ROLES[k];
  ROLES[k] = { t, d: String(b.d || '').trim(), p };
  saveRoles(); audit(u, isNew ? 'create' : 'update', 'role', k, { t, p }); return { ok: true, k };
});
route('POST', '/api/roles/:k/delete', 'admin', async (req, u, url, pr) => {
  const k = decodeURIComponent(pr.k);
  if (!ROLES[k]) throw new Bad('الدور غير موجود', 404);
  if (k === 'admin') throw new Bad('لا يمكن حذف دور مدير النظام');
  const n = (one('SELECT COUNT(*) n FROM users WHERE role=?', k) || {}).n || 0;
  if (n) throw new Bad(`لا يمكن حذف الدور لأنه مسند إلى ${n} مستخدم — غيّر دورهم أولاً`);
  delete ROLES[k]; saveRoles(); audit(u, 'delete', 'role', k, {}); return { ok: true };
});
route('POST', '/api/roles/reset', 'admin', async (req, u) => {
  const used = all('SELECT DISTINCT role FROM users').map(r => r.role).filter(r => !DEFAULT_ROLES[r]);
  if (used.length) throw new Bad('توجد أدوار مضافة مسندة لمستخدمين، غيّر دورهم أولاً');
  run('DELETE FROM settings WHERE key=?', 'roles_json'); loadRoles(); audit(u, 'reset', 'role', '*', {}); return { ok: true };
});
const SETTABLE = ['company_ar', 'company_en', 'company_address', 'company_phone', 'usd_rate', 'lock_date', 'invoice_terms', 'quote_terms'].concat(Object.keys({ acc_customers: 1, acc_suppliers: 1, acc_advances: 1, acc_cash_iqd: 1, acc_cash_usd: 1, acc_bank_iqd: 1, acc_bank_usd: 1, acc_sales: 1, acc_services: 1, acc_cogs: 1, acc_inventory: 1, acc_discount_allowed: 1, acc_discount_earned: 1, acc_tax: 1, acc_stock_loss: 1, acc_stock_gain: 1, acc_opening: 1, acc_purchases_service: 1 }));
route('POST', '/api/settings', 'admin', async (req, u) => {
  const b = await readJson(req);
  tx(() => { for (const k of SETTABLE) if (b[k] !== undefined) { if (k.startsWith('acc_') && b[k]) account(b[k]); if (k === 'lock_date' && b[k] && !/^\d{4}-\d{2}-\d{2}$/.test(b[k])) throw new Bad('تاريخ القفل غير صحيح'); setSet(k, b[k]); } });
  if (b.usd_rate) run('INSERT INTO rates(date,currency,rate) VALUES(?,?,?) ON CONFLICT(date,currency) DO UPDATE SET rate=excluded.rate', today(), 'USD', Number(b.usd_rate));
  audit(u, 'update', 'settings', '', b); return { ok: true };
});

/* المستندات */
const listQ = (table, q, extra, ps) => {
  const from = q.from || '1900-01-01', to = q.to || '9999-12-31';
  return all(`SELECT d.*, p.name party, pr.name project FROM ${table} d LEFT JOIN parties p ON p.id=d.party_id LEFT JOIN projects pr ON pr.id=d.project_id WHERE d.date BETWEEN ? AND ? ${extra || ''} ORDER BY d.date DESC, d.id DESC LIMIT 1000`, from, to, ...(ps || []));
};
/* البحث العام: الفواتير + الزبائن + الموردون (حسب صلاحيات المستخدم) */
route('GET', '/api/search', 'auth', (req, u, url) => {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 60); if (q.length < 2) return { q, invoices: [], parties: [], quotes: [] };
  const like = '%' + q.replace(/[%_]/g, '') + '%', types = [];
  if (can(u, 'sales')) types.push('sale'); if (can(u, 'purchases')) types.push('purchase');
  const invoices = types.length ? all(`SELECT DISTINCT d.id, d.type, d.no, d.date, d.total, d.currency, d.status, pa.name party FROM invoices d LEFT JOIN parties pa ON pa.id=d.party_id
    LEFT JOIN invoice_lines l ON l.invoice_id=d.id WHERE d.type IN (${types.map(() => '?').join(',')}) AND (d.no LIKE ? OR pa.name LIKE ? OR pa.phone LIKE ? OR d.notes LIKE ? OR d.supplier_ref LIKE ? OR l.description LIKE ?)
    ORDER BY d.date DESC, d.id DESC LIMIT 60`, ...types, like, like, like, like, like, like) : [];
  const kinds = []; if (can(u, 'sales')) kinds.push('customer'); if (can(u, 'purchases')) kinds.push('supplier'); if (kinds.length) kinds.push('both');
  const parties = kinds.length ? all(`SELECT id, kind, name, phone, address FROM parties WHERE kind IN (${kinds.map(() => '?').join(',')}) AND (name LIKE ? OR phone LIKE ? OR address LIKE ?) ORDER BY name LIMIT 40`, ...kinds, like, like, like) : [];
  const quotes = can(u, 'sales') ? all(`SELECT d.id, d.no, d.date, d.total, d.currency, d.status, COALESCE(pa.name, d.customer_name) party FROM quotations d LEFT JOIN parties pa ON pa.id=d.party_id
    WHERE d.no LIKE ? OR pa.name LIKE ? OR d.customer_name LIKE ? OR d.customer_phone LIKE ? ORDER BY d.date DESC LIMIT 30`, like, like, like, like) : [];
  return { q, invoices, parties, quotes };
});
route('GET', '/api/invoices', 'auth', (req, u, url) => { const q = Object.fromEntries(url.searchParams); const t = q.type === 'purchase' ? 'purchase' : 'sale'; need(u, t === 'sale' ? 'sales' : 'purchases');
  return listQ('invoices', q, 'AND d.type=?' + (q.party_id ? ' AND d.party_id=' + Number(q.party_id) : '') + (q.project_id ? ' AND d.project_id=' + Number(q.project_id) : ''), [t]); });
route('GET', '/api/invoices/:id', 'auth', (req, u, url, p) => {
  const d = one('SELECT d.*, pa.name party, pa.phone party_phone, pa.address party_address, pr.name project, w.name warehouse FROM invoices d LEFT JOIN parties pa ON pa.id=d.party_id LEFT JOIN projects pr ON pr.id=d.project_id LEFT JOIN warehouses w ON w.id=d.warehouse_id WHERE d.id=?', Number(p.id));
  if (!d) throw new Bad('غير موجود', 404); need(u, d.type === 'sale' ? 'sales' : 'purchases');
  d.lines = all('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id', d.id);
  d.paid = r2((one("SELECT COALESCE(SUM(amount*rate),0) x FROM vouchers WHERE invoice_id=? AND status='posted'", d.id) || {}).x / (d.rate || 1));
  return d;
});
route('POST', '/api/invoices', 'auth', async (req, u) => { const b = await readJson(req); need(u, b.type === 'purchase' ? 'purchases' : 'sales'); const id = createInvoice(b, u); audit(u, 'create', 'invoice', id, { type: b.type, total: b.lines && b.lines.length }); return { ok: true, id }; });
route('POST', '/api/invoices/:id/void', 'void', async (req, u, url, p) => { const b = await readJson(req); const d = voidDoc('invoices', p.id, b.reason, u); audit(u, 'void', 'invoice', d.no, { reason: b.reason }); return { ok: true }; });

route('GET', '/api/quotations', 'sales', (req, u, url) => listQ('quotations', Object.fromEntries(url.searchParams)));
route('GET', '/api/quotations/:id', 'sales', (req, u, url, p) => { const d = one('SELECT d.*, pa.name party, pa.phone party_phone, pr.name project FROM quotations d LEFT JOIN parties pa ON pa.id=d.party_id LEFT JOIN projects pr ON pr.id=d.project_id WHERE d.id=?', Number(p.id)); if (!d) throw new Bad('غير موجود', 404); d.lines = JSON.parse(d.lines || '[]'); return d; });
route('POST', '/api/quotations', 'sales', async (req, u) => {
  const b = await readJson(req);
  if (!b.party_id && !b.customer_name) throw new Bad('اختر الزبون أو اكتب اسمه');
  const lines = cleanLines(b.lines); if (!lines.length) throw new Bad('أضف سطراً واحداً على الأقل');
  lines.forEach(l => { l.total = l.pack_unit ? r2(l.pack_count * l.pack_price) : r2(l.qty * l.unit_price); if (!l.description && l.item_id) l.description = (one('SELECT name FROM items WHERE id=?', l.item_id) || {}).name || ''; });
  const sub = r2(lines.reduce((s, l) => s + l.total, 0)), disc = r2(b.discount);
  const cur = b.currency === 'USD' ? 'USD' : 'IQD';
  const row = { date: b.date || today(), valid_until: b.valid_until || null, party_id: b.party_id || null, customer_name: b.customer_name || null, customer_phone: b.customer_phone || null, project_id: b.project_id || null, currency: cur, rate: rateOf(cur, b.rate), lines: JSON.stringify(lines), subtotal: sub, discount: disc, total: r2(sub - disc), terms: b.terms || null, status: ['draft', 'sent', 'accepted', 'rejected'].includes(b.status) ? b.status : 'draft', updated_at: nowIso() };
  let id = Number(b.id) || 0;
  if (id) { const ex = one('SELECT status FROM quotations WHERE id=?', id); if (!ex) throw new Bad('غير موجود', 404); if (ex.status === 'invoiced') throw new Bad('عرض السعر محوّل إلى فاتورة ولا يُعدَّل');
    run(`UPDATE quotations SET ${Object.keys(row).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(row), id); }
  else { row.no = nextNo('QT', row.date); row.created_by = u.username; row.created_at = nowIso(); id = Number(run(`INSERT INTO quotations(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row)).lastInsertRowid); }
  audit(u, b.id ? 'update' : 'create', 'quotation', id, { status: row.status, total: row.total }); return { ok: true, id };
});

route('GET', '/api/vouchers', 'gl', (req, u, url) => { const q = Object.fromEntries(url.searchParams); return listQ('vouchers', q, q.type ? 'AND d.type=?' : '', q.type ? [q.type] : []).map(v => Object.assign(v, { counter_name: (one('SELECT name FROM accounts WHERE code=?', v.counter_account) || {}).name, cash_name: (one('SELECT name FROM accounts WHERE code=?', v.cash_account) || {}).name })); });
route('GET', '/api/vouchers/:id', 'gl', (req, u, url, p) => { const v = one('SELECT d.*, pa.name party, pr.name project, a.name counter_name, c.name cash_name FROM vouchers d LEFT JOIN parties pa ON pa.id=d.party_id LEFT JOIN projects pr ON pr.id=d.project_id LEFT JOIN accounts a ON a.code=d.counter_account LEFT JOIN accounts c ON c.code=d.cash_account WHERE d.id=?', Number(p.id)); if (!v) throw new Bad('غير موجود', 404); return v; });
route('POST', '/api/vouchers', 'gl', async (req, u) => { const b = await readJson(req); const id = createVoucher(b, u); audit(u, 'create', 'voucher', id, { type: b.type, amount: b.amount, currency: b.currency }); return { ok: true, id }; });
route('POST', '/api/vouchers/:id/void', 'void', async (req, u, url, p) => { const b = await readJson(req); const d = voidDoc('vouchers', p.id, b.reason, u); audit(u, 'void', 'voucher', d.no, { reason: b.reason }); return { ok: true }; });

route('GET', '/api/journals', 'gl', (req, u, url) => { const q = Object.fromEntries(url.searchParams); return all(`SELECT j.*, (SELECT SUM(debit) FROM journal_lines WHERE journal_id=j.id) total FROM journals j WHERE j.date BETWEEN ? AND ? ${q.kind ? 'AND j.kind=?' : ''} ORDER BY j.date DESC, j.id DESC LIMIT 1000`, q.from || '1900-01-01', q.to || '9999-12-31', ...(q.kind ? [q.kind] : [])); });
route('GET', '/api/journals/:id', 'gl', (req, u, url, p) => { const j = one('SELECT * FROM journals WHERE id=?', Number(p.id)); if (!j) throw new Bad('غير موجود', 404); j.lines = all('SELECT l.*, a.name account_name, pa.name party, pr.name project FROM journal_lines l JOIN accounts a ON a.code=l.account_code LEFT JOIN parties pa ON pa.id=l.party_id LEFT JOIN projects pr ON pr.id=l.project_id WHERE journal_id=? ORDER BY l.id', j.id); return j; });
route('POST', '/api/journals', 'gl', async (req, u) => { const b = await readJson(req); const id = createManualJournal(b, u); audit(u, 'create', 'journal', id, { memo: b.memo }); return { ok: true, id }; });
route('POST', '/api/journals/:id/void', 'void', async (req, u, url, p) => {
  const b = await readJson(req); const j = one('SELECT * FROM journals WHERE id=?', Number(p.id)); if (!j) throw new Bad('غير موجود', 404);
  if (!['manual', 'opening'].includes(j.kind)) throw new Bad('هذا القيد ناتج عن مستند — ألغِ المستند نفسه');
  if (j.status === 'void') throw new Bad('ملغى مسبقاً'); checkDate(j.date); voidJournal(j.id, b.reason); audit(u, 'void', 'journal', j.no, { reason: b.reason }); return { ok: true };
});

route('GET', '/api/stock', 'store', (req, u, url) => { const q = Object.fromEntries(url.searchParams); return all(`SELECT d.*, w.name warehouse, t.name to_warehouse, pr.name project FROM stock_docs d LEFT JOIN warehouses w ON w.id=d.warehouse_id LEFT JOIN warehouses t ON t.id=d.to_warehouse_id LEFT JOIN projects pr ON pr.id=d.project_id WHERE d.date BETWEEN ? AND ? ORDER BY d.date DESC, d.id DESC LIMIT 1000`, q.from || '1900-01-01', q.to || '9999-12-31'); });
route('GET', '/api/stock/:id', 'store', (req, u, url, p) => { const d = one('SELECT d.*, w.name warehouse, t.name to_warehouse, pr.name project FROM stock_docs d LEFT JOIN warehouses w ON w.id=d.warehouse_id LEFT JOIN warehouses t ON t.id=d.to_warehouse_id LEFT JOIN projects pr ON pr.id=d.project_id WHERE d.id=?', Number(p.id)); if (!d) throw new Bad('غير موجود', 404); d.lines = all('SELECT m.*, i.name item, i.unit FROM stock_moves m JOIN items i ON i.id=m.item_id WHERE m.ref_type=? AND m.ref_id=? ORDER BY m.id', 'stock', d.id); return d; });
route('POST', '/api/stock', 'store', async (req, u) => { const b = await readJson(req); const id = createStockDoc(b, u); audit(u, 'create', 'stock', id, { type: b.type }); return { ok: true, id }; });
route('POST', '/api/stock/:id/void', 'void', async (req, u, url, p) => { const b = await readJson(req); const d = voidDoc('stock_docs', p.id, b.reason, u); audit(u, 'void', 'stock', d.no, { reason: b.reason }); return { ok: true }; });
route('GET', '/api/stock-level', 'auth', (req, u, url) => { const q = Object.fromEntries(url.searchParams); const s = stockState(Number(q.item_id), q.warehouse_id ? Number(q.warehouse_id) : null); return Object.assign(s, { avg: r2(avgCost(Number(q.item_id))) }); });

route('GET', '/api/reports/:name', 'auth', (req, u, url, p) => {
  const fn = REPORTS[p.name]; if (!fn) throw new Bad('تقرير غير معروف', 404);
  need(u, REPORT_PERM[p.name] || 'reports');
  return fn(Object.fromEntries(url.searchParams));
});

/* النسخ الاحتياطي */
function backup(tag) {
  const f = path.join(BACKUPS, `accounting-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}${tag ? '-' + tag : ''}.db`);
  db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  const files = fs.readdirSync(BACKUPS).filter(x => x.endsWith('.db')).sort();
  while (files.length > 60) fs.unlinkSync(path.join(BACKUPS, files.shift()));
  if (getSet('backup_dir')) try { fs.copyFileSync(f, path.join(getSet('backup_dir'), path.basename(f))); } catch (_) {}
  return f;
}
route('POST', '/api/backup', 'admin', (req, u) => { const f = backup('manual'); audit(u, 'backup', 'system', path.basename(f)); return { ok: true, file: path.basename(f) }; });
route('GET', '/api/backups', 'admin', () => fs.readdirSync(BACKUPS).filter(x => x.endsWith('.db')).sort().reverse().map(f => ({ file: f, size: fs.statSync(path.join(BACKUPS, f)).size })));
setInterval(() => { const d = today(); if (getSet('last_backup') !== d) { try { backup('auto'); setSet('last_backup', d); } catch (e) { console.error('backup failed', e.message); } } }, 30 * 60e3).unref();

/* الملفات الثابتة */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PUB = path.join(ROOT, 'public');
function serveStatic(res, p) {
  const f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
  if (!f.startsWith(PUB)) return send(res, 403, {});
  fs.readFile(f, (e, buf) => {
    if (e) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p); if (!m) continue;
        const params = {}; r.keys.forEach((k, i) => params[k] = m[i + 1]);
        let u = null;
        if (r.perm) { u = authUser(req); if (!u) return send(res, 401, { error: 'unauthorized', message: 'انتهت الجلسة — سجّل الدخول مجدداً' }); need(u, r.perm); }
        const out = await r.handler(req, u, url, params);
        return send(res, 200, out === undefined ? { ok: true } : out);
      }
      return send(res, 404, { error: 'not_found' });
    }
    if (req.method !== 'GET') return send(res, 405, {});
    return serveStatic(res, p);
  } catch (e) {
    if (e instanceof Bad) return send(res, e.status, { error: 'bad', message: e.message });
    console.error(e);
    return send(res, 500, { error: 'server_error', message: 'خطأ في الخادم: ' + (e.message || e) });
  }
});
if (require.main === module) {
  server.listen(config.port, '0.0.0.0', () => {
    const os = require('os');
    console.log('\n ALTAKA-ALWATANIYAH — برنامج الحسابات');
    console.log(' يعمل على: http://localhost:' + config.port);
    Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).forEach(i => console.log(' في الشبكة: http://' + i.address + ':' + config.port));
    console.log(' البيانات: ' + DATA + '\n');
  });
}
module.exports = { server, db, REPORTS };
