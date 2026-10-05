const MODULES = ['Dashboard','Users','Buyers','Sellers','Seller KYC','Stores','Products','Product Approvals','Orders','Payments','Withdrawals','Refunds','Reviews','Support Center','Notifications','Website CMS','Analytics','Coupons & Promotions','Audit Logs','Roles & Permissions','Settings'];
const ACTIONS = ['View','Create','Edit','Delete','Approve','Reject','Export','Manage'];
const STATES = ['allowed','restricted','inherited','none'];
const HIGH_RISK = new Set(['Users:Delete','Withdrawals:Approve','Payments:Manage','Refunds:Manage','Roles & Permissions:Manage','Audit Logs:Delete']);

const granted = s => s === 'allowed' || s === 'inherited';
const cells = fn => { for (const m of MODULES) for (const a of ACTIONS) fn(m, a); };
const fullMatrix = state => { const o = {}; MODULES.forEach(m => { o[m] = {}; ACTIONS.forEach(a => { o[m][a] = state; }); }); return o; };
const sanitizeMatrix = (inp = {}) => { const o = fullMatrix('none'); cells((m, a) => { const s = inp?.[m]?.[a]; if (STATES.includes(s)) o[m][a] = s; }); return o; };
const mergeMatrix = (base, ov = {}) => { const o = sanitizeMatrix(base); cells((m, a) => { const s = ov?.[m]?.[a]; if (STATES.includes(s)) o[m][a] = s; }); return o; };
const diffOverrides = (base, want) => { const o = {}; cells((m, a) => { if (base[m][a] !== want[m][a]) (o[m] = o[m] || {})[a] = want[m][a]; }); return o; };
const overrideLabels = (ov = {}) => { const out = []; cells((m, a) => { const s = ov?.[m]?.[a]; if (STATES.includes(s)) out.push(`${m} · ${a}${s === 'allowed' ? '' : ` (${s})`}`); }); return out.slice(0, 12); };
const stats = mx => { let g = 0, i = 0, h = 0; cells((m, a) => { const s = mx[m][a]; if (granted(s)) g++; if (s === 'inherited') i++; if (granted(s) && HIGH_RISK.has(`${m}:${a}`)) h++; }); return { granted: g, inherited: i, highRisk: h }; };
const securityLevel = st => st.highRisk >= 3 ? 'High' : st.highRisk >= 1 ? 'Moderate' : st.granted > 0 ? 'Limited' : 'Restricted';
const diff = (a, b) => { const A = sanitizeMatrix(a), B = sanitizeMatrix(b); let added = 0, removed = 0, modified = 0;
  cells((m, x) => { if (A[m][x] === B[m][x]) return; const ga = granted(A[m][x]), gb = granted(B[m][x]);
    if (gb && !ga) added++; else if (ga && !gb) removed++; else modified++; }); return { added, removed, modified }; };

module.exports = { MODULES, ACTIONS, STATES, HIGH_RISK, granted, fullMatrix, sanitizeMatrix, mergeMatrix, diffOverrides, overrideLabels, stats, securityLevel, diff };
