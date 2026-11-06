// PKL Viewer webview. Receives a ready-made model from the extension (decoded in a worker thread) and draws it.
// All file text goes in with textContent, never parsed as HTML. No eval and no network access.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const nf = new Intl.NumberFormat('en-US');
  const S = { tab: 'tree', model: null, name: '', open: new Set([0]), arr: 0, rendered: false, error: null, init: null, tableIdx: 0 };

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v; // CSSOM, allowed by the CSP (style attributes are not)
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else e.setAttribute(k, v === true ? '' : v);
    }
    if (kids) for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }
  const plural = (n, w) => `${nf.format(n)} ${w}${n === 1 ? '' : 's'}`;

  // ---------- colors (reference palette from our tensor viewer: blue ramp, blue/red diverging) ----------
  const dark = () => !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function ramp(stops) {
    const cs = stops.map(([p, h]) => [p, hex(h)]);
    return t => {
      if (t <= cs[0][0]) return cs[0][1];
      for (let i = 1; i < cs.length; i++) if (t <= cs[i][0]) {
        const [p0, c0] = cs[i - 1], [p1, c1] = cs[i], f = (t - p0) / (p1 - p0);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
      return cs[cs.length - 1][1];
    };
  }
  function scales() {
    const mid = dark() ? '#383835' : '#f0efec';
    return {
      diverging: ramp([[0, '#0d366b'], [0.25, '#3987e5'], [0.5, mid], [0.75, '#e34948'], [1, '#7a1c1c']]),
      sequential: dark() ? ramp([[0, '#0d366b'], [0.5, '#3987e5'], [1, '#cde2fb']]) : ramp([[0, '#cde2fb'], [0.5, '#3987e5'], [1, '#0d366b']]),
    };
  }
  const tip = el('div', { class: 'tip', role: 'tooltip' });
  document.body.append(tip);
  function showTip(ev, lines) {
    tip.replaceChildren(...lines.map(l => el('div', { text: l })));
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + r.width > window.innerWidth - 4) x = ev.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 4) y = ev.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.style.display = 'none'; };

  function flash(text) {
    const f = el('div', { class: 'flash', role: 'status', text });
    document.body.append(f);
    setTimeout(() => f.remove(), 1800);
  }

  // ---------- messages ----------
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') { S.init = m; S.name = m.name; S.model = null; S.error = null; render(); }
    else if (m.type === 'model') {
      S.model = m.model; S.name = m.name; S.ms = m.ms; S.error = null; S.open = new Set([0]);
      const v = m.model.safety.verdict.level;
      S.tab = v === 'danger' || v === 'warn' ? 'safety' : m.model.error ? 'opcodes' : (m.model.frames.length && m.model.frames.some(f => f.ok) && m.model.tree.nodes.length < 400) ? 'tables' : 'tree';
      render();
      if (!S.rendered) { S.rendered = true; vscode.postMessage({ type: 'rendered' }); }
    } else if (m.type === 'error') { S.error = m.message; render(); }
    else if (m.type === 'copied') flash(`Copied ${plural(m.chars, 'character')}.`);
  });

  // ---------- layout ----------
  function render() {
    hideTip();
    const M = S.model;
    const head = el('header', { class: 'head' }, [
      el('div', { class: 'title' }, [el('span', { class: 'fname', text: S.name || 'pickle' }),
        M ? el('span', { class: 'meta', text: [`protocol ${M.protocol}`, S.init ? S.init.sizeText : '', plural(M.opCount, 'opcode'), M.ms !== undefined ? `decoded in ${nf.format(M.ms)} ms` : ''].filter(Boolean).join(' · ') }) : null]),
      el('div', { class: 'nopy', role: 'note' }, [el('span', { class: 'shield', 'aria-hidden': 'true', text: '◆' }), el('span', { text: 'Opened without Python. No code in this file was run.' })]),
    ]);
    const body = [];
    if (S.error) body.push(el('div', { class: 'notice err', role: 'alert' }, [el('strong', { text: 'Could not open this file. ' }), el('span', { text: S.error })]));
    else if (S.init && !S.init.plan.load) body.push(el('div', { class: 'notice big', role: 'alert', text: S.init.plan.message }));
    else if (!M) body.push(el('p', { class: 'loading', text: `Decoding ${S.init ? S.init.sizeText : ''} in a background thread...` }));
    else {
      const sv = M.safety.verdict;
      if (sv.level === 'danger' || sv.level === 'warn') {
        body.push(el('div', { class: `banner ${sv.level}`, role: 'alert' }, [el('strong', { text: sv.title }),
          sv.example ? el('code', { text: sv.example }) : null,
          el('span', { text: ' PKL Viewer did not run it. Do not load this file with pickle, joblib or torch.load unless you trust where it came from.' })]));
      }
      if (M.error) {
        body.push(el('div', { class: 'notice err', role: 'alert' }, [el('strong', { text: 'The file could not be fully decoded. ' }),
          el('span', { text: `${M.error.message} The Opcodes and Safety tabs show what was read up to byte ${nf.format(M.error.pos || 0)}.` }),
          M.notPickle ? el('span', { text: ` This does not look like a pickle file. It starts with "${M.notPickle.head}".` }) : null]));
      }
      const tabs = [['tree', 'Tree', M.tree ? '' : '0'], ['arrays', 'Arrays', String(M.arrays.length)], ['tables', 'Tables', String(M.frames.length)],
        ['opcodes', 'Opcodes', nf.format(M.opCount)], ['safety', 'Safety', sv.level === 'danger' ? '!' : sv.level === 'warn' ? '?' : '']];
      const bar = el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, badge]) => el('button', {
        class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': String(S.tab === id), 'data-tab': id,
        on: { click: () => { S.tab = id; render(); } },
      }, [el('span', { text: label }), badge ? el('span', { class: 'badge' + (id === 'safety' ? ' ' + sv.level : ''), text: badge }) : null])));
      bar.append(el('span', { class: 'spacer' }), el('button', { class: 'link', title: 'Read the file again', text: 'Reload', on: { click: () => { S.model = null; render(); vscode.postMessage({ type: 'reload' }); } } }));
      body.push(bar);
      const panel = el('section', { class: 'panel', role: 'tabpanel' });
      if (S.tab === 'tree') panel.append(treeView(M));
      else if (S.tab === 'arrays') panel.append(arraysView(M));
      else if (S.tab === 'tables') panel.append(tablesView(M));
      else if (S.tab === 'opcodes') panel.append(opcodesView(M));
      else panel.append(safetyView(M));
      body.push(panel);
    }
    app.replaceChildren(head, ...body);
  }

  // ---------- tree ----------
  function treeView(M) {
    if (!M.tree) return el('p', { class: 'muted', text: 'No tree: the file could not be decoded to the end.' });
    const N = M.tree.nodes;
    const wrap = el('div', { class: 'treewrap' });
    const tools = el('div', { class: 'tools' }, [
      el('button', { text: 'Expand all', on: { click: () => { for (let i = 0; i < N.length && S.open.size < 5000; i++) if (N[i].c) S.open.add(i); render(); } } }),
      el('button', { text: 'Collapse all', on: { click: () => { S.open = new Set([0]); render(); } } }),
      el('span', { class: 'muted', text: `${plural(N.length, 'node')}${M.tree.truncated ? ' (stopped at the node limit; large containers show their first items)' : ''}` }),
    ]);
    const list = el('div', { class: 'tree', role: 'tree' });
    const rows = [];
    const walk = (id, depth) => {
      if (rows.length > 20000) return;
      rows.push(treeRow(N, id, depth));
      const n = N[id];
      if (n.c && S.open.has(id)) {
        for (const c of n.c) walk(c, depth + 1);
        if (n.more) rows.push(el('div', { class: 'row more', style: `padding-left:${(depth + 1) * 16 + 22}px`, text: `... ${plural(n.more, 'more item')} not shown` }));
      }
    };
    walk(0, 0);
    list.append(...rows);
    wrap.append(tools, list);
    return wrap;
  }

  function treeRow(N, id, depth) {
    const n = N[id];
    const hasKids = !!(n.c && n.c.length);
    const open = S.open.has(id);
    const toggle = () => { if (!hasKids) return; if (open) S.open.delete(id); else S.open.add(id); render(); };
    const kids = [
      el('span', { class: 'tw', 'aria-hidden': 'true', text: hasKids ? (open ? '▾' : '▸') : '' }),
      n.k !== '' ? el('span', { class: 'key', text: n.k }) : null,
      el('span', { class: 'type' + (n.ph ? ' ph' : ''), text: n.t }),
      n.len ? el('span', { class: 'len', text: n.len }) : null,
    ];
    if (n.ph) kids.push(el('span', { class: 'tag', title: 'This class was not rebuilt. PKL Viewer shows the data the file passes to it.', text: 'placeholder' }));
    if (n.ref !== undefined) kids.push(el('span', { class: 'tag', text: 'same object as above' }));
    if (!(hasKids && open) && n.v) kids.push(el('span', { class: 'val', text: n.v }));
    if (n.arr !== undefined) kids.push(el('button', { class: 'link', text: 'Show array', on: { click: e => { e.stopPropagation(); S.tab = 'arrays'; S.arr = n.arr; render(); } } }));
    if (n.df !== undefined) kids.push(el('button', { class: 'link', text: 'Show table', on: { click: e => { e.stopPropagation(); S.tab = 'tables'; S.tableIdx = n.df; render(); } } }));
    const row = el('div', { class: 'row', role: 'treeitem', tabindex: '0', 'aria-expanded': hasKids ? String(open) : undefined, style: `padding-left:${depth * 16 + 4}px`, 'data-id': String(id), on: {
      click: toggle,
      keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
    } }, kids);
    return row;
  }

  // ---------- arrays ----------
  function arraysView(M) {
    if (!M.arrays.length) return el('p', { class: 'muted', text: 'No NumPy arrays in this file.' });
    if (S.arr >= M.arrays.length) S.arr = 0;
    const list = el('div', { class: 'alist', role: 'listbox', 'aria-label': 'Arrays' }, M.arrays.map((a, i) => el('button', {
      class: 'aitem' + (i === S.arr ? ' on' : ''), role: 'option', 'aria-selected': String(i === S.arr), on: { click: () => { S.arr = i; render(); } },
    }, [el('span', { class: 'apath', text: a.path }), el('span', { class: 'muted', text: `${a.dtype || ''} ${a.shape ? '(' + a.shape.join(', ') + (a.shape.length === 1 ? ',' : '') + ')' : ''}` })])));
    return el('div', { class: 'arrays' }, [list, arrayDetail(M.arrays[S.arr])]);
  }

  function fact(label, value) { return el('div', { class: 'fact' }, [el('span', { class: 'fl', text: label }), el('span', { class: 'fv', text: value })]); }

  function arrayDetail(a) {
    const facts = el('div', { class: 'facts' }, [
      fact('Path', a.path), fact('Class', a.clsName || 'numpy.ndarray'), fact('dtype', `${a.dtype || '?'}${a.dtypeCode ? ' (' + a.dtypeCode + ')' : ''}`),
      fact('Shape', a.shape ? `(${a.shape.join(', ')}${a.shape.length === 1 ? ',' : ''})` : '?'), fact('Values', a.count !== undefined ? nf.format(a.count) : '?'),
      a.order ? fact('Order', a.order === 'F' ? 'F (Fortran, column major)' : 'C (row major)') : null,
      a.bytes !== undefined ? fact('Data bytes', nf.format(a.bytes)) : null,
      a.statsText ? fact('Min', a.statsText.min) : null, a.statsText ? fact('Max', a.statsText.max) : null, a.statsText ? fact('Mean', a.statsText.mean) : null,
      a.stats && (a.stats.nan || a.stats.inf) ? fact('NaN / inf', `${nf.format(a.stats.nan)} / ${nf.format(a.stats.inf)}`) : null,
    ]);
    const out = [facts];
    if (a.note) out.push(el('p', { class: 'note', text: a.note }));
    if (a.heat) out.push(el('h3', { text: 'Heatmap' }), heatmap(a.heat, Math.min(720, Math.max(260, app.clientWidth - 360))));
    if (a.grid) out.push(el('h3', { text: 'Values' }), valueGrid(a.grid));
    return el('div', { class: 'adetail' }, out);
  }

  function canvas(w, h) {
    const c = el('canvas', { width: Math.round(w * devicePixelRatio), height: Math.round(h * devicePixelRatio) });
    c.style.width = w + 'px'; c.style.height = h + 'px';
    const g = c.getContext('2d');
    g.scale(devicePixelRatio, devicePixelRatio);
    return { c, g };
  }

  function heatmap(v, W) {
    const data = v.data.map(x => (x === null ? NaN : x));
    let lo = Infinity, hi = -Infinity;
    for (const x of data) if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; }
    const sc = scales();
    const diverging = lo < 0 && hi > 0;
    let a = lo, b = hi;
    if (diverging) { const m = Math.max(-lo, hi); a = -m; b = m; }
    if (a === b) b = a + 1;
    const color = diverging ? sc.diverging : sc.sequential;
    const off = el('canvas', { width: v.cols, height: v.rows });
    const og = off.getContext('2d');
    const img = og.createImageData(v.cols, v.rows);
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      if (!Number.isFinite(x)) { img.data[i * 4 + 3] = 0; continue; }
      const c = color(Math.max(0, Math.min(1, (x - a) / (b - a))));
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    og.putImageData(img, 0, 0);
    const H = Math.round(Math.max(48, Math.min(380, W * (v.srcRows / v.srcCols))));
    const { c, g } = canvas(W, H);
    g.imageSmoothingEnabled = false;
    g.drawImage(off, 0, 0, W, H);
    c.className = 'heat';
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', `Heatmap of ${v.srcRows} by ${v.srcCols} values`);
    c.addEventListener('mousemove', ev => {
      const col = Math.min(v.cols - 1, Math.floor((ev.offsetX / W) * v.cols)), row = Math.min(v.rows - 1, Math.floor((ev.offsetY / H) * v.rows));
      const r0 = Math.floor((row * v.srcRows) / v.rows), r1 = Math.floor(((row + 1) * v.srcRows) / v.rows) - 1;
      const c0 = Math.floor((col * v.srcCols) / v.cols), c1 = Math.floor(((col + 1) * v.srcCols) / v.cols) - 1;
      const val = data[row * v.cols + col];
      showTip(ev, [r0 >= r1 ? `row ${r0}` : `rows ${r0} to ${r1}`, c0 >= c1 ? `column ${c0}` : `columns ${c0} to ${c1}`, Number.isFinite(val) ? (r0 >= r1 && c0 >= c1 ? 'value ' : 'mean ') + fmt(val) : 'no finite value']);
    });
    c.addEventListener('mouseleave', hideTip);
    const bar = canvas(W, 10);
    for (let x = 0; x < W; x++) { const cc = color(x / (W - 1)); bar.g.fillStyle = `rgb(${cc[0] | 0},${cc[1] | 0},${cc[2] | 0})`; bar.g.fillRect(x, 0, 1.5, 10); }
    const cap = [v.rows === v.srcRows && v.cols === v.srcCols ? `${nf.format(v.srcRows)} x ${nf.format(v.srcCols)}, one cell per value.` : `${nf.format(v.srcRows)} x ${nf.format(v.srcCols)} shown as ${v.rows} x ${v.cols} cells, each the mean of its block${v.sampled ? ' (rows sampled evenly)' : ''}.`];
    if (v.reshaped) cap.push('Leading dimensions are flattened into rows.');
    if (v.transposed) cap.push('Fortran order: shown transposed.');
    const viz = el('div', { class: 'viz' });
    viz.style.width = W + 'px';
    viz.append(c, bar.c, el('div', { class: 'scale' }, [el('span', { text: fmt(a) }), diverging ? el('span', { text: '0' }) : null, el('span', { text: fmt(b) })]), el('p', { class: 'cap', text: cap.join(' ') }));
    return viz;
  }
  function fmt(x) { if (!Number.isFinite(x)) return String(x); const ax = Math.abs(x); return ax !== 0 && (ax < 1e-3 || ax >= 1e6) ? x.toExponential(3) : String(Number(x.toPrecision(5))); }

  function valueGrid(g) {
    const t = el('table', { class: 'grid' });
    if (g.flat) {
      t.append(el('thead', null, [el('tr', null, [el('th', { text: '' }), ...Array.from({ length: Math.min(g.per, g.shown) }, (_, i) => el('th', { text: '+' + i }))])]));
      t.append(el('tbody', null, g.cells.map((r, i) => el('tr', null, [el('th', { text: String(i * g.per) }), ...r.map(x => el('td', { text: x }))]))));
      return el('div', { class: 'gridwrap' }, [t, g.count > g.shown ? el('p', { class: 'cap', text: `First ${nf.format(g.shown)} of ${nf.format(g.count)} values.` }) : null]);
    }
    t.append(el('thead', null, [el('tr', null, [el('th', { text: '' }), ...Array.from({ length: g.shownCols }, (_, i) => el('th', { text: String(i) }))])]));
    t.append(el('tbody', null, g.cells.map((r, i) => el('tr', null, [el('th', { text: String(i) }), ...r.map(x => el('td', { text: x }))]))));
    return el('div', { class: 'gridwrap' }, [t, g.rows > g.shownRows || g.cols > g.shownCols ? el('p', { class: 'cap', text: `Top-left ${g.shownRows} x ${g.shownCols} of ${nf.format(g.rows)} x ${nf.format(g.cols)}.` }) : null]);
  }

  // ---------- tables ----------
  function tablesView(M) {
    if (!M.frames.length) return el('p', { class: 'muted', text: 'No pandas DataFrame in this file.' });
    if (S.tableIdx >= M.frames.length) S.tableIdx = 0;
    const pick = M.frames.length > 1 ? el('div', { class: 'tools' }, M.frames.map((f, i) => el('button', { class: i === S.tableIdx ? 'on' : '', text: f.path, on: { click: () => { S.tableIdx = i; render(); } } }))) : null;
    const f = M.frames[S.tableIdx];
    if (!f.ok) {
      return el('div', null, [pick, el('div', { class: 'notice', role: 'note' }, [el('strong', { text: 'This DataFrame is shown as a tree. ' }), el('span', { text: f.reason + ' ' }),
        el('button', { class: 'link', text: 'Open it in the Tree tab', on: { click: () => { S.tab = 'tree'; openTo(M, f.node); render(); } } })])]);
    }
    const t = el('table', { class: 'grid df' });
    t.append(el('thead', null, [
      el('tr', null, [el('th', { class: 'ix', text: f.indexName || '' }), ...f.columns.map(c => el('th', { text: c.name }))]),
      el('tr', { class: 'dtypes' }, [el('th', { class: 'ix', text: '' }), ...f.columns.map(c => el('th', { text: c.dtype }))]),
    ]));
    t.append(el('tbody', null, f.cells.map((r, i) => el('tr', null, [el('th', { class: 'ix', text: f.index[i] }), ...r.map(x => el('td', { text: x }))]))));
    const copy = el('button', { text: 'Copy as TSV', on: { click: () => {
      const lines = [[f.indexName || '', ...f.columns.map(c => c.name)].join('\t'), ...f.cells.map((r, i) => [f.index[i], ...r].join('\t'))];
      vscode.postMessage({ type: 'copy', text: lines.join('\n') });
    } } });
    return el('div', null, [pick, el('div', { class: 'tools' }, [el('strong', { text: 'pandas.DataFrame' }), el('span', { class: 'muted', text: `${plural(f.rows, 'row')} x ${plural(f.cols, 'column')} at ${f.path}` }), copy]),
      el('div', { class: 'gridwrap' }, [t]), f.rows > f.shownRows ? el('p', { class: 'cap', text: `First ${nf.format(f.shownRows)} of ${nf.format(f.rows)} rows.` }) : null]);
  }

  function openTo(M, id) {
    // open every ancestor of node id
    const N = M.tree.nodes;
    const parent = new Map();
    N.forEach((n, i) => { if (n.c) for (const c of n.c) parent.set(c, i); });
    S.open.add(id);
    for (let p = parent.get(id); p !== undefined; p = parent.get(p)) S.open.add(p);
  }

  // ---------- opcodes ----------
  function opcodesView(M) {
    const o = M.ops;
    const counts = Object.entries(o.counts).sort((a, b) => b[1] - a[1]);
    const lines = o.lines.map(l => `${String(l.pos).padStart(8)}: ${l.code.padEnd(4)} ${'    '.repeat(l.depth)}${l.name.padEnd(16)} ${l.arg}`.trimEnd());
    const text = lines.join('\n');
    return el('div', null, [
      el('div', { class: 'tools' }, [
        el('span', { class: 'muted', text: `${plural(o.total, 'opcode')}, protocol ${M.protocol}, newest opcode from protocol ${M.highest}.` }),
        el('button', { text: 'Copy listing', on: { click: () => vscode.postMessage({ type: 'copy', text }) } }),
      ]),
      el('div', { class: 'chips' }, counts.slice(0, 24).map(([k, v]) => el('span', { class: 'chip', text: `${k} ${nf.format(v)}` }))),
      o.error ? el('div', { class: 'notice err', text: `Stopped at byte ${nf.format(o.error.pos || 0)}: ${o.error.message}` }) : null,
      el('pre', { class: 'ops', 'aria-label': 'Opcode listing', text }),
      o.total > o.lines.length ? el('p', { class: 'cap', text: `First ${nf.format(o.lines.length)} of ${nf.format(o.total)} opcodes. The counts above and the Safety tab cover all of them.` }) : null,
    ]);
  }

  // ---------- safety ----------
  const LEVEL = { danger: 'Risky', warn: 'Check', custom: 'Needs package', data: 'Data type' };
  function safetyView(M) {
    const s = M.safety;
    const out = [
      el('div', { class: `verdict ${s.verdict.level}`, role: 'status' }, [el('strong', { text: s.verdict.title }), s.verdict.example ? el('code', { text: s.verdict.example }) : null]),
      el('p', { class: 'muted', text: 'PKL Viewer read these names from the file. It did not import or call any of them. Python\'s pickle.load imports every GLOBAL and STACK_GLOBAL name and calls every REDUCE and NEWOBJ target, so this list shows what loading the file would do. A clean list is not a guarantee: only load pickles you trust.' }),
      el('h3', { text: `Imported names (${s.imports.length})` }),
    ];
    if (!s.imports.length) out.push(el('p', { class: 'muted', text: 'None.' }));
    else {
      const t = el('table', { class: 'grid safety' });
      t.append(el('thead', null, [el('tr', null, ['Name', 'Rating', 'Times', 'First at byte', 'Why'].map(h => el('th', { text: h })))]));
      t.append(el('tbody', null, s.imports.sort((a, b) => rank(a.level) - rank(b.level)).map(i => el('tr', { class: i.level }, [
        el('td', null, [el('code', { text: i.target })]), el('td', null, [el('span', { class: `pill ${i.level}`, text: LEVEL[i.level] })]),
        el('td', { text: nf.format(i.count) }), el('td', { text: nf.format(i.first) }), el('td', { text: i.why }),
      ]))));
      out.push(el('div', { class: 'gridwrap' }, [t]));
    }
    out.push(el('h3', { text: `GLOBAL, STACK_GLOBAL, REDUCE and BUILD targets (${nf.format(s.eventCount)})` }));
    const rows = s.rows.slice(0, 3000);
    if (!rows.length) out.push(el('p', { class: 'muted', text: 'None. The file only holds plain values.' }));
    else {
      const t = el('table', { class: 'grid safety' });
      t.append(el('thead', null, [el('tr', null, ['Byte', 'Opcode', 'Target', 'Arguments', 'Rating'].map(h => el('th', { text: h })))]));
      t.append(el('tbody', null, rows.map(r => el('tr', { class: r.level }, [
        el('td', { text: nf.format(r.pos) }), el('td', { text: r.op }), el('td', null, [el('code', { text: r.target })]),
        el('td', null, r.args ? [el('code', { text: r.args })] : []), el('td', null, [el('span', { class: `pill ${r.level}`, text: LEVEL[r.level] })]),
      ]))));
      out.push(el('div', { class: 'gridwrap' }, [t]));
      if (s.eventCount > rows.length) out.push(el('p', { class: 'cap', text: `First ${nf.format(rows.length)} of ${nf.format(s.eventCount)}. Every imported name is in the table above.` }));
    }
    return el('div', null, out);
  }
  const rank = l => ({ danger: 0, warn: 1, custom: 2, data: 3 }[l] ?? 4);

  // Read-only state for the release check script.
  window.pickleViewerProbe = () => ({
    loaded: !!S.model, tab: S.tab, error: S.error, plan: S.init && S.init.plan,
    nodes: S.model && S.model.tree ? S.model.tree.nodes.length : 0, arrays: S.model ? S.model.arrays.length : 0,
    frames: S.model ? S.model.frames.map(f => ({ ok: f.ok, rows: f.rows, cols: f.cols, reason: f.reason })) : [],
    verdict: S.model ? S.model.safety.verdict : null, protocol: S.model ? S.model.protocol : null,
  });

  vscode.postMessage({ type: 'ready' });
})();
