/* =========================================================================
 * app.js — Rendering SVG, interaksi (drag/pan/zoom/connect), dan
 * mesin simulasi DFA dengan animasi (requestAnimationFrame).
 * ========================================================================= */
'use strict';

/* ---------- referensi DOM ---------- */
const $ = (sel) => document.querySelector(sel);
const svg = $('#graph');
const viewport = $('#viewport');
const edgeLayer = $('#edgeLayer');
const stateLayer = $('#stateLayer');
const tempEdge = $('#tempEdge');
const orb = $('#orb');
const inspectorEl = $('#inspector');
const emptyHint = $('#emptyHint');
const inputString = $('#inputString');
const tokensEl = $('#tokens');
const statusEl = $('#status');
const termEl = $('#term');
const orbTrail = $('#orbTrail');
const speedRead = $('#speedRead');
const playBtn = $('#playBtn');
const playLabel = $('#playLabel');
const stepBtn = $('#stepBtn');
const resetBtn = $('#resetBtn');
const speedRange = $('#speedRange');
const resultEl = $('#result');
const resultWord = $('#resultWord');
const resultReason = $('#resultReason');
const zoomLabel = $('#zoomLabel');
const popover = $('#popover');
const popInput = $('#popInput');
const popSub = $('#popSub');
const popErr = $('#popErr');
const toastsEl = $('#toasts');
const confettiCanvas = $('#confetti');

const SVGNS = 'http://www.w3.org/2000/svg';
const STATE_R = 27;      // radius lingkaran state
const ARROW_GAP = 4;     // jarak ujung path dari tepi lingkaran (untuk mata panah)
const TRAVEL_MS = 950;   // durasi dasar orb menempuh satu transisi (dibagi kecepatan)
const PAUSE_MS = 420;    // jeda antar simbol (dibagi kecepatan)
// Reduced-motion hanya mematikan efek dekoratif (confetti);
// orb & jalannya simulasi tetap dianimasikan agar selalu bisa diikuti.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const model = new DfaModel();

/* ---------- util ---------- */
function svgEl(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const speedVal = () => parseFloat(speedRange.value) || 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  toastsEl.appendChild(t);
  while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3000);
}
function status(msg) { statusEl.textContent = msg; }

/* terminal log simulasi */
function termLine(text, kind = '') {
  const line = document.createElement('div');
  line.className = `t-line ${kind}`.trim();
  line.textContent = text;
  termEl.appendChild(line);
  while (termEl.children.length > 60) termEl.firstChild.remove();
  termEl.scrollTop = termEl.scrollHeight;
}
function termClear() { termEl.replaceChildren(); }

/* jejak bola di belakang orb (efek "mengalir") */
const TRAIL_N = 9;
const trailCircles = [];
for (let i = 0; i < TRAIL_N; i++) {
  trailCircles.push(svgEl('circle', { class: 'trail-ball', r: 0 }, orbTrail));
}
let trailPts = [];
function updateTrail(pt) {
  trailPts.unshift(pt);
  if (trailPts.length > TRAIL_N) trailPts.pop();
  trailCircles.forEach((c, i) => {
    const p = trailPts[i];
    if (!p) { c.setAttribute('r', 0); return; }
    const f = 1 - i / TRAIL_N; // makin jauh di belakang, makin kecil & pudar
    c.setAttribute('cx', p.x.toFixed(1));
    c.setAttribute('cy', p.y.toFixed(1));
    c.setAttribute('r', (5.5 * f + 0.6).toFixed(2));
    c.setAttribute('opacity', (0.38 * f + 0.04).toFixed(2));
  });
}
function clearTrail() {
  trailPts = [];
  trailCircles.forEach((c) => c.setAttribute('r', 0));
}

/* ---------- viewport: pan & zoom (view = translate + scale) ---------- */
const view = { x: 0, y: 0, k: 1 };
function applyView() {
  viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  zoomLabel.textContent = Math.round(view.k * 100) + '%';
}
function toGraph(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
}
function zoomAt(clientX, clientY, factor) {
  const r = svg.getBoundingClientRect();
  const px = clientX - r.left, py = clientY - r.top;
  const k2 = Math.min(2.5, Math.max(0.25, view.k * factor));
  view.x = px - (px - view.x) * (k2 / view.k);
  view.y = py - (py - view.y) * (k2 / view.k);
  view.k = k2;
  applyView();
}
function fitView() {
  if (!model.states.length) { view.x = 0; view.y = 0; view.k = 1; return applyView(); }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pad = STATE_R * 2.6; // ruang untuk loop & label
  model.states.forEach((s) => {
    minX = Math.min(minX, s.x - pad); maxX = Math.max(maxX, s.x + pad);
    minY = Math.min(minY, s.y - pad); maxY = Math.max(maxY, s.y + pad);
  });
  const r = svg.getBoundingClientRect();
  const k = Math.min(1.45, Math.max(0.25, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
  view.k = k;
  view.x = (r.width - (minX + maxX) * k) / 2;
  view.y = (r.height - (minY + maxY) * k) / 2;
  applyView();
}

/* ---------- geometri edge ---------- */
function edgeGeometry(e) {
  const a = model.getState(e.from);
  const b = model.getState(e.to);
  if (e.from === e.to) {
    // loop diri: kurva di atas state
    const p0 = { x: a.x - STATE_R * 0.62, y: a.y - STATE_R * 0.72 };
    const p1 = { x: a.x + STATE_R * 0.62, y: a.y - STATE_R * 0.72 };
    const c1 = { x: a.x - STATE_R * 1.75, y: a.y - STATE_R * 2.3 };
    const c2 = { x: a.x + STATE_R * 1.75, y: a.y - STATE_R * 2.3 };
    return {
      d: `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p1.x} ${p1.y}`,
      label: { x: a.x, y: a.y - STATE_R * 2.5 },
    };
  }
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L; // normal
  const recip = !!model.edgeBetween(e.to, e.from);
  const bend = recip ? 0.3 : 0.13;
  const cx = (a.x + b.x) / 2 + nx * L * bend;
  const cy = (a.y + b.y) / 2 + ny * L * bend;
  // pangkas ujung ke tepi lingkaran mengikuti arah menuju titik kontrol
  const u0 = Math.hypot(cx - a.x, cy - a.y);
  const p0 = { x: a.x + (cx - a.x) / u0 * STATE_R, y: a.y + (cy - a.y) / u0 * STATE_R };
  const u1 = Math.hypot(cx - b.x, cy - b.y);
  const gap = STATE_R + ARROW_GAP;
  const p1 = { x: b.x + (cx - b.x) / u1 * gap, y: b.y + (cy - b.y) / u1 * gap };
  // titik tengah kurva kuadratik + sedikit offset keluar untuk label
  const mx = 0.25 * p0.x + 0.5 * cx + 0.25 * p1.x;
  const my = 0.25 * p0.y + 0.5 * cy + 0.25 * p1.y;
  const off = recip ? 18 : 14;
  return { d: `M ${p0.x} ${p0.y} Q ${cx} ${cy} ${p1.x} ${p1.y}`, label: { x: mx + nx * off, y: my + ny * off } };
}

/* ---------- render state & edge (DOM dipetakan per id) ---------- */
const stateEls = new Map();
const edgeEls = new Map();

function buildStateEl(s) {
  const g = svgEl('g', { class: 'state', 'data-id': s.id }, stateLayer);
  svgEl('path', { class: 'start-arrow' }, g);                 // panah masuk (state awal)
  svgEl('circle', { class: 'halo', r: STATE_R + 11 }, g);     // area glow, non-interaktif
  svgEl('circle', { class: 'ring', r: STATE_R }, g);
  svgEl('circle', { class: 'inner', r: STATE_R - 6 }, g);     // lingkar ganda (state akhir)
  const txt = svgEl('text', { class: 'label', dy: '0.35em' }, g);
  txt.textContent = s.label;
  stateEls.set(s.id, g);
  updateStateEl(s);
}
function updateStateEl(s) {
  const g = stateEls.get(s.id);
  if (!g) return;
  g.setAttribute('transform', `translate(${s.x} ${s.y})`);
  g.classList.toggle('final', s.final);
  g.classList.toggle('start', s.start);
  g.querySelector('.label').textContent = s.label;
  g.querySelector('.start-arrow').setAttribute('d', `M ${-STATE_R - 26} 0 L ${-STATE_R - 5} 0`);
}
function removeStateEl(id) {
  stateEls.get(id)?.remove();
  stateEls.delete(id);
}

function buildEdgeEl(e) {
  const g = svgEl('g', { class: 'edge', 'data-id': e.id }, edgeLayer);
  svgEl('path', { class: 'hit', 'pointer-events': 'stroke' }, g);
  svgEl('path', { class: 'line' }, g);
  svgEl('text', { class: 'label', 'text-anchor': 'middle' }, g);
  edgeEls.set(e.id, g);
  updateEdgeEl(e);
}
function updateEdgeEl(e) {
  const g = edgeEls.get(e.id);
  if (!g) return;
  const geo = edgeGeometry(e);
  g.querySelector('.hit').setAttribute('d', geo.d);
  const line = g.querySelector('.line');
  line.setAttribute('d', geo.d);
  const label = g.querySelector('.label');
  label.setAttribute('x', geo.label.x);
  label.setAttribute('y', geo.label.y);
  label.textContent = [...e.symbols].join(',');
  g.classList.toggle('self', e.from === e.to);
}
function removeEdgeEl(id) {
  edgeEls.get(id)?.remove();
  edgeEls.delete(id);
}

function renderGraph() {
  stateLayer.replaceChildren();
  edgeLayer.replaceChildren();
  stateEls.clear();
  edgeEls.clear();
  model.edges.forEach(buildEdgeEl);
  model.states.forEach(buildStateEl);
  updateEmptyHint();
}

/** Samakan DOM dengan model: bangun yang baru, perbarui yang berubah, buang yang hilang. */
function syncGraph() {
  [...edgeEls.keys()].forEach((id) => { if (!model.getEdge(id)) removeEdgeEl(id); });
  [...stateEls.keys()].forEach((id) => { if (!model.getState(id)) removeStateEl(id); });
  model.edges.forEach((e) => (edgeEls.has(e.id) ? updateEdgeEl(e) : buildEdgeEl(e)));
  model.states.forEach((s) => (stateEls.has(s.id) ? updateStateEl(s) : buildStateEl(s)));
  updateEmptyHint();
}
function updateEmptyHint() {
  emptyHint.hidden = model.states.length > 0;
}

/* ---------- seleksi & inspektor ---------- */
let selection = null; // { type: 'state' | 'edge', id }
let presetExplain = null; // { name, desc } contoh DFA yang sedang dimuat
let currentPresetKey = null; // kunci preset terakhir yang dimuat (untuk tombol pemulihan)

function applySelection() {
  stateEls.forEach((g) => g.classList.toggle('selected', selection?.type === 'state' && g.dataset.id === selection.id));
  edgeEls.forEach((g) => g.classList.toggle('selected', selection?.type === 'edge' && g.dataset.id === selection.id));
  renderInspector();
}

/** Bagian penjelasan contoh DFA (tampil di semua tampilan inspektor). */
const explainSection = () => presetExplain
  ? `<section class="insp-sec explain">
       <h3>Penjelasan — ${presetExplain.name}</h3>
       <p>${presetExplain.desc}</p>
       <button type="button" class="btn small" data-action="restore-preset">
         <svg class="icon"><use href="#i-reset"/></svg><span>Kembalikan contoh asli</span>
       </button>
     </section>`
  : '';

function renderInspector() {
  if (simActive()) {
    const d = model.describe();
    inspectorEl.innerHTML = `
      ${explainSection()}
      <p class="insp-note">Simulasi berjalan — tekan <strong>Reset</strong> untuk mengedit DFA.</p>
      <section class="insp-sec"><h3>Definisi formal</h3>${formalTable(d)}</section>`;
    return;
  }
  if (selection?.type === 'state') return inspectorForState(model.getState(selection.id));
  if (selection?.type === 'edge') return inspectorForEdge(model.getEdge(selection.id));
  selection = null;
  const d = model.describe();
  inspectorEl.innerHTML = `
    ${explainSection()}
    <section class="insp-sec">
      <h3>Definisi formal</h3>${formalTable(d)}
    </section>
    <section class="insp-sec">
      <h3>Panduan singkat</h3>
      <ul class="guide">
        <li>Klik dua kali kanvas: state baru</li>
        <li>Seret state untuk memindahkan</li>
        <li>Klik dua kali state: jadi/tak jadi state akhir</li>
        <li>Alat <em>Transisi</em>: klik asal → tujuan</li>
        <li><kbd>Delete</kbd>: hapus yang dipilih</li>
      </ul>
    </section>`;
}
const formalTable = (d) => `
  <dl class="formal">
    <dt>Q</dt><dd>{${d.Q.join(', ') || '∅'}}</dd>
    <dt>Σ</dt><dd>{${d.sigma.join(', ') || '∅'}}</dd>
    <dt>q₀</dt><dd>${d.q0}</dd>
    <dt>F</dt><dd>{${d.F.join(', ') || '∅'}}</dd>
  </dl>`;

function inspectorForState(s) {
  if (!s) { selection = null; return renderInspector(); }
  inspectorEl.innerHTML = `
    ${explainSection()}
    <section class="insp-sec">
      <h3>State</h3>
      <label class="field">Label
        <input id="inspLabel" type="text" value="${s.label}" autocomplete="off" spellcheck="false">
      </label>
      <p id="inspLabelErr" class="insp-err" hidden></p>
      <div class="insp-row">
        <button type="button" class="btn small" data-action="set-start" aria-pressed="${s.start}">
          <svg class="icon"><use href="#i-arrow-in"/></svg><span>${s.start ? 'State awal ✓' : 'Jadikan awal'}</span>
        </button>
        <button type="button" class="btn small" data-action="toggle-final" aria-pressed="${s.final}">
          <span class="dot-final"></span><span>${s.final ? 'State akhir ✓' : 'Jadikan akhir'}</span>
        </button>
      </div>
      <button type="button" class="btn danger small" data-action="del-state">
        <svg class="icon"><use href="#i-trash"/></svg><span>Hapus state</span>
      </button>
    </section>
    <section class="insp-sec"><h3>Definisi formal</h3>${formalTable(model.describe())}</section>`;
  const input = $('#inspLabel');
  input.addEventListener('change', () => {
    const res = model.renameState(s.id, input.value);
    if (!res.ok) {
      input.value = s.label;
      const err = $('#inspLabelErr');
      err.textContent = res.error; err.hidden = false;
      setTimeout(() => (err.hidden = true), 2500);
    } else {
      $('#inspLabelErr').hidden = true;
      updateStateEl(s);
      renderInspector();
    }
  });
}

function inspectorForEdge(e) {
  if (!e) { selection = null; return renderInspector(); }
  const from = model.getState(e.from), to = model.getState(e.to);
  inspectorEl.innerHTML = `
    ${explainSection()}
    <section class="insp-sec">
      <h3>Transisi</h3>
      <p class="insp-path">${from.label} → ${to.label}${e.from === e.to ? ' (loop)' : ''}</p>
      <label class="field">Simbol (pisahkan dengan koma)
        <input id="inspSyms" type="text" value="${[...e.symbols].join(',')}" autocomplete="off" spellcheck="false">
      </label>
      <p id="inspSymsErr" class="insp-err" hidden></p>
      <button type="button" class="btn danger small" data-action="del-edge">
        <svg class="icon"><use href="#i-trash"/></svg><span>Hapus transisi</span>
      </button>
    </section>
    <section class="insp-sec"><h3>Definisi formal</h3>${formalTable(model.describe())}</section>`;
  $('#inspSyms').addEventListener('change', (ev) => {
    const { symbols, valid } = parseSymbolList(ev.target.value);
    const err = $('#inspSymsErr');
    if (!valid) { err.textContent = 'Setiap simbol harus tepat satu karakter.'; err.hidden = false; return; }
    if (!symbols.length) { model.removeEdge(e.id); selection = null; refreshAfterEdit(); toast('Transisi dihapus (tanpa simbol).'); return; }
    err.hidden = true;
    const { moved } = model.setEdgeSymbols(e.id, symbols);
    if (moved.length) toast(`Simbol ${moved.join(', ')} dipindah ke transisi ini (DFA harus deterministik).`);
    refreshAfterEdit();
  });
}

/* aksi tombol inspektor (delegasi) */
inspectorEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || simActive()) return;
  const act = btn.dataset.action;
  if (act === 'restore-preset' && currentPresetKey) {
    loadPreset(currentPresetKey); // pulihkan contoh dari semua edit pengguna
  } else if (act === 'set-start' && selection?.type === 'state') {
    model.setStart(selection.id);
    model.states.forEach(updateStateEl);
    renderInspector();
  } else if (act === 'toggle-final' && selection?.type === 'state') {
    model.toggleFinal(selection.id);
    updateStateEl(model.getState(selection.id));
    renderInspector();
  } else if (act === 'del-state' && selection?.type === 'state') {
    model.edgesTouching(selection.id).forEach((ed) => removeEdgeEl(ed.id));
    model.removeState(selection.id);
    removeStateEl(selection.id);
    selection = null;
    refreshAfterEdit();
  } else if (act === 'del-edge' && selection?.type === 'edge') {
    model.removeEdge(selection.id);
    removeEdgeEl(selection.id);
    selection = null;
    refreshAfterEdit();
  }
});
function refreshAfterEdit() {
  syncGraph();
  applySelection();
}

/* ---------- mode alat ---------- */
let tool = 'select';
const toolBtns = [...document.querySelectorAll('.tool')];
function setTool(t) {
  if (simActive()) return;
  tool = t;
  toolBtns.forEach((b) => {
    const on = b.dataset.tool === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  cancelConnect();
  svg.classList.toggle('tool-add', t === 'add');
  svg.classList.toggle('tool-connect', t === 'connect');
}
toolBtns.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

/* ---------- interaksi pointer di kanvas ---------- */
let dragState = null;     // { id, offX, offY }
let panView = null;       // { startX, startY, viewX, viewY, moved }
let connectFrom = null;   // id state asal saat mode transisi
let hoverStateId = null;

svg.addEventListener('pointerdown', (e) => {
  if (simActive()) return;
  const stateG = e.target.closest('.state');
  const edgeG = e.target.closest('.edge');

  if (tool === 'add') {
    if (!stateG) {
      const g = toGraph(e.clientX, e.clientY);
      const s = model.addState(g.x, g.y);
      buildStateEl(s);
      selection = { type: 'state', id: s.id };
      applySelection();
    }
    return;
  }

  if (tool === 'connect') {
    if (stateG) {
      if (!connectFrom) {
        connectFrom = stateG.dataset.id;
        stateEls.get(connectFrom).classList.add('connect-src');
        tempEdge.hidden = false;
        updateTempEdge(e);
      } else {
        const from = connectFrom, to = stateG.dataset.id;
        openPopover(from, to, e.clientX, e.clientY);
        cancelConnect();
      }
    } else {
      cancelConnect();
    }
    return;
  }

  /* mode select */
  if (stateG) {
    const s = model.getState(stateG.dataset.id);
    const g = toGraph(e.clientX, e.clientY);
    dragState = { id: s.id, offX: g.x - s.x, offY: g.y - s.y };
    selection = { type: 'state', id: s.id };
    applySelection();
    e.preventDefault();
  } else if (edgeG) {
    selection = { type: 'edge', id: edgeG.dataset.id };
    applySelection();
  } else {
    panView = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y, moved: 0 };
  }
});

window.addEventListener('pointermove', (e) => {
  hoverStateId = e.target.closest?.('.state')?.dataset.id || null;
  if (dragState) {
    const g = toGraph(e.clientX, e.clientY);
    model.moveState(dragState.id, g.x - dragState.offX, g.y - dragState.offY);
    const s = model.getState(dragState.id);
    updateStateEl(s);
    model.edgesTouching(s.id).forEach(updateEdgeEl);
  } else if (panView) {
    const dx = e.clientX - panView.startX, dy = e.clientY - panView.startY;
    panView.moved = Math.max(panView.moved, Math.hypot(dx, dy));
    view.x = panView.viewX + dx;
    view.y = panView.viewY + dy;
    applyView();
  } else if (connectFrom) {
    updateTempEdge(e);
  }
});

window.addEventListener('pointerup', () => {
  if (dragState) dragState = null;
  if (panView) {
    if (panView.moved < 5) { selection = null; applySelection(); } // klik di background = batal pilih
    panView = null;
  }
});

svg.addEventListener('dblclick', (e) => {
  if (simActive()) return;
  const stateG = e.target.closest('.state');
  if (stateG) {
    model.toggleFinal(stateG.dataset.id);
    updateStateEl(model.getState(stateG.dataset.id));
    renderInspector();
  } else if (!e.target.closest('.edge')) {
    const g = toGraph(e.clientX, e.clientY);
    const s = model.addState(g.x, g.y);
    buildStateEl(s);
    selection = { type: 'state', id: s.id };
    applySelection();
  }
});

/* panah sementara saat mode transisi */
function updateTempEdge(e) {
  const src = model.getState(connectFrom);
  if (!src) return;
  const g = toGraph(e.clientX, e.clientY);
  let ex = g.x, ey = g.y;
  const target = hoverStateId && hoverStateId !== connectFrom ? model.getState(hoverStateId) : null;
  if (target) {
    const dx = g.x - target.x, dy = g.y - target.y;
    const L = Math.hypot(dx, dy) || 1;
    ex = target.x + (dx / L) * (STATE_R + ARROW_GAP);
    ey = target.y + (dy / L) * (STATE_R + ARROW_GAP);
  }
  const dx = g.x - src.x, dy = g.y - src.y;
  const L = Math.hypot(dx, dy) || 1;
  const sx = src.x + (dx / L) * STATE_R, sy = src.y + (dy / L) * STATE_R;
  tempEdge.setAttribute('d', `M ${sx} ${sy} L ${ex} ${ey}`);
  tempEdge.classList.toggle('snap', !!target);
}
function cancelConnect() {
  if (connectFrom) stateEls.get(connectFrom)?.classList.remove('connect-src');
  connectFrom = null;
  tempEdge.hidden = true;
}

/* zoom: tombol + scroll */
$('#zoomIn').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); });
$('#zoomOut').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); });
$('#zoomFit').addEventListener('click', fitView);
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

/* ---------- handle resize: lebar panel & tinggi konsol ---------- */
const setPanelW = (px) => document.documentElement.style.setProperty('--panel-w', px + 'px');
const setConsoleH = (px) => document.documentElement.style.setProperty('--console-h', px + 'px');
const getPanelW = () => document.getElementById('panel').getBoundingClientRect().width;
const getConsoleH = () => document.querySelector('.console').getBoundingClientRect().height;
const resetPanelW = () => { document.documentElement.style.removeProperty('--panel-w'); try { localStorage.removeItem('dfa-panel-w'); } catch {} };
const resetConsoleH = () => { document.documentElement.style.removeProperty('--console-h'); try { localStorage.removeItem('dfa-console-h'); } catch {} };

function initResizer(handle, { axis, get, set, reset, min, max, invert = true }) {
  const clampApply = (v) => {
    const mx = typeof max === 'function' ? max() : max;
    const c = Math.round(Math.max(min, Math.min(mx, v)));
    set(c);
    try { localStorage.setItem(axis === 'x' ? 'dfa-panel-w' : 'dfa-console-h', c); } catch {}
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.focus(); // preventDefault membatalkan fokus klik — pulihkan manual
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add(axis === 'x' ? 'resizing-v' : 'resizing-h');
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startVal = get();
    const onMove = (ev) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY;
      // tarik ke kiri/atas (delta negatif) memperbesar ukuran
      clampApply(startVal + (invert ? 1 : -1) * (startPos - cur));
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('resizing-v', 'resizing-h');
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', (e) => {
    const step = 28;
    let v = null;
    if (axis === 'x') {
      if (e.key === 'ArrowLeft') v = get() + step;
      if (e.key === 'ArrowRight') v = get() - step;
    } else {
      if (e.key === 'ArrowUp') v = get() + step;
      if (e.key === 'ArrowDown') v = get() - step;
    }
    if (v !== null) { e.preventDefault(); clampApply(v); }
    if (e.key === 'Home') { e.preventDefault(); reset(); }
  });
}

initResizer($('#panelResize'), {
  axis: 'x', get: getPanelW, set: setPanelW, reset: resetPanelW,
  min: 230, max: () => Math.min(560, window.innerWidth * 0.6),
});
initResizer($('#consoleResize'), {
  axis: 'y', get: getConsoleH, set: setConsoleH, reset: resetConsoleH,
  min: 132, max: () => window.innerHeight * 0.7,
});

// pulihkan ukuran tersimpan
try {
  const pw = parseInt(localStorage.getItem('dfa-panel-w'), 10);
  if (pw >= 230) setPanelW(Math.min(pw, 560));
  const ch = parseInt(localStorage.getItem('dfa-console-h'), 10);
  if (ch >= 132) setConsoleH(ch);
} catch {}

/* ---------- popover simbol transisi ---------- */
let pendingConnect = null; // { from, to }
let lastSymbols = '';
function openPopover(from, to, clientX, clientY) {
  pendingConnect = { from, to };
  const a = model.getState(from), b = model.getState(to);
  popSub.textContent = `${a.label} → ${b.label}${from === to ? ' (loop)' : ''}`;
  popInput.value = lastSymbols;
  popErr.hidden = true;
  popover.hidden = false;
  const pw = popover.offsetWidth || 240, ph = popover.offsetHeight || 200;
  popover.style.left = Math.min(window.innerWidth - pw - 12, Math.max(12, clientX - pw / 2)) + 'px';
  popover.style.top = Math.min(window.innerHeight - ph - 12, Math.max(12, clientY - ph - 16)) + 'px';
  popInput.focus();
  popInput.select();
}
function closePopover() {
  popover.hidden = true;
  pendingConnect = null;
}
function confirmPopover() {
  if (!pendingConnect) return closePopover();
  const { symbols, valid } = parseSymbolList(popInput.value);
  if (!valid || !symbols.length) {
    popErr.textContent = valid ? 'Isi minimal satu simbol.' : 'Setiap simbol harus tepat satu karakter.';
    popErr.hidden = false;
    popInput.focus();
    return;
  }
  const { edge, moved } = model.addTransition(pendingConnect.from, pendingConnect.to, symbols);
  lastSymbols = symbols.join(',');
  if (moved.length) toast(`Simbol ${moved.join(', ')} dipindah ke transisi baru (DFA harus deterministik).`);
  syncGraph();
  selection = { type: 'edge', id: edge.id };
  applySelection();
  closePopover();
  updateEmptyHint();
}
$('#popOk').addEventListener('click', confirmPopover);
$('#popCancel').addEventListener('click', closePopover);
popInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmPopover();
  if (e.key === 'Escape') closePopover();
});
popover.querySelectorAll('.pop-chips button').forEach((b) =>
  b.addEventListener('click', () => {
    popInput.value = popInput.value ? popInput.value.replace(/,\s*$/, '') + ',' + b.dataset.sym : b.dataset.sym;
    popInput.focus();
  })
);

/* ---------- token chips ---------- */
function renderTokens(state = 'pending') {
  const str = inputString.value.replace(/\s+/g, '');
  const chars = str.length ? [...str] : ['ε'];
  tokensEl.replaceChildren(...chars.map((c, i) => {
    const chip = document.createElement('span');
    chip.className = `chip ${state}`;
    chip.dataset.idx = i;
    chip.textContent = c;
    return chip;
  }));
}
function setChip(idx, cls) {
  const chip = tokensEl.querySelector(`[data-idx="${idx}"]`);
  if (chip) chip.className = `chip ${cls}`;
}

/* ---------- mesin simulasi ---------- */
const sim = { runId: 0, playing: false, idx: 0, cur: null, tokens: [], finished: false };
const simActive = () => sim.cur !== null;

function setPlayUI() {
  const playing = sim.playing;
  playBtn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  playLabel.textContent = playing ? 'Jeda' : sim.finished ? 'Ulangi' : 'Simulasi';
  stepBtn.disabled = playing;
  const lock = simActive();
  inputString.disabled = lock;
  toolBtns.forEach((b) => (b.disabled = lock));
}
function markState(id, cls, on = true) {
  stateEls.get(id)?.classList.toggle(cls, on);
}
function markEdge(id, cls, on = true) {
  edgeEls.get(id)?.classList.toggle(cls, on);
}

function beginSim() {
  const v = model.validateDfa();
  if (!v.ok) {
    toast(v.msg, 'error');
    termLine(v.msg, 'err');
    status(v.msg);
    return false;
  }
  if (v.warn) {
    toast(v.warn, 'warn');
    termLine(v.warn, 'dim');
  }
  sim.idx = 0;
  sim.finished = false;
  sim.cur = model.startState.id;
  sim.tokens = [...inputString.value.replace(/\s+/g, '')];
  renderTokens();
  markState(sim.cur, 'current');
  const head = sim.tokens.length
    ? `mulai dari state ${model.startState.label} dengan ${sim.tokens.length} simbol`
    : `mulai dari state ${model.startState.label}, string kosong`;
  termLine(head, 'dim');
  status(`Mulai dari ${model.startState.label}${sim.tokens.length ? '' : ' (string kosong ε)'}.`);
  setPlayUI();
  renderInspector();
  return true;
}

/** Animasikan orb menyusuri path edge; resolve setelah tiba. */
function travel(edgeId, runToken) {
  return new Promise((resolve) => {
    const g = edgeEls.get(edgeId);
    const path = g.querySelector('.line');
    const len = path.getTotalLength();
    markEdge(edgeId, 'active');
    const dur = TRAVEL_MS / speedVal();
    orb.hidden = false;
    const t0 = performance.now();
    (function frame(now) {
      if (sim.runId !== runToken) { orb.hidden = true; clearTrail(); markEdge(edgeId, 'active', false); return resolve(); }
      const p = Math.min(1, (now - t0) / dur);
      const pt = path.getPointAtLength(easeInOut(p) * len);
      orb.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
      updateTrail(pt);
      if (p < 1) requestAnimationFrame(frame);
      else {
        markEdge(edgeId, 'active', false);
        markEdge(edgeId, 'visited');
        resolve();
      }
    })(t0);
  });
}

/** Proses satu simbol (dipakai tombol Langkah & putar otomatis). */
async function stepOnce(runToken) {
  if (sim.runId !== runToken) return;
  if (!simActive() && !beginSim()) return;
  if (sim.idx >= sim.tokens.length) return finish();

  const sym = sim.tokens[sim.idx];
  setChip(sim.idx, 'current');
  const fromState = model.getState(sim.cur);
  const t = model.delta(sim.cur, sym);

  if (!t) {
    setChip(sim.idx, 'fail');
    markState(sim.cur, 'fail');
    sim.finished = true;
    termLine(`baca '${sym}': tidak ada transisi dari ${fromState.label}, string macet`, 'err');
    showResult(false, `Tidak ada transisi '${sym}' dari ${fromState.label}`);
    status(`Macet: tidak ada transisi '${sym}' dari ${fromState.label}.`);
    setPlayUI();
    return;
  }

  await travel(t.edgeId, runToken);
  if (sim.runId !== runToken) return;

  setChip(sim.idx, 'done');
  markState(sim.cur, 'current', false);
  sim.cur = t.to;
  markState(sim.cur, 'current');
  sim.idx++;
  termLine(`baca '${sym}' (${sim.idx}/${sim.tokens.length}): pindah dari ${fromState.label} ke ${model.getState(t.to).label}`);
  if (sim.idx >= sim.tokens.length) finish();
}

function finish() {
  sim.finished = true;
  sim.playing = false;
  orb.hidden = true;
  clearTrail();
  const s = model.getState(sim.cur);
  const accepted = s.final;
  termLine(accepted
    ? `selesai di ${s.label} yang merupakan state akhir — string DITERIMA`
    : `selesai di ${s.label} yang bukan state akhir — string DITOLAK`, accepted ? 'ok' : 'err');
  showResult(accepted, accepted
    ? `Berhenti di ${s.label} — state akhir`
    : `Berhenti di ${s.label} — bukan state akhir`);
  status(accepted ? `String diterima (berhenti di ${s.label} ∈ F).` : `String ditolak (berhenti di ${s.label} ∉ F).`);
  setPlayUI();
}

async function playAll() {
  if (sim.playing) { sim.playing = false; setPlayUI(); return; } // tombol = jeda
  if (sim.finished || !simActive()) resetSim(false);
  const token = ++sim.runId;
  if (!simActive() && !beginSim()) return;
  sim.playing = true;
  setPlayUI();
  while (sim.playing && !sim.finished && sim.runId === token) {
    await stepOnce(token);
    if (sim.runId !== token) return;
    if (sim.playing && !sim.finished) await sleep(PAUSE_MS / speedVal());
  }
  if (sim.runId === token) { sim.playing = false; setPlayUI(); }
}

function resetSim(rerenderInspector = true) {
  sim.runId++;
  sim.playing = false;
  sim.finished = false;
  sim.idx = 0;
  sim.cur = null;
  orb.hidden = true;
  clearTrail();
  termClear();
  termLine('siap — menunggu simulasi', 'dim');
  stateEls.forEach((g) => g.classList.remove('current', 'fail'));
  edgeEls.forEach((g) => g.classList.remove('active', 'visited'));
  resultEl.hidden = true;
  renderTokens();
  setPlayUI();
  if (rerenderInspector) renderInspector();
}

playBtn.addEventListener('click', playAll);
stepBtn.addEventListener('click', () => {
  if (sim.playing) return;
  if (sim.finished) { resetSim(); beginSim(); return; } // mulai ulang dari state awal
  const token = sim.runId;
  if (!simActive() && !beginSim()) return;
  stepOnce(token);
});
resetBtn.addEventListener('click', () => { resetSim(); status('Simulasi direset. Siap mencoba lagi.'); });
inputString.addEventListener('input', () => { if (simActive()) return; renderTokens(); });
inputString.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !simActive()) playAll(); });
speedRange.addEventListener('input', () => {
  speedRead.textContent = '×' + speedRange.value;
});

/* ---------- hasil akhir + confetti ---------- */
function showResult(accepted, reason) {
  resultEl.hidden = false;
  resultEl.className = `result show ${accepted ? 'accepted' : 'rejected'}`;
  resultWord.textContent = accepted ? 'ACCEPTED' : 'REJECTED';
  // restart animasi CSS
  resultWord.style.animation = 'none';
  void resultWord.offsetWidth;
  resultWord.style.animation = '';
  resultReason.textContent = reason;
  if (accepted && !REDUCED) burstConfetti();
}

function burstConfetti() {
  const ctx = confettiCanvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth, H = window.innerHeight;
  confettiCanvas.width = W * dpr;
  confettiCanvas.height = H * dpr;
  confettiCanvas.hidden = false;
  ctx.scale(dpr, dpr);
  const colors = CONFETTI_COLORS[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
  const parts = [];
  for (let i = 0; i < 150; i++) {
    parts.push({
      x: W / 2 + (Math.random() - 0.5) * 140,
      y: H * 0.72,
      vx: (Math.random() - 0.5) * 11,
      vy: -7 - Math.random() * 8,
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length],
    });
  }
  const t0 = performance.now();
  (function frame(now) {
    const dt = now - t0;
    ctx.clearRect(0, 0, W, H);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.rot += p.vr; p.vx *= 0.99;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - dt / 2300);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (dt < 2300) requestAnimationFrame(frame);
    else { confettiCanvas.hidden = true; ctx.setTransform(1, 0, 0, 1, 0, 0); }
  })(t0);
}

/* ---------- preset ---------- */
function loadPreset(key) {
  const def = DFA_PRESETS[key];
  if (!def) return;
  model.states = [];
  model.edges = [];
  currentPresetKey = key;
  presetExplain = def.desc ? { name: def.name, desc: def.desc } : null;
  resetSim(false);
  const byLabel = {};
  def.states.forEach((d) => { byLabel[d.label] = model.addState(d.x, d.y, d); });
  def.edges.forEach(([f, t, syms]) => model.addTransition(byLabel[f].id, byLabel[t].id, syms.split(/[\s,]+/)));
  selection = null;
  cancelConnect();
  renderGraph();
  applySelection();
  fitView();
  inputString.value = def.sample;
  renderTokens();
  termLine(`contoh "${def.name}" dimuat — coba string "${def.sample}"`, 'dim');
  status(`Contoh "${def.name}" dimuat. Coba string "${def.sample}", lalu tekan Simulasi.`);
  toast(`Contoh "${def.name}" dimuat.`);
}
$('#presetSelect').addEventListener('change', (e) => {
  if (e.target.value) loadPreset(e.target.value);
  e.target.value = '';
});

/* ---------- panel mobile, bantuan, keyboard ---------- */
$('#panelToggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  $('#panelToggle').setAttribute('aria-expanded', String(open));
});
$('#panelClose').addEventListener('click', () => document.body.classList.remove('panel-open'));

const helpDialog = $('#helpDialog'), helpBackdrop = $('#helpBackdrop');
function openHelp() {
  helpDialog.hidden = false; helpBackdrop.hidden = false;
  $('#helpClose').focus();
}
function closeHelp() {
  helpDialog.hidden = true; helpBackdrop.hidden = true;
  $('#helpBtn').focus();
}
$('#helpBtn').addEventListener('click', openHelp);
$('#helpClose').addEventListener('click', closeHelp);
helpBackdrop.addEventListener('click', closeHelp);

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, select, textarea');
  if (e.key === 'Escape') {
    if (!helpDialog.hidden) return closeHelp();
    if (!popover.hidden) return closePopover();
    cancelConnect();
    selection = null;
    applySelection();
    return;
  }
  if (typing) return;
  if (e.key === '1') setTool('select');
  else if (e.key === '2') setTool('add');
  else if (e.key === '3') setTool('connect');
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selection && !simActive()) {
    e.preventDefault();
    if (selection.type === 'state') {
      model.edgesTouching(selection.id).forEach((ed) => removeEdgeEl(ed.id));
      model.removeState(selection.id);
      removeStateEl(selection.id);
    } else {
      model.removeEdge(selection.id);
      removeEdgeEl(selection.id);
    }
    selection = null;
    refreshAfterEdit();
  }
});

/* ---------- tema terang/gelap ---------- */
const themeBtn = $('#themeBtn');
const CONFETTI_COLORS = {
  light: ['#2563eb', '#60a5fa', '#059669', '#93c5fd', '#34d399'],
  dark: ['#5b9cf8', '#8ab4f8', '#34d399', '#a5c8fa', '#6ee7b7'],
};
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.querySelector('use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  themeBtn.setAttribute('aria-label', t === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode gelap');
}
let theme = 'light';
try {
  theme = localStorage.getItem('dfa-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch { /* abaikan storage yang diblokir */ }
applyTheme(theme);
themeBtn.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('dfa-theme', theme); } catch {}
  applyTheme(theme);
});

/* ---------- init ---------- */
applyView();
renderTokens();
loadPreset('startab');
setTool('select');
