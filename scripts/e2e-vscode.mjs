// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated samples,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) if (fs.statSync(path.join(ws, f)).size < 50e6) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, { 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left' });
const shots = [];
const shot = async name => { const f = path.join(shotDir, `pkl-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 600), ms: Date.now() - t0 }); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.pickleViewerProbe ? window.pickleViewerProbe() : null)`));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 20000);
const open = async file => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); return Date.now() - t0; };
const loaded = async () => { const ok = await vs.waitFor(async () => (await probe())?.loaded, 30000, 200); if (!ok) throw new Error('not loaded: ' + await E(`document.body.innerText.slice(0, 400)`)); await sleep(300); return probe(); };
const text = sel => E(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const tabBtn = id => `document.querySelector('button.tab[data-tab="${id}"]')`;
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const row = key => `[...document.querySelectorAll('.tree .row')].find(r => (r.querySelector('.key') || {}).textContent === ${JSON.stringify(key)})`;

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('basic-protocol4.pickle opens by default: header, tree with types, placeholder class', async () => {
    const ms = await open('basic-protocol4.pickle'); const p = await loaded();
    const head = await text('.nopy');
    if (!/Opened without Python\. No code in this file was run\./.test(head) || p.protocol !== 4 || p.tab !== 'tree') throw new Error(JSON.stringify({ head, p }));
    await vs.wvClick(wv, row("'experiment'")); await sleep(250);
    await vs.wvClick(wv, row("'point'")); await sleep(250);
    await vs.wvClick(wv, row("'nested'")); await sleep(250);
    const rows = await E(`[...document.querySelectorAll('.tree .row')].map(r => r.innerText.replace(/\\s+/g, ' ')).join('\\n')`);
    if (!/\.name\s+str/.test(rows) || !/lab\.models\.Experiment/.test(rows) || !/placeholder/.test(rows) || !/'point'\s+tuple/.test(rows)) throw new Error(rows.slice(0, 800));
    await sleep(400);
    await shot('tree');
    return { openMs: ms, nodes: p.nodes, verdict: p.verdict.level, visibleRows: rows.split('\n').length, header: head };
  });
  await step('Opcodes tab by a real click: pickletools-style listing with STACK_GLOBAL and FRAME', async () => {
    await vs.wvClick(wv, tabBtn('opcodes')); await sleep(300);
    const listing = await text('pre.ops');
    if (!/STACK_GLOBAL/.test(listing) || !/PROTO\s+4/.test(listing) || !/FRAME/.test(listing)) throw new Error(listing.slice(0, 400));
    await shot('opcodes');
    await vs.wvClick(wv, btn('Copy listing')); await sleep(400);
    const clip = execSync('pbpaste', { encoding: 'utf8' });
    if (!/STACK_GLOBAL/.test(clip)) throw new Error('clipboard: ' + clip.slice(0, 100));
    return { lines: listing.split('\n').length, copiedChars: clip.length };
  });
  await step('Safety tab for a clean file: custom class needs its package, no risky names', async () => {
    await vs.wvClick(wv, tabBtn('safety')); await sleep(300);
    const v = await text('.verdict');
    if (!/No risky names found/.test(v) || !/lab/.test(v)) throw new Error(v);
    return { verdict: v };
  });
  await step('numpy-arrays-protocol2.pkl: Show array, stats and heatmap', async () => {
    await open('numpy-arrays-protocol2.pkl'); await loaded();
    await vs.wvClick(wv, `${row("'weights'")}.querySelector('button.link')`); await sleep(500);
    const p = await probe();
    const facts = await E(`document.querySelector('.facts').innerText.replace(/\\n/g, ' | ')`);
    const heat = await E(`(() => { const c = document.querySelector('canvas.heat'); if (!c) return null; const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return { w: c.width, h: c.height, painted: n / (d.length / 4) }; })()`);
    if (p.tab !== 'arrays' || !/float32/.test(facts) || !/\(96, 128\)/.test(facts) || !heat || heat.painted < 0.9) throw new Error(JSON.stringify({ p, facts, heat }));
    // hover the heatmap: real mouse move gives a tooltip
    const off = await vs.wvOffset(); const b = JSON.parse(await E(`JSON.stringify(document.querySelector('canvas.heat').getBoundingClientRect())`));
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: off.x + b.x + b.width * 0.3, y: off.y + b.y + b.height * 0.4 }, vs.wb); await sleep(300);
    const tip = await text('.tip');
    await shot('arrays');
    await vs.wvClick(wv, `[...document.querySelectorAll('.aitem')].find(b => b.textContent.includes("'fortran'"))`); await sleep(300);
    const grid = await E(`[...document.querySelectorAll('table.grid tbody tr')].map(r => [...r.querySelectorAll('td')].map(t => t.textContent).join(' ')).join(' / ')`);
    if (grid !== '0 1 2 3 / 4 5 6 7 / 8 9 10 11') throw new Error('fortran grid ' + grid);
    return { arrays: p.arrays, facts, heat, tooltip: tip, fortranGrid: grid };
  });
  await step('dataframe.pkl opens on the Tables tab: 6 rows x 4 columns with dtypes; Copy as TSV', async () => {
    await open('dataframe.pkl'); const p = await loaded();
    const head = await E(`[...document.querySelectorAll('table.df thead tr:first-child th')].map(t => t.textContent).join('|')`);
    const dt = await E(`[...document.querySelectorAll('table.df thead tr.dtypes th')].map(t => t.textContent).join('|')`);
    const rows = await E(`document.querySelectorAll('table.df tbody tr').length`);
    if (p.tab !== 'tables' || head !== '|city|population_k|area_km2|coastal' || dt !== '|object|int64|float64|bool' || rows !== 6) throw new Error(JSON.stringify({ p, head, dt, rows }));
    await shot('table');
    await vs.wvClick(wv, btn('Copy as TSV')); await sleep(400);
    const clip = execSync('pbpaste', { encoding: 'utf8' });
    if (!clip.startsWith('\tcity\tpopulation_k\tarea_km2\tcoastal\n0\tOslo\t709\t454.0\tTrue')) throw new Error(JSON.stringify(clip.slice(0, 120)));
    return { header: head, dtypes: dt, rows, tsvLines: clip.split('\n').length };
  });
  await step('risky-os-system.pkl: red banner, Safety tab first, os.system flagged with its argument', async () => {
    await open('risky-os-system.pkl'); const p = await loaded();
    const banner = await text('.banner');
    const table = await E(`[...document.querySelectorAll('table.safety tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ')).join('\\n')`);
    if (p.tab !== 'safety' || p.verdict.level !== 'danger' || !/os\.system\('true',\)/.test(banner) || !/REDUCE os\.system/.test(table)) throw new Error(JSON.stringify({ p, banner, table }));
    await shot('safety');
    return { banner, rows: table.split('\n') };
  });
  await step('risky-stack-global.pkl: STACK_GLOBAL targets subprocess.check_output and builtins.eval are flagged', async () => {
    await open('risky-stack-global.pkl'); const p = await loaded();
    const t = await E(`document.querySelector('table.safety').innerText`);
    if (p.verdict.level !== 'danger' || !/subprocess\.check_output/.test(t) || !/builtins\.eval/.test(t)) throw new Error(t);
    return { verdict: p.verdict.title };
  });
  await step('basic-protocol5.p opens with Reopen Editor With > PKL Viewer', async () => {
    vs.open(path.join(ws, 'basic-protocol5.p')); await sleep(1500);
    const picked = () => vs.wbEval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some(r => /PKL Viewer/.test(r.textContent))`);
    for (let attempt = 1; attempt <= 2 && !wv?.title?.endsWith('.p'); attempt++) {
      await vs.command('View: Reopen Editor With...');
      if (!await vs.waitFor(picked, 5000, 150)) { await vs.key('Escape', 'Escape'); continue; }
      await vs.type('PKL Viewer'); await sleep(500); await vs.key('Enter', 'Enter');
      const w = await getWv('basic-protocol5.p'); if (w) wv = w;
    }
    if (!wv || wv.title !== 'basic-protocol5.p') throw new Error('no webview for .p');
    const p = await loaded();
    if (p.protocol !== 5 || p.nodes < 40) throw new Error(JSON.stringify(p));
    return { protocol: p.protocol, nodes: p.nodes };
  });
  await step('huge.pkl (600 MB sparse): clear message, the file is not read', async () => {
    await open('huge.pkl');
    const t = await vs.waitFor(() => E(`(document.querySelector('.notice.big') || {}).textContent || ''`), 10000);
    await shot('over-512mb-message');
    if (!/600\.0 MB.*up to 512\.0 MB.*not read/.test(t)) throw new Error(t);
    return { notice: t };
  });
  await step('not-a-pickle.pkl: plain error, opcodes up to the damage', async () => {
    await open('not-a-pickle.pkl'); const p = await loaded();
    const t = await text('.notice.err');
    if (!/could not be fully decoded/.test(t) || !/does not look like a pickle file\. It starts with "hello, this is a text file"/.test(t)) throw new Error(t);
    return { tab: p.tab, notice: t };
  });
  await step('light theme renders the tree', async () => {
    // switch the isolated profile to a light theme by its settings file (VS Code applies it live)
    const sf = path.join(vs.ud, 'User', 'settings.json');
    const set = theme => { const j = JSON.parse(fs.readFileSync(sf, 'utf8')); j['workbench.colorTheme'] = theme; fs.writeFileSync(sf, JSON.stringify(j, null, 1)); };
    set('Default Light Modern'); await sleep(2000);
    await open('basic-protocol2.pkl'); await loaded();
    await vs.wvClick(wv, row("'experiment'")); await sleep(300);
    const light = await E(`document.body.classList.contains('vscode-light')`);
    await shot('light-theme');
    set('Default Dark Modern'); await sleep(1000);
    if (!light) throw new Error('not light');
    return { light };
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /pickle|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map(s => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
