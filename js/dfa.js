/* =========================================================================
 * dfa.js — Model & logika DFA murni (tanpa DOM).
 * Dipakai oleh app.js untuk rendering dan simulasi.
 * ========================================================================= */
'use strict';

let _uidCounter = 1;
const uid = (prefix) => prefix + '_' + (_uidCounter++);

/** Pecah string simbol: "a,b 0" → ['a','b','0']; token multi-karakter ditandai tidak valid. */
function parseSymbolList(raw) {
  const tokens = String(raw).split(/[\s,]+/).filter(Boolean);
  const valid = tokens.every((t) => t.length === 1);
  return { symbols: [...new Set(tokens)], valid };
}

class DfaModel {
  constructor() {
    this.states = []; // { id, label, x, y, start, final }
    this.edges = [];  // { id, from, to, symbols:Set<string> }
  }

  /* ---------- state ---------- */

  nextLabel() {
    const used = new Set(this.states.map((s) => s.label));
    let i = 0;
    while (used.has('q' + i)) i++;
    return 'q' + i;
  }

  getState(id) {
    return this.states.find((s) => s.id === id) || null;
  }

  getStateByLabel(label) {
    return this.states.find((s) => s.label === label) || null;
  }

  addState(x, y, opts = {}) {
    const s = {
      id: uid('s'),
      label: opts.label || this.nextLabel(),
      x: Math.round(x),
      y: Math.round(y),
      start: !!opts.start,
      final: !!opts.final,
    };
    if (s.start) this.states.forEach((t) => (t.start = false));
    this.states.push(s);
    return s;
  }

  removeState(id) {
    this.states = this.states.filter((s) => s.id !== id);
    // transisi yang menyentuh state ini ikut terhapus
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
  }

  renameState(id, label) {
    const clean = label.trim();
    if (!clean) return { ok: false, error: 'Label tidak boleh kosong.' };
    if (this.states.some((s) => s.id !== id && s.label === clean)) {
      return { ok: false, error: `Label "${clean}" sudah dipakai.` };
    }
    this.getState(id).label = clean;
    return { ok: true };
  }

  moveState(id, x, y) {
    const s = this.getState(id);
    if (s) { s.x = Math.round(x); s.y = Math.round(y); }
  }

  setStart(id) {
    this.states.forEach((s) => (s.start = s.id === id));
  }

  toggleFinal(id) {
    const s = this.getState(id);
    if (s) s.final = !s.final;
  }

  /* ---------- transisi ---------- */

  getEdge(id) {
    return this.edges.find((e) => e.id === id) || null;
  }

  edgeBetween(from, to) {
    return this.edges.find((e) => e.from === from && e.to === to) || null;
  }

  /**
   * Set simbol pada sebuah edge. DFA harus deterministik: simbol yang sama
   * dari state asal akan dipindahkan (dihapus dari edge lama).
   * @returns { moved: string[] } daftar simbol yang direlokasi.
   */
  setEdgeSymbols(edgeId, symbols) {
    const edge = this.getEdge(edgeId);
    if (!edge) return { moved: [] };
    const moved = [];
    for (const sym of symbols) {
      for (const other of this.edges) {
        if (other.from === edge.from && other.id !== edge.id && other.symbols.has(sym)) {
          other.symbols.delete(sym);
          moved.push(sym);
        }
      }
      edge.symbols.add(sym);
    }
    // edge yang kehabisan simbol dibuang
    this.edges = this.edges.filter((e) => e.symbols.size > 0);
    return { moved: [...new Set(moved)] };
  }

  /** Tambah transisi; bila edge dengan arah sama sudah ada, simbol digabung. */
  addTransition(from, to, symbols) {
    let edge = this.edgeBetween(from, to);
    if (!edge) {
      edge = { id: uid('e'), from, to, symbols: new Set() };
      this.edges.push(edge);
    }
    const { moved } = this.setEdgeSymbols(edge.id, symbols);
    return { edge, moved };
  }

  removeEdge(id) {
    this.edges = this.edges.filter((e) => e.id !== id);
  }

  edgesTouching(stateId) {
    return this.edges.filter((e) => e.from === stateId || e.to === stateId);
  }

  /* ---------- eksekusi DFA ---------- */

  get startState() {
    return this.states.find((s) => s.start) || null;
  }

  /** Fungsi transisi δ(state, simbol) → id state tujuan + edge, atau null bila macet. */
  delta(stateId, symbol) {
    const e = this.edges.find((e) => e.from === stateId && e.symbols.has(symbol));
    return e ? { to: e.to, edgeId: e.id } : null;
  }

  alphabet() {
    const set = new Set();
    this.edges.forEach((e) => e.symbols.forEach((s) => set.add(s)));
    return [...set].sort();
  }

  finals() {
    return this.states.filter((s) => s.final);
  }

  /**
   * Validasi DFA sebelum simulasi.
   * Ditolak keras: tanpa state, tanpa state awal, atau tanpa state akhir.
   * Peringatan (tetap boleh jalan): tabel transisi belum total — mengikuti
   * gaya buku teks yang tidak menggambar transisi ke state gagal,
   * simbol tanpa transisi akan menolak string saat simulasi berjalan.
   */
  validateDfa() {
    if (this.states.length === 0) {
      return { ok: false, msg: 'DFA belum dibuat: minimal butuh satu state.' };
    }
    if (!this.startState) {
      return { ok: false, msg: 'Bukan DFA valid: belum ada state awal. Klik sebuah state lalu pilih "Jadikan awal".' };
    }
    if (this.finals().length === 0) {
      return { ok: false, msg: 'Bukan DFA valid: belum ada state akhir. Klik dua kali sebuah state untuk menjadikannya state akhir.' };
    }
    const sigma = this.alphabet();
    let warn = null;
    if (sigma.length === 0) {
      warn = 'Belum ada transisi sama sekali — semua simbol akan membuat string macet.';
    } else {
      const missing = [];
      for (const s of this.states) {
        for (const sym of sigma) {
          if (!this.delta(s.id, sym)) missing.push(`${s.label} pada '${sym}'`);
        }
      }
      if (missing.length) {
        const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : '');
        warn = `Transisi belum lengkap (DFA seharusnya total): ${shown}. Simbol tanpa transisi akan menolak string saat simulasi.`;
      }
    }
    return { ok: true, warn };
  }

  /** Tuple definisi formal, untuk tampilan ringkasan. */
  describe() {
    return {
      Q: this.states.map((s) => s.label),
      sigma: this.alphabet(),
      q0: this.startState ? this.startState.label : '—',
      F: this.finals().map((s) => s.label),
    };
  }
}

/* Contoh DFA siap pakai — desc menjelaskan alasan bentuk grafnya */
const DFA_PRESETS = {
  startab: {
    name: 'Diawali "ab"',
    sample: 'abba',
    desc: 'Tiga state menyusuri progres awalan "ab": S0 belum membaca apa pun, S1 setelah \'a\', S2 setelah \'ab\'. Begitu awalan "ab" terbentuk, string pasti diterima — karena itu S2 dibuat state akhir dan diberi loop \'a\',\'b\' agar sisa string apa pun tetap berada di S2. String yang menyimpang di awal (mis. "b…" atau "aa…") macet karena tidak punya transisi, sehingga ditolak.',
    states: [
      { label: 'S0', x: 170, y: 250, start: true },
      { label: 'S1', x: 430, y: 250 },
      { label: 'S2', x: 690, y: 250, final: true },
    ],
    edges: [
      ['S0', 'S1', 'a'],
      ['S1', 'S2', 'b'],
      ['S2', 'S2', 'a,b'],
    ],
  },
  even0: {
    name: 'Jumlah 0 genap',
    sample: '1001',
    desc: 'Dua state mewakili paritas jumlah \'0\': q0 = genap (state akhir), q1 = ganjil. Simbol \'0\' membalik paritas sehingga berpindah state, sedangkan \'1\' tidak mengubah hitungan sehingga tinggal di tempat (loop). String diterima tepat ketika jumlah \'0\'-nya genap — termasuk string kosong ε yang langsung berhenti di q0.',
    states: [
      { label: 'q0', x: 230, y: 230, start: true, final: true },
      { label: 'q1', x: 500, y: 230 },
    ],
    edges: [
      ['q0', 'q1', '0'], ['q1', 'q0', '0'],
      ['q0', 'q0', '1'], ['q1', 'q1', '1'],
    ],
  },
  endsab: {
    name: 'Berakhiran "ab"',
    sample: 'baab',
    desc: 'Setiap state mengingat kemiripan akhir string dengan pola "ab": q0 belum cocok, q1 akhirnya \'a\', q2 akhirnya \'ab\' (final). Dari q2, membaca \'a\' pindah ke q1 dan \'b\' kembali ke q0 karena hanya akhiran \'a\' atau \'ab\' lagi yang masih relevan. Inilah DFA minimal untuk bahasa "berakhiran ab".',
    states: [
      { label: 'q0', x: 170, y: 250, start: true },
      { label: 'q1', x: 420, y: 150 },
      { label: 'q2', x: 660, y: 250, final: true },
    ],
    edges: [
      ['q0', 'q1', 'a'], ['q0', 'q0', 'b'],
      ['q1', 'q1', 'a'], ['q1', 'q2', 'b'],
      ['q2', 'q1', 'a'], ['q2', 'q0', 'b'],
    ],
  },
  div3: {
    name: 'Biner habis dibagi 3',
    sample: '110',
    desc: 'Nilai biner dibaca bit demi bit: setiap bit b mengubah nilai n menjadi 2n + b. Tiga state menyimpan sisa bagi 3 dari nilai yang sudah dibaca: r0, r1, r2. Transisi r0 —1→ r1 karena 2·0+1 = 1; r1 —0→ r2 karena 2·1+0 = 2; r1 —1→ r0 karena 2·1+1 = 3 (sisa 0); dan seterusnya. r0 dibuat final karena sisa 0 berarti bilangan habis dibagi 3.',
    states: [
      { label: 'r0', x: 420, y: 140, start: true, final: true },
      { label: 'r1', x: 180, y: 340 },
      { label: 'r2', x: 660, y: 340 },
    ],
    edges: [
      ['r0', 'r0', '0'], ['r0', 'r1', '1'],
      ['r1', 'r2', '0'], ['r1', 'r0', '1'],
      ['r2', 'r1', '0'], ['r2', 'r2', '1'],
    ],
  },
};
