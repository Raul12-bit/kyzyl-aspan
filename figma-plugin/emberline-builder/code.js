// Emberline Builder — local Figma development plugin.
// Finishes the "Emberline — NASA Space Apps 2026" design file that was started via Figma MCP:
//   alpha     – fixes semi-transparent fills (variable-bound SOLID paints ignore paint.opacity,
//               so translucent colors get their own "alpha/*" variables in the Theme collection)
//   layout    – tidies the Screens page (rows + labels)
//   analysis  – 04 · Analysis (burn calendar, before/after swipe, seasonal profile, key figures)
//   how       – 05 · How it works (3 steps + limitations)
//   mobile    – 07a–c mobile Intro / Map / Analysis
//   motion    – 6-frame storyboard with timings + auto-playing Smart Animate prototype
//   ideas     – Ideas backlog
//   prototype – clickable desktop + mobile flows
// Every builder removes the frame it owns (matched by exact name) before rebuilding, so re-running is safe.
// All demo numbers are generated deterministically and labelled "demo data" — they are NOT real measurements.

'use strict';

// ---------------------------------------------------------------- IDs from the existing file
const IDS = {
  pages: { ds: '0:1', screens: '3:2', motion: '3:3' },
  sets: { button: '6:85', iconButton: '6:114', chip: '6:139', toggle: '6:151', layerRow: '6:197', segment: '6:207', tooltip: '6:232', stat: '6:251', legend: '6:288', search: '6:324', trust: '6:358', navTab: '6:371' },
  comps: { basemap: '7:83', harm: '7:3200', modis: '7:3799', viirs: '7:3970', globe: '7:4872', logo: '7:7544', topbar: '8:76', timeline: '8:114' },
  icons: { search: '4:390', layers: '4:397', 'box-select': '4:404', pin: '4:411', play: '4:417', pause: '4:423', info: '4:430', close: '4:436', 'chevron-right': '4:442', 'chevron-down': '4:448', 'arrow-right': '4:454', 'arrow-left': '4:460', satellite: '4:467', flame: '4:473', alert: '4:480', download: '4:486', sparkles: '4:493', calendar: '4:500', refresh: '4:507', help: '4:514', globe: '4:522', plus: '4:528', minus: '4:534', compare: '4:540', map: '4:547', share: '4:556', 'shield-check': '4:563', crosshair: '4:570' },
  screens: { intro: '8:465', map: '8:745', region: '9:310', loading: '9:604', empty: '9:850', error: '9:1103', onboarding: '9:1351', ctaStart: '8:726', ctaHow: '8:731', ctaAnalyze: '9:594', areaCard: '9:541' },
};
const NAMES = {
  analysis: '04 · Analysis', how: '05 · How it works',
  mIntro: '07a · Mobile — Intro', mMap: '07b · Mobile — Map', mAnalysis: '07c · Mobile — Analysis',
};
const FONTS = [['Sora', 'SemiBold'], ['Geist', 'Regular'], ['Geist', 'Medium'], ['Geist Mono', 'Regular'], ['Geist Mono', 'Medium']].map(([family, style]) => ({ family, style }));
const MS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------- context
const V = {}; const VBYID = {}; const TS = {}; const ES = {};
let THEME = null; let THEME_MODE = null;

async function init() {
  const vars = await figma.variables.getLocalVariablesAsync();
  for (const v of vars) { V[v.name] = v; VBYID[v.id] = v; }
  if (!V['bg/canvas']) throw new Error('Emberline variables not found — open the Emberline file first.');
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  THEME = cols.find(c => c.name === 'Theme');
  THEME_MODE = THEME.modes[0].modeId;
  for (const s of await figma.getLocalTextStylesAsync()) TS[s.name] = s;
  for (const s of await figma.getLocalEffectStylesAsync()) ES[s.name] = s;
  await Promise.all(FONTS.map(f => figma.loadFontAsync(f)));
}

// ---------------------------------------------------------------- tokens
function resolveColor(v) {
  let val = v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  let guard = 0;
  while (val && val.type === 'VARIABLE_ALIAS' && guard++ < 10) {
    const t = VBYID[val.id];
    val = t.valuesByMode[Object.keys(t.valuesByMode)[0]];
  }
  return val;
}
// A Figma SOLID paint keeps alpha in paint.opacity, and a bound COLOR variable drives it,
// so translucency must live in the variable itself. alphaVar() creates (once) "alpha/<token>-<pct>".
function alphaVar(baseName, a) {
  const pct = Math.round(a * 100);
  const name = `alpha/${baseName.replace(/\//g, '-')}-${pct}`;
  if (V[name]) return V[name];
  const base = V[baseName];
  if (!base) throw new Error(`Unknown token ${baseName}`);
  const c = resolveColor(base);
  const v = figma.variables.createVariable(name, THEME, 'COLOR');
  v.setValueForMode(THEME_MODE, { r: c.r, g: c.g, b: c.b, a: (c.a === undefined ? 1 : c.a) * a });
  v.scopes = ['FRAME_FILL', 'SHAPE_FILL', 'STROKE_COLOR'];
  v.description = `${baseName} at ${pct}% alpha (generated)`;
  V[name] = v; VBYID[v.id] = v;
  return v;
}
function paint(name, a = 1) {
  const v = a < 1 ? alphaVar(name, a) : V[name];
  if (!v) throw new Error(`Unknown token ${name}`);
  return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v);
}
const hexOf = name => resolveColor(V[name]);
function stop(name, pos) { const c = hexOf(name); return { position: pos, color: { r: c.r, g: c.g, b: c.b, a: 1 }, boundVariables: { color: figma.variables.createVariableAlias(V[name]) } }; }
function fireGrad(tr = [[1, 0, 0], [0, 1, 0]]) { return { type: 'GRADIENT_LINEAR', gradientTransform: tr, gradientStops: [stop('accent/fire-start', 0), stop('accent/fire-mid', 0.55), stop('accent/fire-end', 1)] }; }
const VGRAD = [[0, 1, 0], [-1, 0, 1]]; // top → bottom

function sp(node, o) {
  let { p, px, py, pt, pb, pl, pr, gap } = o;
  if (p !== undefined) { px = p; py = p; }
  if (px !== undefined) { pl = px; pr = px; }
  if (py !== undefined) { pt = py; pb = py; }
  for (const [f, val] of [['paddingLeft', pl], ['paddingRight', pr], ['paddingTop', pt], ['paddingBottom', pb], ['itemSpacing', gap]]) {
    if (val === undefined) continue;
    const v = V['space/' + val];
    if (!v) throw new Error(`No spacing token space/${val}`);
    node.setBoundVariable(f, v);
  }
}
function rad(node, r, corners = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) { for (const f of corners) node.setBoundVariable(f, V['radius/' + r]); }
function strk(node, name, a = 1, w = 'hairline') { node.strokes = [paint(name, a)]; node.strokeAlign = 'INSIDE'; node.setBoundVariable('strokeWeight', V['stroke/' + w]); }
async function fx(node, style) { await node.setEffectStyleIdAsync(ES[style].id); }
async function glass(node, r = 'xl') { node.fills = [paint('bg/glass')]; strk(node, 'border/default'); rad(node, r); await fx(node, 'Blur/Glass'); }

// ---------------------------------------------------------------- nodes
async function txt(chars, style, color = 'text/primary', w) {
  const t = figma.createText();
  await t.setTextStyleIdAsync(TS[style].id);
  t.characters = chars;
  t.fills = [paint(color)];
  if (w) { t.resize(w, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
}
function AL(dir = 'HORIZONTAL', name) {
  const f = figma.createFrame();
  f.layoutMode = dir; f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO';
  f.fills = []; f.clipsContent = false;
  if (name) f.name = name;
  return f;
}
function COL(name, w) { const f = AL('VERTICAL', name); f.resize(w, 10); f.counterAxisSizingMode = 'FIXED'; f.primaryAxisSizingMode = 'AUTO'; return f; }
function add(parent, child, h, v) { parent.appendChild(child); if (h) child.layoutSizingHorizontal = h; if (v) child.layoutSizingVertical = v; return child; }
function spacer() { const s = AL('HORIZONTAL', 'Spacer'); return s; }
const N = id => figma.getNodeByIdAsync(id);

function setProps(i, props) {
  const keys = Object.keys(i.componentProperties);
  const p = {};
  for (const [k, v] of Object.entries(props)) {
    const kk = keys.find(x => x.split('#')[0] === k);
    if (kk) p[kk] = (typeof v === 'string' && v.startsWith('ICON:')) ? IDS.icons[v.slice(5)] : v;
  }
  if (Object.keys(p).length) i.setProperties(p);
}
async function inst(setKey, variant, props = {}) {
  const s = await N(IDS.sets[setKey]);
  const c = s.children.find(c => c.name === variant) || s.defaultVariant;
  const i = c.createInstance();
  setProps(i, props);
  return i;
}
async function cInst(key) { return (await N(IDS.comps[key])).createInstance(); }
async function icon(name, color = 'text/primary', size = 20) {
  const i = (await N(IDS.icons[name])).createInstance();
  i.resize(size, size);
  for (const n of i.findAll(n => 'strokes' in n && n.strokes.length)) n.strokes = [paint(color)];
  return i;
}
function svg(body, w, h, name) {
  const s = figma.createNodeFromSvg(`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
  s.name = name; s.fills = []; s.clipsContent = false;
  return s;
}
function tint(root, { fill, stroke, a = 1 }) {
  for (const n of root.findAll(() => true)) {
    if (fill && 'fills' in n && Array.isArray(n.fills) && n.fills.length) n.fills = [paint(fill, a)];
    if (stroke && 'strokes' in n && n.strokes.length) n.strokes = [paint(stroke, a)];
  }
  return root;
}
function removeByName(parent, name) { for (const n of parent.children.filter(c => c.name === name)) n.remove(); }
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const sgn = (v, d = 0) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);

async function segmented(labels, sel, name = 'Segmented') {
  const s = AL('HORIZONTAL', name); sp(s, { p: 4, gap: 4 }); s.fills = [paint('bg/elevated')]; strk(s, 'border/subtle'); rad(s, 'pill');
  for (let i = 0; i < labels.length; i++) s.appendChild(await inst('segment', i === sel ? 'State=Selected' : 'State=Default', { Label: labels[i] }));
  return s;
}
async function plainNote(text, w) {
  const n = AL('HORIZONTAL', 'Plain words'); sp(n, { px: 12, py: 12, gap: 8 }); n.counterAxisAlignItems = 'MIN';
  n.fills = [paint('accent/primary', 0.08)]; strk(n, 'accent/primary', 0.3); rad(n, 'md');
  n.appendChild(await icon('sparkles', 'text/accent', 16));
  const t = await txt(text, 'Body/S', 'text/secondary', w - 50); add(n, t, 'FILL');
  return n;
}
async function topBar(active) {
  const tb = (await N(IDS.comps.topbar)).createInstance();
  const set = await N(IDS.sets.navTab);
  const act = set.children.find(c => c.name === 'State=Active');
  const def = set.children.find(c => c.name === 'State=Default');
  for (const t of tb.findAll(n => n.type === 'INSTANCE' && n.name.startsWith('Tab · '))) {
    const label = t.name.slice(6);
    t.swapComponent(label === active ? act : def);
    setProps(t, { Label: label });
  }
  return tb;
}

// ---------------------------------------------------------------- demo data (same RNG sequence as the Map timeline)
function makeData() {
  let seed = 7;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const SEASON = [.02, .03, .12, .55, .45, .18, .32, .85, 1, .6, .12, .03];
  const YEARS = [...Array(25)].map((_, i) => 2001 + i);
  const YF = YEARS.map(y => (0.55 + rnd() * 0.8) * (y === 2008 ? 1.7 : y === 2017 ? 1.55 : y === 2021 ? 1.45 : 1) * (1 + (y - 2001) * 0.012));
  const D = YEARS.map((y, yi) => SEASON.map(s => Math.round(420 * s * YF[yi] * (0.7 + rnd() * 0.6))));
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  // Make Aug 2021 a clear anomaly (the example used in tooltips).
  const augBase = D.slice(0, 20).map(r => r[7]);
  D[20][7] = Math.max(D[20][7], Math.round(mean(augBase) + 2.6 * sd(augBase)));
  const anomalies = [];
  for (let m = 0; m < 12; m++) {
    const base = D.slice(0, 20).map(r => r[m]); const mu = mean(base); const s = sd(base) || 1;
    for (let y = 0; y < 25; y++) { const z = (D[y][m] - mu) / s; if (z > 2 && D[y][m] >= 20) anomalies.push({ y, m, z }); }
  }
  anomalies.sort((a, b) => b.z - a.z);
  const top = anomalies.slice(0, 6);
  if (!top.find(a => a.y === 20 && a.m === 7)) top.push(anomalies.find(a => a.y === 20 && a.m === 7));
  const H = D.map(r => r.reduce((s, x) => s + x, 0));
  const MOD = H.map((h, i) => Math.round(h * (0.95 + rnd() * 0.07)));
  const VIR = H.map((h, i) => i >= 11 ? Math.round(h * 3.6 * (0.92 + rnd() * 0.16)) : null);
  const band = H.map((h, i) => (i < 11 ? 0.08 : i <= 21 ? 0.06 : i === 22 ? 0.12 : i === 23 ? 0.15 : 0.18));
  const med = [...Array(12)].map((_, m) => q(D.map(r => r[m]), 0.5));
  const p25 = [...Array(12)].map((_, m) => q(D.map(r => r[m]), 0.25));
  const p75 = [...Array(12)].map((_, m) => q(D.map(r => r[m]), 0.75));
  const peak = med.indexOf(Math.max(...med));
  // log-linear trend
  const xs = H.map((_, i) => i), ys = H.map(h => Math.log(h)); const mx = mean(xs), my = mean(ys);
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0); const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
  const sse = ys.reduce((s, y, i) => s + (y - (my + b * (xs[i] - mx))) ** 2, 0); const se = Math.sqrt(sse / (xs.length - 2) / sxx);
  const pct = x => (Math.exp(x) - 1) * 100;
  const trend = { mid: pct(b), lo: pct(b - 1.714 * se), hi: pct(b + 1.714 * se) };
  const vs = (H[24] / q(H.slice(0, 24), 0.5) - 1) * 100;
  const aug21 = { h: D[20][7], ci: Math.round(D[20][7] * 0.06), modis: Math.round(D[20][7] * 0.96), viirs: Math.round(D[20][7] * 3.6), z: top.find(a => a.y === 20 && a.m === 7).z };
  const ratio = mean(VIR.slice(11, 24).map((v, i) => v / MOD[11 + i]));
  return { YEARS, D, H, MOD, VIR, band, med, p25, p75, peak, trend, vs, anomalies: top, aug21, ratio };
}
const LV = v => v < 5 ? 0 : v < 20 ? 1 : v < 50 ? 2 : v < 150 ? 3 : v < 400 ? 4 : v < 1000 ? 5 : 6;
const seasonName = p => `${MS[(p + 11) % 12]}–${MS[(p + 1) % 12]}`;

// ---------------------------------------------------------------- reusable data-viz pieces
async function burnCalendar(d, W, { cell = 4, rowH = 34, labelW = 40, compact = false } = {}) {
  const pitch = (W - labelW) / 25; const cw = pitch - cell; const ch = rowH - cell; const top = compact ? 0 : 24;
  const g = figma.createFrame(); g.name = 'Grid · 12 months × 25 years'; g.fills = []; g.clipsContent = false; g.resize(W, top + 12 * rowH + 22);
  for (let m = 0; m < 12; m++) { const t = await txt(compact ? MS[m][0] : MS[m], 'Data/S', 'text/muted'); t.x = 0; t.y = top + m * rowH + (ch - 14) / 2; g.appendChild(t); }
  for (let y = 0; y < 25; y++) {
    if (!compact || y % 6 === 0 || y === 24) { const t = await txt(compact ? `’${String(2001 + y).slice(2)}` : `’${String(2001 + y).slice(2)}`, 'Data/S', y >= 11 ? 'text/secondary' : 'text/muted'); t.x = labelW + y * pitch; t.y = top + 12 * rowH + 4; g.appendChild(t); }
    for (let m = 0; m < 12; m++) {
      const v = d.D[y][m]; const lv = LV(v);
      const r = figma.createRectangle(); r.name = `${MS[m]} ${2001 + y} · ${v}`; r.resize(cw, ch); r.x = labelW + y * pitch; r.y = top + m * rowH;
      r.fills = [paint('heat/' + lv)]; rad(r, compact ? 'xs' : 'xs');
      if (!compact && lv >= 5) await fx(r, 'Glow/Ember');
      if (d.anomalies.find(a => a.y === y && a.m === m)) { r.strokes = [paint('status/anomaly')]; r.strokeWeight = compact ? 1.5 : 2; r.strokeAlign = 'OUTSIDE'; r.name += ' · anomaly'; }
      g.appendChild(r);
    }
  }
  const mk = figma.createRectangle(); mk.name = 'VIIRS joins marker'; mk.resize(1, top + 12 * rowH - 2); mk.x = labelW + 11 * pitch - cell / 2 - 0.5; mk.y = compact ? 0 : 4; mk.fills = [paint('sensor/viirs', 0.8)]; g.appendChild(mk);
  if (!compact) { const t = await txt('VIIRS joins · Jan 2012 — harmonized scale keeps the series continuous', 'Data/S', 'sensor/viirs'); t.x = mk.x + 8; t.y = 0; g.appendChild(t); }
  return { g, pitch, cw, ch, top, labelW };
}

async function harmonizedChart(d, PW, PH, { swipe = true, swipeYear = 2016 } = {}) {
  const f = figma.createFrame(); f.name = 'Plot'; f.resize(PW, PH); f.fills = []; f.clipsContent = false;
  const x0 = 52, x1 = PW - 8, y0 = 12, y1 = PH - 28;
  const yMax = Math.max(...d.VIR.filter(v => v)) * 1.1;
  const X = i => x0 + i * (x1 - x0) / 24; const Y = v => y1 - v / yMax * (y1 - y0);
  let gl = ''; const ticks = 4;
  for (let k = 0; k <= ticks; k++) gl += `<line x1="${x0}" y1="${Y(yMax * k / ticks).toFixed(1)}" x2="${x1}" y2="${Y(yMax * k / ticks).toFixed(1)}" stroke="#fff"/>`;
  f.appendChild(tint(svg(gl, PW, PH, 'Gridlines'), { stroke: 'border/subtle' }));
  for (let k = 0; k <= ticks; k++) { const t = await txt(fmt(Math.round(yMax * k / ticks / 100) * 100), 'Data/S', 'text/muted'); t.x = 0; t.y = Y(yMax * k / ticks) - 7; f.appendChild(t); }
  for (const yr of [2001, 2005, 2009, 2013, 2017, 2021, 2025]) { const t = await txt(String(yr), 'Data/S', 'text/muted'); t.x = X(yr - 2001) - 14; t.y = y1 + 10; f.appendChild(t); }
  const path = (arr, from = 0) => arr.map((v, i) => (i < from || v == null) ? null : `${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).filter(Boolean).map((p, i) => (i ? 'L' : 'M') + p).join(' ');
  const line = (arr, from, color, w, name, a = 1, dash) => tint(svg(`<path d="${path(arr, from)}" stroke="#fff" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`, PW, PH, name), { stroke: color, a });
  const up = d.H.map((h, i) => `${X(i).toFixed(1)} ${Y(h * (1 + d.band[i])).toFixed(1)}`);
  const lo = d.H.map((h, i) => `${X(i).toFixed(1)} ${Y(h * (1 - d.band[i])).toFixed(1)}`).reverse();
  const bandSvg = () => tint(svg(`<path d="M${up.join(' L')} L${lo.join(' L')} Z" fill="#fff"/>`, PW, PH, '90% uncertainty band'), { fill: 'sensor/uncertainty' });
  const harmLine = () => line(d.H, 0, 'sensor/harmonized', 2.5, 'Harmonized (MODIS-eq.)');
  if (!swipe) { f.appendChild(bandSvg()); f.appendChild(line(d.VIR, 11, 'sensor/viirs', 1.5, 'VIIRS raw (ghost)', 0.3)); f.appendChild(harmLine()); return f; }
  const sx = X(swipeYear - 2001);
  const left = figma.createFrame(); left.name = 'Before · raw sensors'; left.resize(sx, PH); left.fills = []; left.clipsContent = true; f.appendChild(left);
  left.appendChild(line(d.MOD, 0, 'sensor/modis', 2, 'MODIS raw'));
  left.appendChild(line(d.VIR, 11, 'sensor/viirs', 2, 'VIIRS raw'));
  left.appendChild(line(d.H.map((h, i) => i < 11 ? d.MOD[i] : d.VIR[i]), 10, 'text/muted', 1.5, 'Naive merge (wrong)', 1, '4 4'));
  const right = figma.createFrame(); right.name = 'After · harmonized'; right.resize(PW - sx, PH); right.x = sx; right.fills = []; right.clipsContent = true; f.appendChild(right);
  for (const n of [bandSvg(), line(d.VIR, 11, 'sensor/viirs', 1.5, 'VIIRS raw (ghost)', 0.25), harmLine()]) { right.appendChild(n); n.x = -sx; }
  const jx = X(11), jy = Y(d.VIR[11]);
  const ann = AL('HORIZONTAL', 'Annotation · 2012 jump'); sp(ann, { px: 8, py: 4 }); ann.fills = [paint('bg/overlay')]; strk(ann, 'sensor/viirs', 0.5); rad(ann, 'sm');
  ann.appendChild(await txt(`×${d.ratio.toFixed(1)} jump = new sensor, not more fire`, 'Data/S', 'sensor/viirs')); f.appendChild(ann); ann.x = Math.max(x0, jx - 140); ann.y = Math.max(0, jy - 34);
  const hl = figma.createRectangle(); hl.name = 'Swipe line'; hl.resize(2, PH - 16); hl.x = sx - 1; hl.y = 0; hl.fills = [paint('text/primary')]; f.appendChild(hl);
  const knob = AL('HORIZONTAL', 'Swipe handle'); knob.resize(36, 36); knob.primaryAxisSizingMode = 'FIXED'; knob.counterAxisSizingMode = 'FIXED'; knob.primaryAxisAlignItems = 'CENTER'; knob.counterAxisAlignItems = 'CENTER';
  knob.fills = [paint('bg/overlay')]; strk(knob, 'text/primary', 1, 'focus'); rad(knob, 'pill'); await fx(knob, 'Elevation/2'); knob.appendChild(await icon('compare', 'text/primary', 18)); f.appendChild(knob); knob.x = sx - 18; knob.y = (y0 + y1) / 2 - 18;
  const lb = await inst('chip', 'Kind=Neutral', { Label: '← Raw · not comparable', 'Show dot': false }); f.appendChild(lb); lb.x = sx - lb.width - 12; lb.y = y0;
  const rb = await inst('chip', 'Kind=Harmonized', { Label: 'Harmonized · MODIS-eq. →' }); f.appendChild(rb); rb.x = sx + 12; rb.y = y0;
  return f;
}

async function seasonalChart(d, PW, PH) {
  const f = figma.createFrame(); f.name = 'Plot'; f.resize(PW, PH); f.fills = []; f.clipsContent = false;
  const x0 = 8, x1 = PW - 8, y0 = 8, y1 = PH - 24; const pitch = (x1 - x0) / 12; const bw = pitch * 0.56;
  const yMax = Math.max(...d.p75, ...d.D[24]) * 1.1; const Y = v => y1 - v / yMax * (y1 - y0);
  const base = figma.createRectangle(); base.name = 'Baseline'; base.resize(x1 - x0, 1); base.x = x0; base.y = y1; base.fills = [paint('border/default')]; f.appendChild(base);
  for (let m = 0; m < 12; m++) {
    const cx = x0 + m * pitch + pitch / 2;
    const b = figma.createRectangle(); b.name = `${MS[m]} · median`; const h = Math.max(2, y1 - Y(d.med[m])); b.resize(bw, h); b.x = cx - bw / 2; b.y = y1 - h; b.fills = [fireGrad(VGRAD)]; rad(b, 'xs', ['topLeftRadius', 'topRightRadius']); if (m !== d.peak) b.opacity = 0.75; f.appendChild(b);
    const w = figma.createRectangle(); w.name = `${MS[m]} · IQR`; const wh = Math.max(1, Y(d.p25[m]) - Y(d.p75[m])); w.resize(2, wh); w.x = cx - 1; w.y = Y(d.p75[m]); w.fills = [paint('text/secondary', 0.6)]; f.appendChild(w);
    const dot = figma.createEllipse(); dot.name = `${MS[m]} · 2025`; dot.resize(9, 9); dot.x = cx - 4.5; dot.y = Y(d.D[24][m]) - 4.5; dot.fills = [paint('text/primary')]; dot.strokes = [paint('bg/surface')]; dot.strokeWeight = 2; dot.strokeAlign = 'OUTSIDE'; f.appendChild(dot);
    const t = await txt(MS[m][0], 'Data/S', m === d.peak ? 'text/accent' : 'text/muted'); t.x = cx - 4; t.y = y1 + 8; f.appendChild(t);
  }
  const pk = await txt(`Peak · ${MS[d.peak]}`, 'Data/S', 'text/accent'); pk.x = x0 + d.peak * pitch + pitch / 2 - 22; pk.y = Math.max(0, Y(d.p75[d.peak]) - 20); f.appendChild(pk);
  return f;
}

function statsFor(d) {
  return [
    ['Default', 'Detections in 2025', fmt(d.H[24]), `± ${fmt(d.H[24] * d.band[24])} · MODIS-eq.`, 'Hot-pixel detections, not a count of individual fires.'],
    ['Fire', 'Peak month', MS[d.peak], `season ${seasonName(d.peak)}`, 'Spring stubble burning and late-summer grass fires.'],
    ['Default', '25-year trend', `${sgn(d.trend.mid, 1)}%/yr`, `90% CI ${sgn(d.trend.lo, 1)} … ${sgn(d.trend.hi, 1)}`, 'Direction is clear; single years swing a lot.'],
    ['Cool', 'VIIRS ÷ MODIS', `${d.ratio.toFixed(1)}×`, 'fitted on 2012–2024 overlap', 'Why raw VIIRS counts look 3–4× higher here.'],
  ];
}

// ================================================================ 1 · alpha fix
async function fixAlpha() {
  const done = [];
  const set = (node, prop, token, a) => { if (!node) return; node[prop] = [paint(token, a)]; done.push(node.id); };
  const find = (root, name) => root ? root.findOne(n => n.name === name) : null;
  const findAll = (root, name) => root ? root.findAll(n => n.name === name) : [];
  // components (Design System page)
  const chip = await N(IDS.sets.chip); set(chip.children.find(c => c.name === 'Kind=Selected'), 'fills', 'accent/primary', 0.14);
  const trust = await N(IDS.sets.trust);
  for (const c of trust.children) {
    const tok = { 'Level=High': 'status/success', 'Level=Medium': 'status/warning', 'Level=Low': 'status/danger' }[c.name]; const bars = { 'Level=High': 3, 'Level=Medium': 2, 'Level=Low': 1 }[c.name];
    set(c, 'fills', tok, 0.12); set(c, 'strokes', tok, 0.5);
    const meter = find(c, 'Meter'); if (meter) meter.children.forEach((r, i) => set(r, 'fills', tok, i < bars ? 1 : 0.25));
  }
  set(find(await N(IDS.sets.tooltip), 'Anomaly'), 'fills', 'status/anomaly', 0.12);
  const lr = await N(IDS.sets.layerRow);
  for (const c of lr.children) if (c.name.includes('State=Off')) { const s = c.name.match(/Sensor=(\w+)/)[1]; set(find(c, 'Dot'), 'fills', { MODIS: 'sensor/modis', VIIRS: 'sensor/viirs', Harmonized: 'sensor/harmonized' }[s], 0.35); }
  const stat = await N(IDS.sets.stat);
  set(stat.children.find(c => c.name === 'Tone=Fire'), 'strokes', 'accent/primary', 0.5);
  set(stat.children.find(c => c.name === 'Tone=Cool'), 'strokes', 'accent/cool', 0.5);
  // map assets
  const vecIn = (root, frameName) => { const fr = find(root, frameName); return fr ? fr.findAll(n => n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION' || n.type === 'ELLIPSE') : []; };
  for (const n of vecIn(await N(IDS.comps.basemap), 'Land dots')) set(n, 'fills', 'text/muted', 0.42);
  for (const n of vecIn(await N(IDS.comps.harm), 'Glow')) set(n, 'fills', 'accent/fire-mid', 0.55);
  for (const n of vecIn(await N(IDS.comps.harm), 'Core')) set(n, 'fills', 'accent/fire-start', 0.95);
  for (const n of vecIn(await N(IDS.comps.modis), 'Points')) set(n, 'fills', 'sensor/modis', 0.9);
  for (const n of vecIn(await N(IDS.comps.viirs), 'Points')) set(n, 'fills', 'sensor/viirs', 0.75);
  const globe = await N(IDS.comps.globe);
  for (const fr of globe.children.filter(c => c.name.startsWith('Land · limb'))) { const a = fr.name.includes('0.05') ? 0.18 : fr.name.includes('0.35') ? 0.36 : 0.6; for (const n of fr.findAll(n => n.type !== 'FRAME')) set(n, 'fills', 'text/muted', a); }
  for (const n of vecIn(globe, 'Fire glow')) set(n, 'fills', 'accent/fire-mid', 0.6);
  set(find(globe, 'Rim light'), 'strokes', 'accent/cool', 0.35);
  set(find(await N(IDS.comps.logo), 'Orbit'), 'strokes', 'accent/cool', 0.7);
  const ds = await N(IDS.pages.ds); await ds.loadAsync();
  const spacing = ds.findOne(n => n.name === 'Spacing scale'); if (spacing) for (const r of spacing.findAll(n => n.type === 'RECTANGLE')) set(r, 'fills', 'accent/cool', 0.8);
  // screens
  const intro = await N(IDS.screens.intro);
  for (const n of vecIn(intro, 'Starfield')) set(n, 'fills', 'text/primary', 0.55);
  set(find(intro, 'Callout ring'), 'strokes', 'text/primary', 0.8); set(find(intro, 'Callout line'), 'strokes', 'text/primary', 0.5);
  // callout was clipped at the right edge → flip it to the left of the ring
  const ring = find(intro, 'Callout ring'), cline = find(intro, 'Callout line'), cbox = find(intro, 'Callout');
  if (ring && cline && cbox) { cline.x = ring.x - 120; cbox.x = cline.x - cbox.width - 4; }
  for (const id of ['map', 'region', 'loading', 'empty', 'error', 'onboarding']) {
    const s = await N(IDS.screens[id]);
    for (const note of findAll(s, 'Note · detection')) { set(note, 'fills', 'status/info', 0.08); set(note, 'strokes', 'status/info', 0.3); }
    for (const dv of findAll(s, 'Divider')) set(dv, 'fills', 'border/subtle');
  }
  const region = await N(IDS.screens.region);
  set(find(region, 'Selection box'), 'fills', 'accent/cool', 0.06);
  const dim = find(region, 'Outside dim'); if (dim) dim.children.forEach(r => set(r, 'fills', 'bg/canvas', 0.45));
  set(find(await N(IDS.screens.empty), 'Selection box (ocean)'), 'fills', 'accent/cool', 0.06);
  const er = await N(IDS.screens.error);
  set(find(er, 'Toast · error'), 'strokes', 'status/danger', 0.6); set(find(er, 'Gap marker'), 'fills', 'status/danger', 0.14);
  const ob = await N(IDS.screens.onboarding); set(find(ob, 'Coach mark · 1/3'), 'strokes', 'accent/cool', 0.6);
  // area card: make numbers consistent with the analysis data
  const d = makeData(); const card = await N(IDS.screens.areaCard);
  if (card) {
    const big = card.findOne(n => n.type === 'TEXT' && n.characters === '3 940'); if (big) big.characters = fmt(d.H[24]);
    const small = card.findOne(n => n.type === 'TEXT' && n.characters.startsWith('± ')); if (small) small.characters = `± ${fmt(d.H[24] * d.band[24])} detections in 2025`;
    const spark = find(card, 'Annual sparkline');
    if (spark) { const mx = Math.max(...d.H); spark.children.forEach((b, i) => { const h = Math.max(3, d.H[i] / mx * 44); b.resize(b.width, h); b.y = 48 - h; b.fills = [paint('sensor/harmonized', i >= 11 ? 1 : 0.55)]; }); }
  }
  return `${done.length} paints rebound`;
}

// ================================================================ 2 · Screens layout
async function tidyScreens() {
  const page = await N(IDS.pages.screens); await figma.setCurrentPageAsync(page);
  for (const id of ['loading', 'empty', 'error', 'onboarding']) { const s = await N(IDS.screens[id]); if (s && s.y === 1300) s.y = 2300; }
  for (const n of page.children.filter(c => c.name.startsWith('Row label · '))) n.remove();
  for (const [label, y, note] of [['Desktop · main flow', -160, 'Intro → Map → Area selected → Analysis → How it works. Prototype starts at 01 · Intro.'], ['States', 2140, 'Loading · Empty · Error · First visit — all on the Map screen.'], ['Mobile · 390 × 844', 3540, 'Intro · Map with bottom sheet · Analysis (scroll).']]) {
    const g = AL('VERTICAL', 'Row label · ' + label); sp(g, { gap: 4 }); page.appendChild(g); g.x = 0; g.y = y;
    g.appendChild(await txt(label, 'Display/L', 'text/primary')); g.appendChild(await txt(note, 'Body/L', 'text/muted'));
  }
  return 'ok';
}

// ================================================================ 3 · Analysis (desktop)
async function buildAnalysis() {
  const page = await N(IDS.pages.screens); await figma.setCurrentPageAsync(page);
  removeByName(page, NAMES.analysis);
  const d = makeData();
  const f = figma.createFrame(); f.name = NAMES.analysis; f.resize(1440, 2400); f.x = 4620; f.y = 0; f.fills = [paint('bg/canvas')]; f.clipsContent = true; page.appendChild(f);
  const col = COL('Content', 1344); sp(col, { gap: 24 }); f.appendChild(col); col.x = 48; col.y = 96;
  // header
  const head = AL('HORIZONTAL', 'Header'); head.counterAxisAlignItems = 'MAX'; add(col, head, 'FILL');
  const ht = AL('VERTICAL', 'Title'); sp(ht, { gap: 8 }); add(head, ht, 'FILL');
  const crumb = AL('HORIZONTAL', 'Back to map'); sp(crumb, { gap: 6 }); crumb.counterAxisAlignItems = 'CENTER'; ht.appendChild(crumb);
  crumb.appendChild(await icon('arrow-left', 'text/muted', 16)); crumb.appendChild(await txt('Map', 'Label/M', 'text/muted')); crumb.appendChild(await txt('/', 'Label/M', 'text/disabled')); crumb.appendChild(await txt('Area analysis', 'Label/M', 'text/secondary'));
  ht.appendChild(await txt('Northern Kazakhstan steppe', 'Heading/H1'));
  ht.appendChild(await txt('48–55°N · 55–75°E · ≈1.08M km² · 2001–2025 · MODIS-equivalent scale · demo data', 'Data/M', 'text/muted'));
  const actions = AL('HORIZONTAL', 'Actions'); sp(actions, { gap: 8 }); actions.counterAxisAlignItems = 'CENTER'; head.appendChild(actions);
  actions.appendChild(await segmented(['Expert', '✦ Simple'], 1, 'Mode · Expert / Simple'));
  actions.appendChild(await inst('button', 'Type=Secondary, State=Default', { Label: 'Export CSV', Icon: 'ICON:download' }));
  actions.appendChild(await inst('button', 'Type=Ghost, State=Default', { Label: 'Share', Icon: 'ICON:share' }));
  // 10-second summary
  const sum = AL('HORIZONTAL', '10-second summary'); sp(sum, { p: 24, gap: 24 }); sum.counterAxisAlignItems = 'CENTER'; await glass(sum); add(col, sum, 'FILL');
  const bar = figma.createRectangle(); bar.name = 'Accent'; bar.resize(4, 76); bar.fills = [fireGrad(VGRAD)]; rad(bar, 'pill'); sum.appendChild(bar);
  const st = AL('VERTICAL', 'Text'); sp(st, { gap: 6 }); add(sum, st, 'FILL');
  st.appendChild(await txt('In 10 seconds', 'Label/Overline', 'text/accent'));
  const vsTxt = `${sgn(d.vs, 0)}%`; const trTxt = d.trend.lo > 0 ? `rising (${sgn(d.trend.mid, 1)}%/yr)` : d.trend.hi < 0 ? `falling (${sgn(d.trend.mid, 1)}%/yr)` : 'flat within uncertainty';
  add(st, await txt(`Fire activity here peaks in ${seasonName(d.peak)}. 2025 was ${vsTxt} vs the 2001–2024 median, and the 25-year trend is ${trTxt}.`, 'Heading/H3', 'text/primary', 960), 'FILL');
  add(st, await txt('Based on satellite hot-pixel detections from two sensors, rescaled to one MODIS-equivalent scale — never added together.', 'Body/M', 'text/muted', 960), 'FILL');
  const tr = AL('VERTICAL', 'Trust'); sp(tr, { gap: 6 }); tr.counterAxisAlignItems = 'MAX'; sum.appendChild(tr);
  tr.appendChild(await inst('trust', 'Level=High'));
  tr.appendChild(await txt('13 yrs overlap · band ±6–18%', 'Data/S', 'text/muted'));
  // key figures
  const stats = AL('HORIZONTAL', 'Key figures'); sp(stats, { gap: 16 }); add(col, stats, 'FILL');
  for (const [tone, l, v, dl, c] of statsFor(d)) { const s = await inst('stat', `Tone=${tone}`, { Label: l, Value: v, Delta: dl, Caption: c }); add(stats, s, 'FILL', 'FILL'); }
  // burn calendar
  const cal = COL('Burn calendar', 1344); sp(cal, { p: 24, gap: 20 }); cal.fills = [paint('bg/surface')]; strk(cal, 'border/subtle'); rad(cal, 'xl'); add(col, cal, 'FILL');
  const ch = AL('HORIZONTAL', 'Head'); ch.counterAxisAlignItems = 'MAX'; sp(ch, { gap: 16 }); add(cal, ch, 'FILL');
  const cht = AL('VERTICAL', 'Title'); sp(cht, { gap: 4 }); add(ch, cht, 'FILL');
  cht.appendChild(await txt('Burn calendar', 'Heading/H2')); cht.appendChild(await txt('Harmonized detections per month · each column is one year · brighter = more detections', 'Body/M', 'text/muted'));
  const chr = AL('HORIZONTAL', 'Controls'); sp(chr, { gap: 12 }); chr.counterAxisAlignItems = 'CENTER'; ch.appendChild(chr);
  chr.appendChild(await inst('chip', 'Kind=Anomaly', { Label: 'Unusual month (> 2σ)' }));
  chr.appendChild(await segmented(['Harmonized', 'MODIS raw', 'VIIRS raw'], 0, 'Source'));
  chr.appendChild(await inst('legend', 'Kind=Heat'));
  const cw = 1296; const { g, pitch, top, labelW, cw: cellW } = await burnCalendar(d, cw);
  add(cal, g);
  const tip = await inst('tooltip', 'Kind=Data'); g.appendChild(tip);
  const texts = tip.findAll(n => n.type === 'TEXT');
  const rep = { '412 ± 58': `${fmt(d.aug21.h)} ± ${fmt(d.aug21.ci)}`, '318': fmt(d.aug21.modis), '1 204': fmt(d.aug21.viirs), 'Unusual: +2.4σ vs 2001–2020': `Unusual: +${d.aug21.z.toFixed(1)}σ vs 2001–2020` };
  for (const t of texts) if (rep[t.characters]) t.characters = rep[t.characters];
  tip.x = labelW + 20 * pitch + cellW + 10; tip.y = top + 7 * 34 - 60;
  add(cal, await plainNote('Each square is one month. Brighter means more fire detections. Teal outlines mark months that were unusually high for that time of year — like August 2021. Dim columns before 2012 come from MODIS only; that is fine, because everything is on the MODIS scale.', 1296), 'FILL');
  // charts row
  const row = AL('HORIZONTAL', 'Charts'); sp(row, { gap: 16 }); add(col, row, 'FILL');
  const hc = COL('Before / after harmonization', 864); sp(hc, { p: 24, gap: 16 }); hc.fills = [paint('bg/surface')]; strk(hc, 'border/subtle'); rad(hc, 'xl'); add(row, hc, 'FILL', 'FILL');
  const hh = AL('HORIZONTAL', 'Head'); hh.counterAxisAlignItems = 'MIN'; add(hc, hh, 'FILL');
  const hht = AL('VERTICAL', 'Title'); sp(hht, { gap: 4 }); add(hh, hht, 'FILL');
  hht.appendChild(await txt('Before / after harmonization', 'Heading/H3')); hht.appendChild(await txt('Annual detections · drag the handle', 'Body/S', 'text/muted'));
  hh.appendChild(await inst('legend', 'Kind=Sensors'));
  add(hc, await harmonizedChart(d, 816, 320));
  add(hc, await plainNote(`Left of the handle: raw counts. VIIRS makes it look like fire jumped ×${d.ratio.toFixed(1)} in 2012 — only the satellite changed. Right: both sensors on one MODIS-equivalent scale, with a 90% band that widens where we lean on the conversion.`, 816), 'FILL');
  const sc = COL('Seasonal profile', 464); sp(sc, { p: 24, gap: 16 }); sc.fills = [paint('bg/surface')]; strk(sc, 'border/subtle'); rad(sc, 'xl'); add(row, sc, undefined, 'FILL');
  sc.appendChild(await txt('Seasonal profile', 'Heading/H3')); sc.appendChild(await txt('Bars: typical year (median) · whiskers: middle 50% of years · dots: 2025', 'Body/S', 'text/muted', 416));
  add(sc, await seasonalChart(d, 416, 300));
  add(sc, await plainNote('Two fire seasons: spring stubble burning and a bigger late-summer peak.', 416), 'FILL');
  // method & sources
  const ms = AL('HORIZONTAL', 'Method & sources'); sp(ms, { p: 24, gap: 24 }); ms.counterAxisAlignItems = 'CENTER'; ms.fills = [paint('bg/surface')]; strk(ms, 'border/subtle'); rad(ms, 'xl'); add(col, ms, 'FILL');
  ms.appendChild(await icon('satellite', 'accent/cool', 24));
  add(ms, await txt('Detections: NASA FIRMS archive — MODIS Collection 6.1 (Terra & Aqua, 1 km) and VIIRS 375 m (S-NPP, NOAA-20). Harmonization: VIIRS counts rescaled to a MODIS-equivalent scale with a ratio fitted per region and month over the 2012–2024 overlap; 90% interval by bootstrap over overlap months. Numbers on this mockup are demo data.', 'Body/S', 'text/muted', 980), 'FILL');
  ms.appendChild(await inst('button', 'Type=Ghost, State=Default', { Label: 'Methodology', Icon: 'ICON:arrow-right' }));
  f.resize(1440, Math.max(1024, col.y + col.height + 64));
  const tb = await topBar('Analysis'); f.appendChild(tb); tb.x = 0; tb.y = 0;
  return `analysis ${Math.round(f.height)}px`;
}

// ================================================================ 4 · How it works
async function buildHow() {
  const page = await N(IDS.pages.screens); await figma.setCurrentPageAsync(page);
  removeByName(page, NAMES.how);
  const f = figma.createFrame(); f.name = NAMES.how; f.resize(1440, 1600); f.x = 6160; f.y = 0; f.fills = [paint('bg/canvas')]; f.clipsContent = true; page.appendChild(f);
  const col = COL('Content', 1344); sp(col, { gap: 40 }); f.appendChild(col); col.x = 48; col.y = 136;
  const hero = AL('VERTICAL', 'Intro'); sp(hero, { gap: 12 }); hero.counterAxisAlignItems = 'CENTER'; add(col, hero, 'FILL');
  hero.appendChild(await txt('How it works', 'Label/Overline', 'text/accent'));
  hero.appendChild(await txt('Two satellites, one honest scale', 'Display/L'));
  const sub = await txt('MODIS has watched fires since 2000. VIIRS joined in 2012 with a sharper eye. Their raw counts can’t be compared — so we translate one into the other and show how sure we are.', 'Body/L', 'text/secondary', 720); sub.textAlignHorizontal = 'CENTER'; hero.appendChild(sub);
  const steps = AL('HORIZONTAL', 'Steps'); sp(steps, { gap: 24 }); add(col, steps, 'FILL');
  const step = async (n, title, body, plain, illus) => {
    const c = COL(`Step ${n}`, 432); sp(c, { p: 24, gap: 16 }); c.fills = [paint('bg/surface')]; strk(c, 'border/subtle'); rad(c, 'xl'); add(steps, c, 'FILL', 'FILL');
    const il = figma.createFrame(); il.name = 'Illustration'; il.resize(384, 248); il.fills = [paint('bg/elevated')]; rad(il, 'lg'); il.clipsContent = true; add(c, il, 'FILL'); await illus(il);
    const num = AL('HORIZONTAL', 'Number'); sp(num, { px: 12, py: 4 }); num.fills = [paint('accent/primary', 0.14)]; rad(num, 'pill'); num.appendChild(await txt(`Step ${n}`, 'Data/S', 'text/accent')); c.appendChild(num);
    add(c, await txt(title, 'Heading/H2'), 'FILL');
    add(c, await txt(body, 'Body/M', 'text/secondary', 384), 'FILL');
    add(c, await plainNote(plain, 384), 'FILL');
  };
  // Step 1 — pixel footprints
  await step(1, 'Why VIIRS sees more', 'VIIRS pixels are 375 m wide — about 7× smaller in area than MODIS’s 1 km. It catches smaller, cooler fires and splits one big fire into many detections.', 'Same fire, sharper camera → more dots. More dots ≠ more fire.', async il => {
    const blob = { cx: 76, cy: 78, rx: 42, ry: 26 };
    const inBlob = (x, y) => ((x - blob.cx) / blob.rx) ** 2 + ((y - blob.cy) / blob.ry) ** 2 <= 1;
    const panel = async (x0, n, sensor, label) => {
      const p = figma.createFrame(); p.name = label; p.resize(160, 160); p.x = x0; p.y = 20; p.fills = [paint('bg/surface')]; p.clipsContent = true; il.appendChild(p);
      const glow = figma.createEllipse(); glow.name = 'Fire'; glow.resize(blob.rx * 2, blob.ry * 2); glow.x = blob.cx - blob.rx; glow.y = blob.cy - blob.ry; glow.rotation = 0; glow.fills = [paint('accent/fire-mid', 0.55)]; await fx(glow, 'Blur/Heat'); p.appendChild(glow);
      const core = figma.createEllipse(); core.name = 'Fire core'; core.resize(36, 20); core.x = blob.cx - 18; core.y = blob.cy - 10; core.fills = [paint('accent/fire-start', 0.9)]; await fx(core, 'Blur/Heat'); p.appendChild(core);
      const s = 160 / n; let flagged = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        let hits = 0; for (const a of [0.25, 0.5, 0.75]) for (const b of [0.25, 0.5, 0.75]) if (inBlob((i + a) * s, (j + b) * s)) hits++;
        const r = figma.createRectangle(); r.name = 'Pixel'; r.resize(s, s); r.x = i * s; r.y = j * s; r.fills = []; r.strokes = [paint('border/default')]; r.strokeWeight = 1; r.strokeAlign = 'INSIDE';
        if (hits >= 3) { flagged++; r.fills = [paint(sensor, 0.28)]; r.strokes = [paint(sensor)]; r.name = 'Pixel · detection'; }
        p.appendChild(r);
      }
      const t = await txt(`${label}`, 'Data/S', sensor); t.x = x0; t.y = 190; il.appendChild(t);
      const c = await txt(`${flagged} detections`, 'Data/M', 'text/primary'); c.x = x0; c.y = 208; il.appendChild(c);
    };
    await panel(24, 4, 'sensor/modis', 'MODIS · 1 km');
    await panel(200, 11, 'sensor/viirs', 'VIIRS · 375 m');
  });
  // Step 2 — overlap fit
  await step(2, 'One scale, not one sum', 'Where both satellites watched the same place (2012–2024), we learn how many VIIRS detections equal one MODIS detection — per region and season. Then every month, back to 2001, is expressed on the MODIS-equivalent scale.', 'Like converting miles to kilometres before comparing. We never add the two sensors together.', async il => {
    const W = 200, H = 180, x0 = 32, y0 = 20; let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    let dots = '';
    for (let i = 0; i < 40; i++) { const mx = 0.05 + rnd() * 0.9; const vy = Math.min(1, mx * (0.85 + rnd() * 0.3)); dots += `<circle cx="${(mx * W).toFixed(1)}" cy="${(H - vy * H).toFixed(1)}" r="3"/>`; }
    const pts = tint(svg(dots, W, H, 'Overlap months'), { fill: 'sensor/viirs', a: 0.85 }); il.appendChild(pts); pts.x = x0; pts.y = y0;
    const fit = tint(svg(`<path d="M0 ${H} L${W} 0" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`, W, H, 'Fitted ratio'), { stroke: 'sensor/harmonized' }); il.appendChild(fit); fit.x = x0; fit.y = y0;
    const ax = tint(svg(`<path d="M0 0 V${H} H${W}" stroke="#fff"/>`, W, H, 'Axes'), { stroke: 'border/strong' }); il.appendChild(ax); ax.x = x0; ax.y = y0;
    const xl = await txt('MODIS / month →', 'Data/S', 'sensor/modis'); xl.x = x0; xl.y = y0 + H + 8; il.appendChild(xl);
    const yl = await txt('VIIRS ↑', 'Data/S', 'sensor/viirs'); yl.x = 8; yl.y = 4; il.appendChild(yl);
    const eq = AL('VERTICAL', 'Conversion'); sp(eq, { p: 12, gap: 6 }); eq.fills = [paint('bg/surface')]; strk(eq, 'border/default'); rad(eq, 'md'); il.appendChild(eq); eq.x = 252; eq.y = 56;
    eq.appendChild(await txt('VIIRS ÷ 3.6', 'Data/L', 'sensor/viirs')); eq.appendChild(await txt('= MODIS-eq.', 'Data/M', 'sensor/harmonized')); eq.appendChild(await txt('fit per region × month', 'Data/S', 'text/muted'));
  });
  // Step 3 — uncertainty
  await step(3, 'Honest about doubt', 'Every harmonized value carries a 90% interval from bootstrapping the overlap months. It is narrow where both sensors overlap and widens where we lean on the conversion. The confidence badge sums it up in one word.', 'A wide band means: trust the trend, not the exact number.', async il => {
    const W = 336, H = 120, x0 = 24, y0 = 28; const n = 25; const X = i => i * W / (n - 1);
    const base = i => 60 + 18 * Math.sin(i / 2.2) + i * 0.6; const w = i => i < 11 ? 12 : i <= 21 ? 8 : 12 + (i - 21) * 5;
    const up = [...Array(n)].map((_, i) => `${X(i).toFixed(1)} ${(H - base(i) - w(i)).toFixed(1)}`); const lo = [...Array(n)].map((_, i) => `${X(i).toFixed(1)} ${(H - base(i) + w(i)).toFixed(1)}`).reverse();
    const band = tint(svg(`<path d="M${up.join(' L')} L${lo.join(' L')} Z" fill="#fff"/>`, W, H, 'Band'), { fill: 'sensor/uncertainty' }); il.appendChild(band); band.x = x0; band.y = y0;
    const ln = tint(svg(`<path d="${[...Array(n)].map((_, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + (H - base(i)).toFixed(1)).join(' ')}" stroke="#fff" stroke-width="2.5"/>`, W, H, 'Harmonized'), { stroke: 'sensor/harmonized' }); il.appendChild(ln); ln.x = x0; ln.y = y0;
    for (const [i0, i1, l] of [[0, 10, 'MODIS only'], [11, 21, 'overlap · narrow'], [22, 24, 'wider']]) { const t = await txt(l, 'Data/S', 'text/muted'); t.x = x0 + X(i0); t.y = y0 + H + 8; il.appendChild(t); }
    const chips = AL('HORIZONTAL', 'Factors'); sp(chips, { gap: 6 }); il.appendChild(chips); chips.x = x0; chips.y = 200;
    for (const l of ['Overlap years', 'Cloud & smoke', 'Overpass time']) chips.appendChild(await inst('chip', 'Kind=Neutral', { Label: l, 'Show dot': false }));
  });
  // limitations
  const lim = COL('What detections can’t tell you', 1344); sp(lim, { p: 32, gap: 16 }); lim.fills = [paint('bg/surface')]; strk(lim, 'border/subtle'); rad(lim, 'xl'); add(col, lim, 'FILL');
  lim.appendChild(await txt('What detections can’t tell you', 'Heading/H2'));
  const grid = AL('HORIZONTAL', 'Limits'); sp(grid, { gap: 16 }); add(lim, grid, 'FILL');
  for (const [ic, t, b] of [['flame', 'Not the number of fires', 'One fire can produce many detections; small fires may produce none.'], ['map', 'Not burned area', 'For burned area use the MODIS burned-area product (MCD64A1).'], ['alert', 'Clouds hide fires', 'Clouds and thick smoke block the view; satellites pass only a few times a day.'], ['info', 'Not every hot pixel is a wildfire', 'Crop-residue burning, gas flares and industry also show up.']]) {
    const c = AL('HORIZONTAL', t); sp(c, { p: 16, gap: 12 }); c.fills = [paint('bg/elevated')]; rad(c, 'lg'); add(grid, c, 'FILL', 'FILL');
    c.appendChild(await icon(ic, 'text/accent', 20));
    const tt = AL('VERTICAL', 'Text'); sp(tt, { gap: 4 }); add(c, tt, 'FILL');
    add(tt, await txt(t, 'Label/L'), 'FILL'); add(tt, await txt(b, 'Body/S', 'text/muted', 240), 'FILL');
  }
  const cta = AL('HORIZONTAL', 'CTA'); sp(cta, { gap: 12 }); cta.primaryAxisAlignItems = 'CENTER'; add(col, cta, 'FILL');
  const tryBtn = await inst('button', 'Type=Primary, State=Default', { Label: 'Try it on a region' }); tryBtn.name = 'CTA · Try it'; cta.appendChild(tryBtn);
  cta.appendChild(await inst('button', 'Type=Ghost, State=Default', { Label: 'Read the methodology', 'Show icon': false }));
  f.resize(1440, Math.max(1024, col.y + col.height + 80));
  const tb = await topBar('How it works'); f.appendChild(tb); tb.x = 0; tb.y = 0;
  return 'ok';
}

// ================================================================ 5 · Mobile
async function mobileHeader(title) {
  const h = AL('HORIZONTAL', 'Mobile header'); h.resize(390, 10); h.primaryAxisSizingMode = 'FIXED'; h.counterAxisSizingMode = 'AUTO'; h.counterAxisAlignItems = 'CENTER';
  sp(h, { pt: 48, pb: 12, px: 16, gap: 8 }); await glass(h, 'xs'); rad(h, 'xs', ['topLeftRadius', 'topRightRadius']); h.setBoundVariable('bottomLeftRadius', V['radius/xs']); h.setBoundVariable('bottomRightRadius', V['radius/xs']);
  h.appendChild(await cInst('logo'));
  add(h, spacer(), 'FILL');
  for (const ic of ['search', 'layers']) { const b = await inst('iconButton', 'State=Default', { Icon: 'ICON:' + ic }); b.resize(44, 44); b.name = 'Button · ' + ic; h.appendChild(b); }
  return h;
}
async function buildMobile() {
  const page = await N(IDS.pages.screens); await figma.setCurrentPageAsync(page);
  for (const n of [NAMES.mIntro, NAMES.mMap, NAMES.mAnalysis]) removeByName(page, n);
  const d = makeData(); const Y0 = 3700; let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // --- Intro
  const mi = figma.createFrame(); mi.name = NAMES.mIntro; mi.resize(390, 844); mi.x = 0; mi.y = Y0; mi.fills = [paint('bg/canvas')]; mi.clipsContent = true; page.appendChild(mi);
  let stars = ''; for (let i = 0; i < 90; i++) stars += `<circle cx="${(rnd() * 390).toFixed(1)}" cy="${(rnd() * 844).toFixed(1)}" r="${(0.4 + rnd()).toFixed(2)}"/>`;
  mi.appendChild(tint(svg(stars, 390, 844, 'Starfield'), { fill: 'text/primary', a: 0.55 }));
  const gl = await cInst('globe'); gl.name = 'Globe (rotates 0.6°/s)'; mi.appendChild(gl); gl.rescale(0.62); gl.x = (390 - gl.width) / 2; gl.y = 40;
  const lg = await cInst('logo'); mi.appendChild(lg); lg.x = 16; lg.y = 56;
  const hero = COL('Hero copy', 358); sp(hero, { gap: 16 }); mi.appendChild(hero); hero.x = 16; hero.y = 470;
  hero.appendChild(await inst('chip', 'Kind=Neutral', { Label: 'NASA Space Apps 2026', 'Show dot': false }));
  hero.appendChild(await txt('Emberline', 'Display/L'));
  const tag = await txt('25 years of fire.\nOne honest scale.', 'Heading/H2', 'text/primary', 358); tag.setRangeFills(tag.characters.indexOf('One'), tag.characters.length, [fireGrad()]); add(hero, tag, 'FILL');
  add(hero, await txt('MODIS and VIIRS see fire differently. We put them on one scale — and show how sure we are.', 'Body/M', 'text/secondary', 358), 'FILL');
  const start = await inst('button', 'Type=Primary, State=Default', { Label: 'Start exploring' }); start.name = 'CTA · Start'; add(hero, start, 'FILL');
  const how = await inst('button', 'Type=Ghost, State=Default', { Label: 'How it works', 'Show icon': false }); add(hero, how, 'FILL');
  // --- Map
  const mm = figma.createFrame(); mm.name = NAMES.mMap; mm.resize(390, 844); mm.x = 490; mm.y = Y0; mm.fills = [paint('bg/canvas')]; mm.clipsContent = true; page.appendChild(mm);
  const canvas = figma.createFrame(); canvas.name = 'Map canvas (MapLibre)'; canvas.resize(390, 844); canvas.fills = []; canvas.clipsContent = true; mm.appendChild(canvas);
  for (const k of ['basemap', 'harm', 'modis']) { const i = await cInst(k); canvas.appendChild(i); i.resize(3600, 1400); i.x = -2240; i.y = -30; if (k === 'basemap') i.opacity = 0.4; }
  const sel = figma.createRectangle(); sel.name = 'Selection box'; sel.x = 110; sel.y = 270; sel.resize(200, 70); sel.fills = [paint('accent/cool', 0.06)]; sel.strokes = [paint('accent/cool')]; sel.strokeWeight = 1.5; sel.dashPattern = [6, 4]; mm.appendChild(sel);
  const mh = await mobileHeader(); mm.appendChild(mh); mh.x = 0; mh.y = 0;
  const sheet = COL('Bottom sheet', 390); sp(sheet, { pt: 8, px: 16, pb: 32, gap: 16 }); await glass(sheet); rad(sheet, 'xl', ['topLeftRadius', 'topRightRadius']); sheet.setBoundVariable('bottomLeftRadius', V['radius/xs']); sheet.setBoundVariable('bottomRightRadius', V['radius/xs']); sheet.counterAxisAlignItems = 'CENTER'; mm.appendChild(sheet);
  const handle = figma.createRectangle(); handle.name = 'Grabber'; handle.resize(36, 4); handle.fills = [paint('border/strong')]; rad(handle, 'pill'); sheet.appendChild(handle);
  const sh = AL('VERTICAL', 'Title'); sp(sh, { gap: 2 }); add(sheet, sh, 'FILL');
  sh.appendChild(await txt('Selected area', 'Label/Overline', 'text/muted')); sh.appendChild(await txt('Northern Kazakhstan steppe', 'Heading/H3')); sh.appendChild(await txt('48–55°N · 55–75°E · ≈1.08M km²', 'Data/S', 'text/muted'));
  const kv = AL('HORIZONTAL', 'Key value'); sp(kv, { gap: 8 }); kv.counterAxisAlignItems = 'CENTER'; add(sheet, kv, 'FILL');
  kv.appendChild(await txt(fmt(d.H[24]), 'Data/L')); add(kv, await txt(`± ${fmt(d.H[24] * d.band[24])} in 2025`, 'Body/S', 'text/muted'), 'FILL'); kv.appendChild(await inst('trust', 'Level=High'));
  const chips = AL('HORIZONTAL', 'Layers'); sp(chips, { gap: 8 }); add(sheet, chips, 'FILL');
  chips.appendChild(await inst('chip', 'Kind=Harmonized', { Label: 'Harmonized' })); chips.appendChild(await inst('chip', 'Kind=MODIS', { Label: 'MODIS' }));
  const vchip = await inst('chip', 'Kind=VIIRS', { Label: 'VIIRS' }); vchip.opacity = 0.5; chips.appendChild(vchip);
  const tape = figma.createFrame(); tape.name = 'Mini timeline'; tape.resize(358, 40); tape.fills = []; add(sheet, tape, 'FILL'); tape.layoutSizingVertical = 'FIXED';
  const mx = Math.max(...d.H); d.H.forEach((h, i) => { const b = figma.createRectangle(); const bh = Math.max(2, h / mx * 20); b.resize(10, bh); b.x = i * 14.3; b.y = 22 - bh; b.fills = [paint('heat/' + Math.min(6, 3 + Math.round(h / mx * 3)))]; rad(b, 'xs'); tape.appendChild(b); });
  const trk = figma.createRectangle(); trk.name = 'Track'; trk.resize(358, 3); trk.y = 26; trk.fills = [fireGrad()]; rad(trk, 'pill'); tape.appendChild(trk);
  const y1 = await txt('2001', 'Data/S', 'text/muted'); y1.y = 30; tape.appendChild(y1); const y2 = await txt('2025', 'Data/S', 'text/muted'); y2.x = 330; y2.y = 30; tape.appendChild(y2);
  const analyze = await inst('button', 'Type=Primary, State=Default', { Label: 'Analyze area' }); analyze.name = 'CTA · Analyze'; add(sheet, analyze, 'FILL');
  sheet.x = 0; sheet.y = 844 - sheet.height;
  // --- Analysis (scroll)
  const ma = AL('VERTICAL', NAMES.mAnalysis); ma.resize(390, 844); ma.counterAxisSizingMode = 'FIXED'; ma.primaryAxisSizingMode = 'AUTO'; sp(ma, { pt: 48, px: 16, pb: 40, gap: 16 }); ma.fills = [paint('bg/canvas')]; ma.clipsContent = true; page.appendChild(ma); ma.x = 980; ma.y = Y0;
  const hdr = AL('HORIZONTAL', 'Header'); sp(hdr, { gap: 12 }); hdr.counterAxisAlignItems = 'CENTER'; add(ma, hdr, 'FILL');
  const back = await inst('iconButton', 'State=Default', { Icon: 'ICON:arrow-left' }); back.resize(44, 44); back.name = 'Back'; hdr.appendChild(back);
  const ht = AL('VERTICAL', 'Title'); sp(ht, { gap: 2 }); add(hdr, ht, 'FILL');
  add(ht, await txt('N. Kazakhstan steppe', 'Heading/H3'), 'FILL'); ht.appendChild(await txt('2001–2025 · MODIS-eq. · demo', 'Data/S', 'text/muted'));
  const mode = await segmented(['Expert', '✦ Simple'], 1, 'Mode'); add(ma, mode, 'FILL'); for (const c of mode.children) { c.layoutSizingHorizontal = 'FILL'; }
  const sum = COL('10-second summary', 358); sp(sum, { p: 16, gap: 12 }); await glass(sum, 'lg'); add(ma, sum, 'FILL');
  sum.appendChild(await txt('In 10 seconds', 'Label/Overline', 'text/accent'));
  add(sum, await txt(`Fires here peak in ${seasonName(d.peak)}. 2025 was ${sgn(d.vs, 0)}% vs the usual year.`, 'Heading/H3', 'text/primary', 326), 'FILL');
  sum.appendChild(await inst('trust', 'Level=High'));
  const st = statsFor(d);
  for (const pair of [st.slice(0, 2), st.slice(2, 4)]) { const r = AL('HORIZONTAL', 'Stats row'); sp(r, { gap: 12 }); add(ma, r, 'FILL'); for (const [tone, l, v, dl, c] of pair) { const s = await inst('stat', `Tone=${tone}`, { Label: l, Value: v, Delta: dl, Caption: c }); add(r, s, 'FILL', 'FILL'); } }
  const cal = COL('Burn calendar', 358); sp(cal, { p: 16, gap: 12 }); cal.fills = [paint('bg/surface')]; strk(cal, 'border/subtle'); rad(cal, 'lg'); add(ma, cal, 'FILL');
  cal.appendChild(await txt('Burn calendar', 'Heading/H3'));
  const { g } = await burnCalendar(d, 326, { cell: 2, rowH: 13, labelW: 16, compact: true }); add(cal, g);
  const leg = await inst('legend', 'Kind=Heat'); add(cal, leg);
  add(cal, await plainNote('Each square is a month; brighter = more detections. Teal outline = unusual for that month.', 326), 'FILL');
  const chc = COL('Before / after', 358); sp(chc, { p: 16, gap: 12 }); chc.fills = [paint('bg/surface')]; strk(chc, 'border/subtle'); rad(chc, 'lg'); add(ma, chc, 'FILL');
  const chh = AL('HORIZONTAL', 'Head'); chh.counterAxisAlignItems = 'CENTER'; add(chc, chh, 'FILL'); add(chh, await txt('Harmonized series', 'Heading/H3'), 'FILL');
  chh.appendChild(await segmented(['Raw', 'Harmonized'], 1, 'Before/After'));
  add(chc, await harmonizedChart(d, 326, 200, { swipe: false }));
  add(chc, await plainNote('Orange = both satellites on one scale. Shaded band = how sure we are.', 326), 'FILL');
  const sea = COL('Seasonal profile', 358); sp(sea, { p: 16, gap: 12 }); sea.fills = [paint('bg/surface')]; strk(sea, 'border/subtle'); rad(sea, 'lg'); add(ma, sea, 'FILL');
  sea.appendChild(await txt('Seasonal profile', 'Heading/H3')); add(sea, await seasonalChart(d, 326, 180));
  const acts = AL('HORIZONTAL', 'Actions'); sp(acts, { gap: 8 }); add(ma, acts, 'FILL');
  const exp = await inst('button', 'Type=Secondary, State=Default', { Label: 'Export', Icon: 'ICON:download' }); add(acts, exp, 'FILL');
  const shr = await inst('button', 'Type=Ghost, State=Default', { Label: 'Share', Icon: 'ICON:share' }); add(acts, shr, 'FILL');
  return 'ok';
}

// ================================================================ 6 · Motion storyboard
const EASE = { standard: [0.2, 0, 0, 1], exit: [0.3, 0, 0.8, 0.15], zoom: [0.7, 0, 0.84, 0], unfold: [0.65, 0, 0.35, 1], enter: [0.05, 0.7, 0.1, 1] };
function reaction(trigger, destId, ms, ease, type = 'SMART_ANIMATE') {
  const [x1, y1, x2, y2] = EASE[ease];
  const transition = { type, easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1, y1, x2, y2 } }, duration: ms / 1000 };
  if (type === 'SLIDE_IN' || type === 'MOVE_IN' || type === 'PUSH') Object.assign(transition, { direction: 'LEFT', matchLayers: false });
  return { trigger, actions: [{ type: 'NODE', destinationId: destId, navigation: 'NAVIGATE', transition, preserveScrollPosition: false }] };
}
async function buildMotion() {
  const page = await N(IDS.pages.motion); await figma.setCurrentPageAsync(page);
  for (const n of page.children.filter(c => c.name.startsWith('Motion · ') || c.name.startsWith('F') && c.name.includes(' · '))) n.remove();
  const intro = await N(IDS.screens.intro); const map = await N(IDS.screens.map);
  const head = AL('VERTICAL', 'Motion · Header'); sp(head, { gap: 8 }); page.appendChild(head); head.x = 0; head.y = -360;
  head.appendChild(await txt('Motion · Intro → Map transition', 'Label/Overline', 'text/accent'));
  head.appendChild(await txt('Globe dives in, then unfolds into the map', 'Display/L'));
  head.appendChild(await txt('Раскадровка из 6 кадров (1440×1024). Кадры связаны Smart Animate с реальными таймингами — запустите поток «Intro → Map transition» в Present. Общая длительность ≈ 2.5 с; клик в любой момент пропускает анимацию; при prefers-reduced-motion — простой crossfade 300 мс. В коде: deck.gl GlobeView → MapView или интерполяция проекций d3-geo (orthographic → equirectangular), UI — Framer Motion / GSAP.', 'Body/L', 'text/muted', 1400));
  const frames = [];
  const place = (f, i) => { page.appendChild(f); f.x = (i % 3) * 1560; f.y = Math.floor(i / 3) * 1500; frames.push(f); };
  const byName = (f, name) => f.findOne(n => n.name === name);
  // F1
  const f1 = intro.clone(); f1.name = 'F1 · Idle'; place(f1, 0);
  // F2 press
  const f2 = intro.clone(); f2.name = 'F2 · Press'; place(f2, 1);
  const btn2 = f2.findOne(n => n.type === 'INSTANCE' && n.name === 'CTA · Start');
  if (btn2) { const set = await N(IDS.sets.button); btn2.swapComponent(set.children.find(c => c.name === 'Type=Primary, State=Pressed')); setProps(btn2, { Label: 'Start exploring' }); }
  // F3 exit
  const f3 = intro.clone(); f3.name = 'F3 · Copy exits'; place(f3, 2);
  for (const nm of ['Hero copy', 'Footer', 'Hint', 'Callout', 'Callout line', 'Callout ring']) { const n = byName(f3, nm); if (n) { n.opacity = 0; if (nm === 'Hero copy') n.y -= 16; } }
  const lg3 = f3.findOne(n => n.type === 'INSTANCE' && n.name === 'Brand/Logo'); if (lg3) lg3.opacity = 0;
  const g3 = byName(f3, 'Globe (rotates 0.6°/s)'); if (g3) { const cx = g3.x + g3.width / 2, cy = g3.y + g3.height / 2; g3.rescale(1.15); g3.x = cx - g3.width / 2; g3.y = cy - g3.height / 2; }
  // F4 zoom
  const f4 = f3.clone(); f4.name = 'F4 · Zoom to region'; place(f4, 3);
  const g4 = byName(f4, 'Globe (rotates 0.6°/s)'); if (g4) { const s = 4.0 / (g4.width / 800); g4.rescale(s); g4.x = 720 - 434.7 * 4.0; g4.y = 512 - 219 * 4.0; }
  const st4 = byName(f4, 'Starfield'); if (st4) st4.opacity = 0.3;
  // F5 unfold
  const f5 = f4.clone(); f5.name = 'F5 · Unfold to flat map'; place(f5, 4);
  const bm = await cInst('basemap'); f5.appendChild(bm); bm.name = 'Basemap'; bm.resize(3600, 1400); bm.x = 720 - 2435; bm.y = 512 - 330; bm.opacity = 0.35;
  const hm = await cInst('harm'); f5.appendChild(hm); hm.name = 'Layer · Harmonized'; hm.resize(3600, 1400); hm.x = bm.x; hm.y = bm.y; hm.opacity = 0.6;
  const g5 = byName(f5, 'Globe (rotates 0.6°/s)'); if (g5) g5.opacity = 0.35;
  const tag = AL('HORIZONTAL', 'Projection label'); sp(tag, { px: 12, py: 8 }); await glass(tag, 'pill'); tag.appendChild(await txt('projection: orthographic → equirectangular · t = 0.5', 'Data/S', 'text/secondary')); f5.appendChild(tag); tag.x = 720 - tag.width / 2; tag.y = 940;
  // F6 UI enters (final = Map screen)
  const f6 = map.clone(); f6.name = 'F6 · Interface enters'; place(f6, 5);
  // annotations under frames
  const notes = [
    ['F1 · 0 ms · Idle', 'Глобус вращается 0.6°/с; ядра огня пульсируют 2.4 с (opacity 0.7↔1). CTA ждёт клика.', 'linear'],
    ['F2 · 0–120 ms · Press', 'CTA scale 1 → 0.96, заливка → accent/primary-pressed, тактильный отклик.', 'standard · cubic-bezier(0.2, 0, 0, 1) · 120 ms'],
    ['F3 · 120–480 ms · Copy exits', 'Заголовок, слоган, кнопки: opacity 1 → 0, y −16 px, stagger 40 мс. Логотип и футер гаснут. Глобус 1 → 1.15.', 'exit · cubic-bezier(0.3, 0, 0.8, 0.15) · 360 ms'],
    ['F4 · 480–1100 ms · Zoom', 'Камера ныряет к выбранному региону: глобус ×3.2, Казахстан в центр кадра. Звёзды opacity 0.3, атмосфера уходит за край.', 'zoom · cubic-bezier(0.7, 0, 0.84, 0) · 620 ms'],
    ['F5 · 1100–1900 ms · Unfold', 'Сфера разворачивается в плоскость: интерполяция проекции t 0 → 1, сетка выпрямляется, точки суши сохраняют идентичность.', 'unfold · cubic-bezier(0.65, 0, 0.35, 1) · 800 ms'],
    ['F6 · 1900–2500 ms · UI enters', 'Top bar сверху (−64 → 0), панель слева (−24 px, fade), контролы, таймлайн снизу (+24 px). Stagger 40 мс.', 'enter · cubic-bezier(0.05, 0.7, 0.1, 1) · 600 ms'],
  ];
  for (let i = 0; i < 6; i++) {
    const [t, b, e] = notes[i]; const c = COL(`Motion · Note ${i + 1}`, 1440); sp(c, { p: 24, gap: 8 }); c.fills = [paint('bg/surface')]; strk(c, 'border/subtle'); rad(c, 'lg'); page.appendChild(c); c.x = frames[i].x; c.y = frames[i].y + 1024 + 24;
    c.appendChild(await txt(t, 'Heading/H3')); add(c, await txt(b, 'Body/M', 'text/secondary', 1392), 'FILL'); c.appendChild(await txt(e, 'Data/M', 'accent/cool'));
  }
  // auto-playing prototype
  const cta = f1.findOne(n => n.name === 'CTA · Start');
  try {
    await cta.setReactionsAsync([reaction({ type: 'ON_CLICK' }, f2.id, 120, 'standard')]);
    await f2.setReactionsAsync([reaction({ type: 'AFTER_TIMEOUT', timeout: 0.05 }, f3.id, 360, 'exit')]);
    await f3.setReactionsAsync([reaction({ type: 'AFTER_TIMEOUT', timeout: 0.01 }, f4.id, 620, 'zoom')]);
    await f4.setReactionsAsync([reaction({ type: 'AFTER_TIMEOUT', timeout: 0.01 }, f5.id, 800, 'unfold')]);
    await f5.setReactionsAsync([reaction({ type: 'AFTER_TIMEOUT', timeout: 0.01 }, f6.id, 600, 'enter')]);
    page.flowStartingPoints = [{ nodeId: f1.id, name: 'Intro → Map transition' }];
  } catch (e) { console.error('motion reactions', e); return 'frames ok, reactions failed: ' + e.message; }
  return 'ok';
}

// ================================================================ 7 · Ideas
async function buildIdeas() {
  const page = await N(IDS.pages.motion); await figma.setCurrentPageAsync(page);
  removeByName(page, 'Ideas');
  const sec = COL('Ideas', 1760); sp(sec, { p: 64, gap: 32 }); sec.fills = [paint('bg/canvas')]; strk(sec, 'border/subtle'); rad(sec, 'xl'); page.appendChild(sec); sec.x = 0; sec.y = 3300;
  sec.appendChild(await txt('Ideas · 4 shipped in the design, 8 in the backlog', 'Label/Overline', 'text/accent'));
  sec.appendChild(await txt('Ideas backlog', 'Display/L'));
  add(sec, await txt('Отбор: идея должна помогать ответить за 10 секунд «что происходит с огнём» и «можно ли доверять», и не должна притворяться, что детекция = пожар.', 'Body/L', 'text/muted', 1200), 'FILL');
  const grid = AL('HORIZONTAL', 'Cards'); grid.layoutWrap = 'WRAP'; sp(grid, { gap: 24 }); grid.counterAxisSpacing = 24; add(sec, grid, 'FILL');
  const IDEAS = [
    [true, 'Burning calendar', 'Month × year grid where intense months glow like embers; unusual months get a teal ring and a data tooltip with the interval.', 'Analysis · Mobile', 3, 2],
    [true, 'Before / after swipe', 'Drag a handle across the chart: raw MODIS + VIIRS on the left, harmonized series with uncertainty on the right. The fake 2012 jump visibly disappears.', 'Analysis', 3, 2],
    [true, 'Explain simply mode', 'Expert / Simple toggle swaps jargon for one-line plain captions under every chart; terms like “detection” get tooltips.', 'Global', 3, 1],
    [true, 'Ember tape timeline', '25-year scrubber where every tick is one month of harmonized fire intensity. Play, loop a season, jump between anomalies.', 'Map', 2, 2],
    [false, 'Sonified anomalies', 'Optional soft tone when the playhead crosses an unusual month; pitch encodes σ. Off by default, captioned for accessibility.', 'Map', 1, 2],
    [false, 'Pixel lens', 'Hover the map to see the 1 km MODIS and 375 m VIIRS footprints over the same fire — the “why VIIRS sees more” lesson in place.', 'Map', 2, 2],
    [false, 'Region vs region', 'Two burn calendars side by side on the same MODIS-equivalent scale, e.g. Kostanay vs the Sahel.', 'Analysis', 2, 2],
    [false, 'Fire postcard', 'Export a shareable PNG: calendar + one-sentence summary + confidence badge + data credit.', 'Analysis', 2, 1],
    [false, 'Overpass clock', 'Radial clock of satellite overpass times (~10:30 Terra, ~13:30 Aqua/VIIRS) explaining why some fires are never seen.', 'How it works', 1, 2],
    [false, 'Story mode', 'Auto-written narrative from deterministic templates (“2021 was the 2nd highest August…”). No LLM → no invented facts.', 'Analysis', 2, 2],
    [false, 'Color-blind & print mode', 'Pattern-coded calendar cells and a high-contrast ramp that survives grayscale printing.', 'Global', 2, 1],
    [false, 'Newsroom embed', 'iframe widget with a live burn calendar for one region, with NASA FIRMS attribution.', 'Embed', 2, 2],
  ];
  const dots = n => '●'.repeat(n) + '○'.repeat(3 - n);
  for (const [shipped, title, body, where, impact, effort] of IDEAS) {
    const c = COL(title, 392); sp(c, { p: 24, gap: 12 }); c.fills = [paint(shipped ? 'bg/surface' : 'bg/elevated')]; strk(c, shipped ? 'accent/primary' : 'border/subtle', shipped ? 0.5 : 1); rad(c, 'lg'); grid.appendChild(c);
    c.appendChild(await inst('chip', shipped ? 'Kind=Selected' : 'Kind=Neutral', { Label: shipped ? 'In the design' : 'Backlog', 'Show dot': shipped }));
    add(c, await txt(title, 'Heading/H3'), 'FILL');
    add(c, await txt(body, 'Body/M', 'text/secondary', 344), 'FILL');
    c.appendChild(await txt(`${where} · impact ${dots(impact)} · effort ${dots(effort)}`, 'Data/S', 'text/muted'));
  }
  return 'ok';
}

// ================================================================ 8 · Prototype
async function wirePrototype() {
  const page = await N(IDS.pages.screens); await figma.setCurrentPageAsync(page);
  const byName = n => page.children.find(c => c.name === n);
  const intro = await N(IDS.screens.intro), map = await N(IDS.screens.map), region = await N(IDS.screens.region);
  const analysis = byName(NAMES.analysis), how = byName(NAMES.how);
  const link = async (node, dest, ms = 400, ease = 'standard', type = 'SMART_ANIMATE') => { if (node && dest) await node.setReactionsAsync([reaction({ type: 'ON_CLICK' }, dest.id, ms, ease, type)]); };
  await link(await N(IDS.screens.ctaStart), map, 600, 'enter', 'DISSOLVE');
  await link(await N(IDS.screens.ctaHow), how, 400, 'standard', 'DISSOLVE');
  await link(map.findOne(n => n.name === 'Map canvas (MapLibre)'), region, 300);
  await link(map.findOne(n => n.name === 'Search'), region, 300);
  await link(await N(IDS.screens.ctaAnalyze), analysis, 400, 'enter', 'DISSOLVE');
  if (analysis) await link(analysis.findOne(n => n.name === 'Back to map'), region, 300, 'standard', 'DISSOLVE');
  if (how) await link(how.findOne(n => n.name === 'CTA · Try it'), map, 400, 'standard', 'DISSOLVE');
  const mi = byName(NAMES.mIntro), mm = byName(NAMES.mMap), ma = byName(NAMES.mAnalysis);
  if (mi && mm) await link(mi.findOne(n => n.name === 'CTA · Start'), mm, 500, 'enter', 'DISSOLVE');
  if (mm && ma) await link(mm.findOne(n => n.name === 'CTA · Analyze'), ma, 350, 'enter', 'SLIDE_IN');
  if (ma && mm) await link(ma.findOne(n => n.name === 'Back'), mm, 300, 'standard', 'DISSOLVE');
  const flows = [{ nodeId: intro.id, name: 'Desktop · main flow' }];
  if (mi) flows.push({ nodeId: mi.id, name: 'Mobile · main flow' });
  page.flowStartingPoints = flows;
  return 'ok';
}

// ================================================================ main
const MODULES = { alpha: fixAlpha, layout: tidyScreens, analysis: buildAnalysis, how: buildHow, mobile: buildMobile, motion: buildMotion, ideas: buildIdeas, prototype: wirePrototype };
const ORDER = ['alpha', 'layout', 'analysis', 'how', 'mobile', 'motion', 'ideas', 'prototype'];

async function main() {
  const cmd = figma.command && MODULES[figma.command] ? figma.command : 'all';
  const order = cmd === 'all' ? ORDER : [cmd];
  const log = [];
  try { await init(); } catch (e) { figma.closePlugin('Emberline: ' + e.message); return; }
  for (const k of order) {
    figma.notify(`Emberline · ${k}…`, { timeout: 1200 });
    try { const r = await MODULES[k](); log.push(`✓ ${k}${r && r !== 'ok' ? ' (' + r + ')' : ''}`); }
    catch (e) { console.error(`[Emberline] ${k} failed`, e); log.push(`✗ ${k}: ${e && e.message ? e.message : e}`); }
  }
  console.log('[Emberline] ' + log.join('\n'));
  figma.closePlugin(log.join(' · '));
}
main();
