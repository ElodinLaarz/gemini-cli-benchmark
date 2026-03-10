#!/usr/bin/env node
// =============================================================================
// Gemini CLI Live Profiling Dashboard
// Runs profiling iterations in an infinite background loop and streams results
// to the browser via Server-Sent Events (SSE).
// =============================================================================

import { createServer } from 'http';
import { spawn, exec } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PROFILES_DIR = join(ROOT, 'profiles');

// ─── Profile parsers (mirrored from generate-report.js) ──────────────────────

function findFiles(dir, pattern) {
  const results = [];
  if (!existsSync(dir)) return results;
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) results.push(full);
    }
  }
  walk(dir);
  return results;
}

function cpuProfileToFlameGraph(profile) {
  const { nodes } = profile;
  if (!nodes || nodes.length === 0) return null;
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, { ...node, children: node.children || [], selfTime: 0, totalTime: 0 });
  }
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const node = nodeMap.get(profile.samples[i]);
      if (node) node.selfTime += profile.timeDeltas[i] || 0;
    }
  }
  function calcTotalTime(id) {
    const node = nodeMap.get(id);
    if (!node) return 0;
    node.totalTime = node.selfTime;
    for (const childId of node.children) node.totalTime += calcTotalTime(childId);
    return node.totalTime;
  }
  calcTotalTime(nodes[0].id);
  function toFlameNode(id, depth = 0) {
    const node = nodeMap.get(id);
    if (!node || depth > 100) return null;
    const { functionName = '(anonymous)', url = '', lineNumber = 0 } = node.callFrame || {};
    const name = functionName || '(anonymous)';
    const shortUrl = url ? url.split('/').slice(-2).join('/') : '';
    const label = shortUrl ? `${name} (${shortUrl}:${lineNumber})` : name;
    const children = [];
    for (const childId of node.children) {
      const child = toFlameNode(childId, depth + 1);
      if (child && child.value > 0) children.push(child);
    }
    return { name: label, value: Math.max(node.totalTime, 1), selfValue: node.selfTime, children, data: { functionName: name, url, lineNumber, selfTime_us: node.selfTime, totalTime_us: node.totalTime } };
  }
  const root = toFlameNode(nodes[0].id);
  if (root) root.name = '(root)';
  return root;
}

function wallTraceToFlameGraph(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  events.sort((a, b) => a.ts - b.ts);
  const requires = events.filter(e => e.cat === 'require');
  const gcs = events.filter(e => e.cat === 'gc');
  const lags = events.filter(e => e.cat === 'event_loop');
  const root = { name: '(startup)', value: 0, children: [], data: { category: 'root' } };
  if (requires.length === 0) return root;
  root.value = requires.reduce((sum, e) => sum + (e.dur || 0), 0);
  const stack = [root];
  for (const req of requires) {
    const node = { name: req.name, value: req.dur || 1, children: [], data: { category: 'require', parent: req.args?.parent || '', duration_ms: ((req.dur || 0) / 1000).toFixed(2), timestamp_ms: ((req.ts - requires[0].ts) / 1000).toFixed(2) } };
    while (stack.length > 1) { const parent = stack[stack.length - 1]; if (parent._end && req.ts >= parent._end) stack.pop(); else break; }
    node._end = req.ts + (req.dur || 0);
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  if (gcs.length > 0) {
    const gcRoot = { name: `GC (${gcs.length} events)`, value: gcs.reduce((s, e) => s + (e.dur || 0), 0), children: gcs.map(gc => ({ name: gc.name, value: gc.dur || 1, children: [], data: { category: 'gc', duration_ms: ((gc.dur || 0) / 1000).toFixed(2) } })), data: { category: 'gc' } };
    root.children.push(gcRoot); root.value += gcRoot.value;
  }
  if (lags.length > 0) {
    const lagRoot = { name: `Event Loop Lag (${lags.length} events)`, value: lags.reduce((s, e) => s + (e.dur || 0), 0), children: lags.map(lag => ({ name: lag.name, value: lag.dur || 1, children: [], data: { category: 'event_loop', lag_ms: lag.args?.lag_ms } })), data: { category: 'event_loop' } };
    root.children.push(lagRoot); root.value += lagRoot.value;
  }
  return root;
}

function memTraceToData(memData) {
  if (!memData || !memData.snapshots) return null;
  const moduleMemory = new Map();
  for (const snap of memData.snapshots) {
    if (snap.label.startsWith('__')) continue;
    const existing = moduleMemory.get(snap.label) || { peak: 0, count: 0 };
    existing.peak = Math.max(existing.peak, snap.heapUsed);
    existing.count++;
    moduleMemory.set(snap.label, existing);
  }
  const categories = new Map();
  for (const [mod, data] of moduleMemory) {
    let cat = 'other';
    if (mod.includes('node_modules')) { const parts = mod.split('node_modules/'); cat = parts[parts.length - 1].split('/')[0]; if (cat.startsWith('@')) cat += '/' + parts[parts.length - 1].split('/')[1]; }
    else if (mod.startsWith('.') || mod.startsWith('/')) cat = 'app';
    else if (!mod.includes('/')) cat = 'node_builtin';
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push({ name: mod, value: data.peak, count: data.count });
  }
  const root = { name: '(memory)', value: 0, children: [] };
  for (const [cat, modules] of categories) {
    const catValue = modules.reduce((s, m) => s + m.value, 0);
    root.children.push({ name: cat, value: catValue, children: modules.map(m => ({ name: m.name, value: m.value, children: [], data: { heap_bytes: m.value, load_count: m.count } })), data: { category: cat } });
    root.value += catValue;
  }
  return { flameGraph: root, timeline: memData.snapshots.map(s => ({ t: s.timestamp_ms, heapUsed: s.heapUsed, heapTotal: s.heapTotal, rss: s.rss, external: s.external, label: s.label, moduleIndex: s.moduleIndex })), totalModules: memData.totalModulesLoaded };
}

function collectRunData(inputDir) {
  const runs = [];
  const combinedDir = join(inputDir, 'combined');
  if (!existsSync(combinedDir)) return { runs: [], useDemoData: true };
  for (const entry of readdirSync(combinedDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run_')) continue;
    const runDir = join(combinedDir, entry.name);
    const runNum = parseInt(entry.name.replace('run_', ''), 10);
    if (isNaN(runNum)) continue;
    const run = { id: runNum, dir: runDir };
    const ttiFile = join(runDir, 'tti_ms');
    if (existsSync(ttiFile)) { const val = readFileSync(ttiFile, 'utf-8').trim(); run.tti_ms = val === 'TIMEOUT' ? null : parseInt(val, 10); }
    const cpuFiles = findFiles(runDir, /\.cpuprofile$/);
    if (cpuFiles.length > 0) { try { run.cpuFlame = cpuProfileToFlameGraph(JSON.parse(readFileSync(cpuFiles[0], 'utf-8'))); } catch {} }
    const wallFile = join(runDir, 'wall_trace.json');
    if (existsSync(wallFile)) { try { const events = JSON.parse(readFileSync(wallFile, 'utf-8')); run.wallFlame = wallTraceToFlameGraph(events); run.wallEventsCount = events.length; } catch {} }
    const memFile = join(runDir, 'mem_trace.json');
    if (existsSync(memFile)) { try { const memData = memTraceToData(JSON.parse(readFileSync(memFile, 'utf-8'))); if (memData) { run.memFlame = memData.flameGraph; run.memTimeline = memData.timeline; run.totalModules = memData.totalModules; } } catch {} }
    const sysFile = join(runDir, 'system_info.json');
    if (existsSync(sysFile)) { try { run.system = JSON.parse(readFileSync(sysFile, 'utf-8')); } catch {} }
    runs.push(run);
  }
  runs.sort((a, b) => a.id - b.id);
  return { runs, useDemoData: false };
}

// ─── Server state ─────────────────────────────────────────────────────────────

let allRuns = [];
let liveStatus = { state: 'starting' };
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) { try { client.write(msg); } catch (_) {} }
}

// ─── Profiling loop ───────────────────────────────────────────────────────────

async function runOneIteration(startRun) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [
      join(ROOT, 'run-profile.sh'),
      '--runs', '1',
      '--start-run', String(startRun),
      '--no-report',
      '--timeout', '60',
    ], { cwd: ROOT });
    proc.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    proc.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    proc.on('close', (code) => resolve(code));
    proc.on('error', reject);
  });
}

async function profilingLoop() {
  // Seed with any existing runs
  const { runs } = collectRunData(PROFILES_DIR);
  allRuns = runs;
  if (runs.length > 0) console.log(`[live] Loaded ${runs.length} existing run(s)`);

  while (true) {
    const nextRunId = allRuns.length + 1;
    liveStatus = { state: 'running', nextRunId, startedAt: Date.now() };
    broadcast('status', liveStatus);
    console.log(`\n[live] Starting run ${nextRunId}...`);

    try {
      await runOneIteration(nextRunId);

      const { runs: newRuns } = collectRunData(PROFILES_DIR);
      allRuns = newRuns;
      const latest = newRuns.find(r => r.id === nextRunId) || newRuns[newRuns.length - 1];

      liveStatus = { state: 'idle', lastRunId: nextRunId, completedAt: Date.now(), lastTTI: latest?.tti_ms ?? null };
      broadcast('status', liveStatus);

      if (latest) {
        broadcast('run', { run: latest, totalRuns: newRuns.length, newRunId: nextRunId });
        console.log(`[live] Run ${latest.id} complete — TTI: ${latest.tti_ms ?? 'TIMEOUT'} ms`);
      }
    } catch (err) {
      console.error(`[live] Error in run ${nextRunId}:`, err.message);
      liveStatus = { state: 'error', error: err.message, nextRunId };
      broadcast('status', liveStatus);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '8080', 10);

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    res.write(`event: init\ndata: ${JSON.stringify({ runs: allRuns, status: liveStatus })}\n\n`);
    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); } }, 20000);
    req.on('close', () => clearInterval(keepalive));
    return;
  }

  if (url === '/api/runs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allRuns));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(LIVE_HTML);
});

server.listen(port, () => {
  const dashUrl = `http://localhost:${port}`;
  console.log('\nGemini CLI — Live Profiling Dashboard');
  console.log('─'.repeat(50));
  console.log(`Dashboard: ${dashUrl}`);
  console.log('Press Ctrl+C to stop\n');
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${opener} ${dashUrl}`, () => {});
  profilingLoop().catch(err => { console.error('Fatal:', err); process.exit(1); });
});

// ─── Live Dashboard HTML ──────────────────────────────────────────────────────

const LIVE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gemini CLI — Live Profiling</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --fg: #c9d1d9; --fg2: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --orange: #d29922;
    --purple: #bc8cff; --border: #30363d; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; overflow-x: hidden; }

  /* Header */
  .header { background: linear-gradient(135deg, #1a1f35, #0d1117); border-bottom: 1px solid var(--border); padding: 18px 32px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header h1 span { color: var(--accent); }
  .header .subtitle { color: var(--fg2); margin-top: 2px; font-size: 13px; }

  /* Live status bar */
  .live-bar { display: flex; align-items: center; gap: 12px; padding: 8px 32px; background: var(--bg2); border-bottom: 1px solid var(--border); font-size: 13px; min-height: 40px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg2); flex-shrink: 0; transition: background 0.3s; }
  .live-dot.running { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .live-dot.idle { background: var(--green); }
  .live-dot.error { background: var(--red); }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.6;transform:scale(1.4)} }
  .live-state { font-weight: 600; min-width: 60px; }
  .live-state.running { color: var(--accent); }
  .live-state.idle { color: var(--green); }
  .live-state.error { color: var(--red); }
  .live-state.starting { color: var(--fg2); }
  .live-meta { color: var(--fg2); font-size: 12px; }
  .live-meta strong { color: var(--fg); }
  .live-spacer { flex: 1; }
  .live-tti-flash { font-size: 13px; font-weight: 600; color: var(--accent); opacity: 0; transition: opacity 0.3s; }
  .live-tti-flash.visible { opacity: 1; animation: ttiPop 2.5s ease-out forwards; }
  @keyframes ttiPop { 0%{opacity:0;transform:translateY(4px)} 15%{opacity:1;transform:translateY(0)} 70%{opacity:1} 100%{opacity:0} }
  .live-count { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 2px 10px; font-size: 12px; color: var(--fg2); }
  .live-count strong { color: var(--accent); }

  /* Stats bar */
  .stats-bar { display: flex; gap: 16px; padding: 16px 32px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-wrap: wrap; overflow: hidden; }
  .stat-card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 20px; min-width: 140px; transition: border-color 0.4s; }
  .stat-card.flash { animation: statFlash 0.6s ease-out; }
  @keyframes statFlash { 0%{border-color:var(--accent);background:rgba(88,166,255,0.08)} 100%{border-color:var(--border);background:var(--bg)} }
  .stat-card .label { font-size: 11px; text-transform: uppercase; color: var(--fg2); letter-spacing: 0.5px; }
  .stat-card .value { font-size: 26px; font-weight: 700; margin-top: 2px; }
  .stat-card .value.time { color: var(--accent); }
  .stat-card .value.count { color: var(--green); }
  .stat-card .value.mem { color: var(--purple); }
  .stat-card .value.avg { color: var(--orange); }
  .stat-card .unit { font-size: 13px; font-weight: 400; color: var(--fg2); }

  /* Run selector */
  .run-selector-bar { display: flex; align-items: center; gap: 10px; padding: 8px 32px; background: var(--bg2); border-bottom: 1px solid var(--border); min-height: 46px; }
  .rs-label { font-size: 12px; color: var(--fg2); white-space: nowrap; flex-shrink: 0; }
  .run-badges { display: flex; gap: 6px; overflow-x: auto; flex: 1; scrollbar-width: none; }
  .run-badges::-webkit-scrollbar { display: none; }
  .run-badge { flex-shrink: 0; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 500; border: 1px solid var(--border); background: var(--bg3); color: var(--fg2); cursor: pointer; white-space: nowrap; transition: border-color 0.15s, color 0.15s, background 0.15s; display: flex; flex-direction: column; align-items: center; gap: 1px; }
  .run-badge:hover { border-color: var(--accent); color: var(--fg); }
  .run-badge.selected { border-color: var(--accent); background: rgba(88,166,255,0.1); color: var(--accent); }
  .run-badge .badge-id { font-size: 11px; font-weight: 600; }
  .run-badge .badge-tti { font-size: 10px; color: var(--fg2); }
  .run-badge.selected .badge-tti { color: rgba(88,166,255,0.8); }
  .run-badge.fast .badge-tti { color: var(--green); }
  .run-badge.slow .badge-tti { color: var(--red); }
  /* New badge slides in */
  .run-badge.new-badge { animation: badgeSlideIn 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards; }
  @keyframes badgeSlideIn { from{opacity:0;transform:scale(0.6) translateY(6px)} to{opacity:1;transform:scale(1) translateY(0)} }
  /* Briefly highlight the newly added badge */
  .run-badge.new-badge.selected { animation: badgeSlideIn 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards, badgeGlow 1.2s 0.5s ease-out forwards; }
  @keyframes badgeGlow { 0%{box-shadow:0 0 0 3px rgba(88,166,255,0.5)} 100%{box-shadow:none} }

  /* Tab nav */
  .tab-nav { display: flex; padding: 0 32px; background: var(--bg2); border-bottom: 1px solid var(--border); }
  .tab-btn { padding: 11px 22px; cursor: pointer; border: none; background: transparent; color: var(--fg2); font-size: 14px; font-weight: 500; border-bottom: 2px solid transparent; transition: all 0.15s; }
  .tab-btn:hover { color: var(--fg); background: var(--bg3); }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
  /* Flash tab button when new data for that tab arrives */
  .tab-btn.has-new::after { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--green); margin-left: 6px; vertical-align: middle; animation: dotFade 3s ease-out forwards; }
  @keyframes dotFade { 0%{opacity:1} 100%{opacity:0} }

  /* Panels */
  .tab-panel { display: none; padding: 24px 32px; }
  .tab-panel.active { display: block; }

  .flame-section { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 20px; overflow: hidden; }
  .flame-section.updated { animation: sectionFlash 0.8s ease-out; }
  @keyframes sectionFlash { 0%{border-color:rgba(88,166,255,0.6)} 100%{border-color:var(--border)} }
  .section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg3); }
  .section-title { font-weight: 600; font-size: 14px; }
  .section-subtitle { color: var(--fg2); font-size: 12px; }
  .flame-container { width: 100%; min-height: 400px; position: relative; overflow-x: auto; overflow-y: hidden; }
  .flame-container canvas { display: block; }
  .flame-tooltip { position: fixed; z-index: 1000; pointer-events: none; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; font-size: 12px; max-width: 400px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: none; }
  .flame-tooltip .tt-name { font-weight: 600; color: var(--accent); margin-bottom: 4px; word-break: break-all; }
  .flame-tooltip .tt-row { display: flex; justify-content: space-between; gap: 16px; }
  .flame-tooltip .tt-label { color: var(--fg2); }
  .flame-tooltip .tt-val { font-weight: 500; font-family: 'SF Mono', Monaco, Consolas, monospace; }
  .search-bar { display: flex; gap: 8px; align-items: center; }
  .search-bar input { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 5px 10px; color: var(--fg); font-size: 12px; width: 180px; outline: none; }
  .search-bar input:focus { border-color: var(--accent); }
  .search-bar button { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 5px 10px; color: var(--fg); cursor: pointer; font-size: 12px; }
  .search-bar button:hover { background: var(--border); }
  .zoom-breadcrumb { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; padding: 6px 16px; background: var(--bg); border-bottom: 1px solid var(--border); font-size: 12px; min-height: 30px; }
  .zoom-breadcrumb .crumb { color: var(--accent); cursor: pointer; padding: 2px 6px; border-radius: 3px; }
  .zoom-breadcrumb .crumb:hover { background: var(--bg3); }
  .zoom-breadcrumb .sep { color: var(--fg2); }
  .legend { display: flex; gap: 16px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .legend-item { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--fg2); }
  .legend-swatch { width: 12px; height: 12px; border-radius: 3px; }

  /* Waiting state */
  .waiting-msg { padding: 48px 32px; text-align: center; color: var(--fg2); }
  .waiting-msg .wm-title { font-size: 16px; color: var(--fg); margin-bottom: 6px; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to{transform:rotate(360deg)} }

  /* Comparison: animating new bar */
  @keyframes barGrow { from{opacity:0.3} to{opacity:1} }

  @media(max-width:768px) {
    .stats-bar{flex-direction:column}
    .header,.tab-panel,.tab-nav,.live-bar,.run-selector-bar{padding-left:16px;padding-right:16px}
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1><span>Gemini CLI</span> Live Profiling Dashboard</h1>
    <div class="subtitle">Continuous profiling loop · real-time flame graphs</div>
  </div>
</div>

<div class="live-bar">
  <span class="live-dot" id="liveDot"></span>
  <span class="live-state starting" id="liveState">Starting</span>
  <span class="live-meta" id="liveMeta">Initializing profiling loop…</span>
  <span class="live-spacer"></span>
  <span class="live-tti-flash" id="ttiFlash"></span>
  <span class="live-count"><strong id="liveRunCount">0</strong> runs</span>
</div>

<div class="stats-bar" id="statsBar">
  <div style="padding:10px 0;color:var(--fg2);font-size:13px;width:100%">
    <span class="spinner"></span>Waiting for first run to complete…
  </div>
</div>

<div class="run-selector-bar" id="runSelectorBar" style="display:none">
  <span class="rs-label">View run:</span>
  <div class="run-badges" id="runBadges"></div>
</div>

<div class="tab-nav">
  <button class="tab-btn active" data-tab="cpu" id="tab-btn-cpu">CPU Flame</button>
  <button class="tab-btn" data-tab="wall" id="tab-btn-wall">Wall Time</button>
  <button class="tab-btn" data-tab="memory" id="tab-btn-memory">Memory</button>
  <button class="tab-btn" data-tab="timeline" id="tab-btn-timeline">Timeline</button>
  <button class="tab-btn" data-tab="comparison" id="tab-btn-comparison">Comparison</button>
</div>

<div class="tab-panel active" id="tab-cpu">
  <div class="flame-section" id="section-cpu">
    <div class="section-header">
      <div><div class="section-title">CPU Time Flame Graph</div><div class="section-subtitle">V8 CPU profile — where CPU cycles are spent during startup</div></div>
      <div class="search-bar"><input id="cpuSearch" placeholder="Search…"/><button onclick="searchFlame('cpu')">Search</button><button onclick="resetFlame('cpu')">Reset</button></div>
    </div>
    <div class="legend" id="cpuLegend"></div>
    <div class="zoom-breadcrumb" id="cpuBreadcrumb"></div>
    <div class="flame-container" id="cpuFlame"><div class="waiting-msg"><div class="wm-title"><span class="spinner"></span>Waiting for data</div><div>First run in progress…</div></div></div>
  </div>
</div>

<div class="tab-panel" id="tab-wall">
  <div class="flame-section" id="section-wall">
    <div class="section-header">
      <div><div class="section-title">Wall Time Flame Graph</div><div class="section-subtitle">require() tree — where wall-clock time is spent loading modules</div></div>
      <div class="search-bar"><input id="wallSearch" placeholder="Search…"/><button onclick="searchFlame('wall')">Search</button><button onclick="resetFlame('wall')">Reset</button></div>
    </div>
    <div class="legend" id="wallLegend"></div>
    <div class="zoom-breadcrumb" id="wallBreadcrumb"></div>
    <div class="flame-container" id="wallFlame"><div class="waiting-msg"><div class="wm-title"><span class="spinner"></span>Waiting for data</div></div></div>
  </div>
</div>

<div class="tab-panel" id="tab-memory">
  <div class="flame-section" id="section-memory">
    <div class="section-header">
      <div><div class="section-title">Memory Attribution</div><div class="section-subtitle">Heap memory allocated per module during startup</div></div>
      <div class="search-bar"><input id="memSearch" placeholder="Search…"/><button onclick="searchFlame('mem')">Search</button><button onclick="resetFlame('mem')">Reset</button></div>
    </div>
    <div class="legend" id="memLegend"></div>
    <div class="zoom-breadcrumb" id="memBreadcrumb"></div>
    <div class="flame-container" id="memFlame"><div class="waiting-msg"><div class="wm-title"><span class="spinner"></span>Waiting for data</div></div></div>
  </div>
</div>

<div class="tab-panel" id="tab-timeline">
  <div class="flame-section" id="section-timeline">
    <div class="section-header">
      <div><div class="section-title">Memory Timeline</div><div class="section-subtitle">Heap, RSS, and external memory over startup duration</div></div>
    </div>
    <div class="flame-container" style="min-height:300px"><canvas id="timelineCanvas"></canvas></div>
  </div>
</div>

<div class="tab-panel" id="tab-comparison">
  <div class="flame-section" id="section-comparison">
    <div class="section-header">
      <div><div class="section-title">Run Comparison</div><div class="section-subtitle">Time-to-interactive across all runs — new bars appear as runs complete</div></div>
    </div>
    <div class="flame-container" style="min-height:300px"><canvas id="comparisonCanvas"></canvas></div>
  </div>
</div>

<div class="flame-tooltip" id="tooltip"></div>

<script>
// ─── State ──────────────────────────────────────────────────────────────────
let RUNS = [];
let currentRun = null;
let selectedRunId = null; // null = always follow latest
const flameGraphs = {};

// ─── Utilities ───────────────────────────────────────────────────────────────
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function flashSection(id) {
  const el = document.getElementById('section-' + id);
  if (!el) return;
  el.classList.remove('updated');
  void el.offsetWidth; // reflow to restart animation
  el.classList.add('updated');
  setTimeout(() => el.classList.remove('updated'), 1000);
}

function flashTabBtn(id) {
  const el = document.getElementById('tab-btn-' + id);
  if (!el) return;
  el.classList.remove('has-new');
  void el.offsetWidth;
  el.classList.add('has-new');
  setTimeout(() => el.classList.remove('has-new'), 3500);
}

// ─── FlameGraph renderer ─────────────────────────────────────────────────────
class FlameGraph {
  constructor(container, data, options = {}) {
    this.container = container;
    this.rootData = data;
    this.options = { colorScheme: 'warm', valueLabel: 'time', valueFormatter: v => v.toLocaleString() + ' μs', ...options };
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    container.innerHTML = '';
    container.appendChild(this.canvas);
    this.zoomStack = [data];
    this.highlighted = new Set();
    this.hoveredNode = null;
    this.ROW_HEIGHT = 22; this.PADDING = 1; this.MIN_VISIBLE_WIDTH = 2;
    this._layoutCache = new Map();
    this._setupResize(); this._setupEvents(); this.render();
  }
  _setupResize() {
    const ro = new ResizeObserver(() => { this._resize(); this.render(); });
    ro.observe(this.container); this._resize();
  }
  _resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.canvas.width = rect.width * dpr; this.canvas.style.width = rect.width + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._layoutCache.clear();
  }
  currentRoot() { return this.zoomStack[this.zoomStack.length - 1]; }
  _layout(root) {
    const nodes = []; const totalValue = root.value || 1; let maxDepth = 0;
    const visit = (node, x, depth) => {
      const w = (node.value / totalValue) * this.width;
      if (w < this.MIN_VISIBLE_WIDTH && depth > 0) return;
      nodes.push({ node, x, y: depth, w }); maxDepth = Math.max(maxDepth, depth);
      let childX = x;
      if (node.children) { const sorted = [...node.children].sort((a, b) => b.value - a.value); for (const child of sorted) { visit(child, childX, depth + 1); childX += (child.value / totalValue) * this.width; } }
    };
    visit(root, 0, 0); this.maxDepth = maxDepth;
    const height = (maxDepth + 1) * this.ROW_HEIGHT + 10;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.height = height * dpr; this.canvas.style.height = height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return nodes;
  }
  _color(node, ln) {
    const name = node.name || ''; const scheme = this.options.colorScheme;
    if (this.highlighted.size > 0 && !this.highlighted.has(name)) return 'rgba(80,80,80,0.4)';
    const isHovered = this.hoveredNode === ln;
    const jitter = hashStr(name) % 12;
    if (scheme === 'warm') {
      const selfRatio = (node.selfValue || node.data?.selfTime_us || 0) / Math.max(node.value, 1);
      return \`hsl(\${10 + (1-selfRatio)*40}, \${70+selfRatio*20}%, \${isHovered?60:40+jitter}%)\`;
    } else if (scheme === 'cool') {
      let h = 200;
      if (name.includes('node:') || name.includes('node_builtin')) h = 140;
      else if (name.includes('@google')) h = 210; else if (name.includes('GC')) h = 0;
      else if (name.includes('Event Loop')) h = 45; else if (name.includes('react') || name.includes('ink')) h = 270;
      else h = 170 + (name.charCodeAt(0)||0) % 60;
      return \`hsl(\${h}, 65%, \${isHovered?55:30+jitter}%)\`;
    } else if (scheme === 'purple') {
      let h = 280;
      if (name.includes('node_builtin')) h = 200;
      else if (name.includes('app') || name.startsWith('./')) h = 140;
      else h = 260 + (name.charCodeAt(0)||0) % 40;
      return \`hsl(\${h}, 55%, \${isHovered?55:30+jitter}%)\`;
    }
    return '#555';
  }
  render() {
    const root = this.currentRoot(); if (!root) return;
    const nodes = this._layout(root); const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.canvas.height / (window.devicePixelRatio||1));
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'; ctx.textBaseline = 'middle';
    for (const ln of nodes) {
      const y = ln.y * this.ROW_HEIGHT; const h = this.ROW_HEIGHT - this.PADDING;
      const w = Math.max(ln.w - this.PADDING, 1);
      ctx.fillStyle = this._color(ln.node, ln); ctx.fillRect(ln.x, y, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 0.5; ctx.strokeRect(ln.x, y, w, h);
      if (w > 40) {
        ctx.fillStyle = '#fff';
        const label = ln.node.name.length > w/7 ? ln.node.name.substring(0, Math.floor(w/7)-1)+'…' : ln.node.name;
        ctx.fillText(label, ln.x + 4, y + h/2);
      }
    }
    this._layoutNodes = nodes;
  }
  _setupEvents() {
    const tooltip = document.getElementById('tooltip');
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect(); const mx = e.clientX-rect.left; const my = e.clientY-rect.top;
      let found = null;
      if (this._layoutNodes) for (let i = this._layoutNodes.length-1; i >= 0; i--) { const ln = this._layoutNodes[i]; if (mx>=ln.x && mx<=ln.x+ln.w && my>=ln.y*this.ROW_HEIGHT && my<=(ln.y+1)*this.ROW_HEIGHT) { found=ln; break; } }
      if (found) {
        this.hoveredNode = found; this.canvas.style.cursor = 'pointer';
        const node = found.node; const root = this.currentRoot(); const pct = ((node.value/root.value)*100).toFixed(1);
        let html = \`<div class="tt-name">\${node.name}</div>\`;
        html += \`<div class="tt-row"><span class="tt-label">Total:</span><span class="tt-val">\${this.options.valueFormatter(node.value)} (\${pct}%)</span></div>\`;
        if (node.selfValue) html += \`<div class="tt-row"><span class="tt-label">Self:</span><span class="tt-val">\${this.options.valueFormatter(node.selfValue)}</span></div>\`;
        if (node.data) for (const [k,v] of Object.entries(node.data)) { if (k==='functionName'||k==='category') continue; html += \`<div class="tt-row"><span class="tt-label">\${k}:</span><span class="tt-val">\${v}</span></div>\`; }
        if (node.children) html += \`<div class="tt-row"><span class="tt-label">Children:</span><span class="tt-val">\${node.children.length}</span></div>\`;
        tooltip.innerHTML = html; tooltip.style.display = 'block';
        tooltip.style.left = Math.min(e.clientX+12, window.innerWidth-420)+'px'; tooltip.style.top = (e.clientY+12)+'px';
      } else { this.hoveredNode = null; this.canvas.style.cursor = 'default'; tooltip.style.display = 'none'; }
      this.render();
    });
    this.canvas.addEventListener('mouseleave', () => { this.hoveredNode = null; tooltip.style.display = 'none'; this.render(); });
    this.canvas.addEventListener('click', () => { if (this.hoveredNode?.node.children?.length > 0) { this.zoomStack.push(this.hoveredNode.node); this.render(); this._updateBreadcrumb(); } });
    this.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.zoomStack.length > 1) { this.zoomStack.pop(); this.render(); this._updateBreadcrumb(); } });
  }
  _updateBreadcrumb() {
    const id = this.options.breadcrumbId; if (!id) return;
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = '';
    this.zoomStack.forEach((node, i) => {
      if (i > 0) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = ' › '; el.appendChild(sep); }
      const crumb = document.createElement('span'); crumb.className = 'crumb';
      crumb.textContent = node.name.substring(0,40) + (node.name.length>40?'…':'');
      crumb.onclick = () => { this.zoomStack = this.zoomStack.slice(0, i+1); this.render(); this._updateBreadcrumb(); };
      el.appendChild(crumb);
    });
  }
  search(query) {
    if (!query) { this.highlighted.clear(); this.render(); return; }
    this.highlighted.clear(); const lq = query.toLowerCase();
    const visit = (node) => { if (node.name.toLowerCase().includes(lq)) this.highlighted.add(node.name); if (node.children) node.children.forEach(visit); };
    visit(this.rootData); this.render();
  }
  reset() { this.zoomStack = [this.rootData]; this.highlighted.clear(); this.render(); this._updateBreadcrumb(); }
}

// ─── Legend / search helpers ─────────────────────────────────────────────────
function setupLegend(id, items) {
  const el = document.getElementById(id); if (!el) return;
  el.innerHTML = items.map(i => \`<div class="legend-item"><div class="legend-swatch" style="background:\${i.color}"></div>\${i.label}</div>\`).join('');
}
function searchFlame(type) { const inp = document.getElementById(type+'Search'); if (flameGraphs[type]&&inp) flameGraphs[type].search(inp.value); }
function resetFlame(type) { const inp = document.getElementById(type+'Search'); if (inp) inp.value=''; if (flameGraphs[type]) flameGraphs[type].reset(); }

// ─── Render flame graphs for a run ──────────────────────────────────────────
function renderFlameGraphs(run) {
  if (!run) return;
  if (run.cpuFlame) {
    flameGraphs.cpu = new FlameGraph(document.getElementById('cpuFlame'), run.cpuFlame, { colorScheme: 'warm', valueLabel: 'CPU time', valueFormatter: v => v>1e6?(v/1e6).toFixed(1)+' s':v>1000?(v/1000).toFixed(1)+' ms':v+' μs', breadcrumbId: 'cpuBreadcrumb' });
    setupLegend('cpuLegend', [{color:'hsl(10,80%,45%)',label:'High self-time'},{color:'hsl(35,75%,50%)',label:'Medium'},{color:'hsl(50,70%,50%)',label:'Low self-time'}]);
  }
  if (run.wallFlame) {
    flameGraphs.wall = new FlameGraph(document.getElementById('wallFlame'), run.wallFlame, { colorScheme: 'cool', valueLabel: 'Wall time', valueFormatter: v => v>1e6?(v/1e6).toFixed(1)+' s':v>1000?(v/1000).toFixed(1)+' ms':v+' μs', breadcrumbId: 'wallBreadcrumb' });
    setupLegend('wallLegend', [{color:'hsl(140,65%,40%)',label:'Node builtins'},{color:'hsl(210,65%,40%)',label:'@google'},{color:'hsl(270,65%,40%)',label:'React/Ink'},{color:'hsl(0,65%,40%)',label:'GC'},{color:'hsl(45,65%,40%)',label:'Event Loop Lag'},{color:'hsl(180,65%,40%)',label:'Other'}]);
  }
  if (run.memFlame) {
    flameGraphs.mem = new FlameGraph(document.getElementById('memFlame'), run.memFlame, { colorScheme: 'purple', valueLabel: 'Heap bytes', valueFormatter: v => v>1048576?(v/1048576).toFixed(1)+' MB':v>1024?(v/1024).toFixed(1)+' KB':v+' B', breadcrumbId: 'memBreadcrumb' });
    setupLegend('memLegend', [{color:'hsl(200,55%,40%)',label:'Node builtins'},{color:'hsl(140,55%,40%)',label:'App code'},{color:'hsl(280,55%,40%)',label:'Dependencies'}]);
  }
  if (run.memTimeline) drawTimeline(run.memTimeline);
}

// ─── Stats bar ───────────────────────────────────────────────────────────────
function updateStatsBar(run, animate) {
  const statsBar = document.getElementById('statsBar');
  if (!run) return;
  const tti = run.tti_ms;
  const modules = run.totalModules || '—';
  const mem = run.memTimeline ? (Math.max(...run.memTimeline.map(s => s.rss)) / 1048576).toFixed(0) : '—';
  const validTTIs = RUNS.filter(r => r.tti_ms != null).map(r => r.tti_ms);
  const avg = validTTIs.length ? (validTTIs.reduce((a,b)=>a+b,0)/validTTIs.length).toFixed(0) : '—';
  const flashClass = animate ? ' flash' : '';
  statsBar.innerHTML = \`
    <div class="stat-card\${flashClass}"><div class="label">Latest TTI</div><div class="value time">\${tti??'—'}<span class="unit"> ms</span></div></div>
    <div class="stat-card\${flashClass}"><div class="label">Avg TTI</div><div class="value avg">\${avg}<span class="unit"> ms</span></div></div>
    <div class="stat-card\${flashClass}"><div class="label">Modules Loaded</div><div class="value count">\${modules}</div></div>
    <div class="stat-card\${flashClass}"><div class="label">Peak RSS</div><div class="value mem">\${mem}<span class="unit"> MB</span></div></div>
    <div class="stat-card\${flashClass}"><div class="label">Total Runs</div><div class="value count">\${RUNS.length}</div></div>
    <div class="stat-card"><div class="label">Node.js</div><div class="value" style="font-size:15px;color:var(--fg)">\${run.system?.node_version||'—'}</div></div>
  \`;
}

// ─── Run badge selector ──────────────────────────────────────────────────────
function updateRunBadges(newRunId) {
  if (RUNS.length === 0) return;
  document.getElementById('runSelectorBar').style.display = 'flex';
  const container = document.getElementById('runBadges');
  const validTTIs = RUNS.filter(r => r.tti_ms != null).map(r => r.tti_ms);
  const avg = validTTIs.length ? validTTIs.reduce((a,b)=>a+b,0)/validTTIs.length : 0;
  const effectiveSelected = selectedRunId ?? RUNS[RUNS.length-1]?.id;

  // Only add new badge instead of rebuilding everything (avoids re-triggering animations)
  const existingIds = new Set([...container.querySelectorAll('.run-badge')].map(el => parseInt(el.dataset.runId)));

  for (const r of RUNS) {
    if (existingIds.has(r.id)) {
      // Update selected state
      const el = container.querySelector(\`[data-run-id="\${r.id}"]\`);
      if (el) el.className = 'run-badge' + (r.tti_ms != null ? (r.tti_ms < avg*0.85 ? ' fast' : r.tti_ms > avg*1.15 ? ' slow' : '') : '') + (r.id === effectiveSelected ? ' selected' : '');
      continue;
    }
    // New badge
    const speedClass = r.tti_ms == null ? '' : r.tti_ms < avg*0.85 ? ' fast' : r.tti_ms > avg*1.15 ? ' slow' : '';
    const selClass = r.id === effectiveSelected ? ' selected' : '';
    const isNew = r.id === newRunId;
    const el = document.createElement('div');
    el.className = 'run-badge' + speedClass + selClass + (isNew ? ' new-badge' : '');
    el.dataset.runId = r.id;
    el.innerHTML = \`<span class="badge-id">Run \${r.id}</span><span class="badge-tti">\${r.tti_ms != null ? r.tti_ms+' ms' : 'TIMEOUT'}</span>\`;
    el.onclick = () => selectRun(r.id);
    container.appendChild(el);
  }

  // Update live count
  document.getElementById('liveRunCount').textContent = RUNS.length;

  // Scroll to show latest
  container.scrollLeft = container.scrollWidth;
}

function selectRun(id) {
  selectedRunId = id;
  currentRun = RUNS.find(r => r.id === id) || null;
  // Update badge selection classes
  document.querySelectorAll('.run-badge').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.runId) === id);
  });
  if (currentRun) { renderFlameGraphs(currentRun); updateStatsBar(currentRun, false); }
}

// ─── Comparison chart (with animated new bar) ────────────────────────────────
let compAnimFrame = null;
let compNewBarId = null;
let compAnimProgress = 1;

function drawComparison(animProgress) {
  const p = animProgress ?? 1;
  const canvas = document.getElementById('comparisonCanvas');
  if (!canvas || RUNS.length === 0) return;
  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr; canvas.height = 300 * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = '300px';
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = 300;
  const pad = { top: 30, right: 60, bottom: 50, left: 70 };
  const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom;
  const validRuns = RUNS.filter(r => r.tti_ms != null);
  if (validRuns.length === 0) return;
  const maxTTI = Math.max(...validRuns.map(r => r.tti_ms)) * 1.2;
  const barW = Math.min(56, plotW / validRuns.length - 6);
  const avg = validRuns.reduce((s, r) => s + r.tti_ms, 0) / validRuns.length;
  const effectiveSelected = selectedRunId ?? RUNS[RUNS.length-1]?.id;

  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
  // Grid
  ctx.strokeStyle = 'rgba(48,54,61,0.5)'; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (i/5)*plotH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W-pad.right, y); ctx.stroke();
    ctx.fillStyle = '#8b949e'; ctx.font = '11px -apple-system, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText((maxTTI*(5-i)/5).toFixed(0)+' ms', pad.left-8, y+4);
  }

  validRuns.forEach((run, i) => {
    const isNew = run.id === compNewBarId;
    const effectiveProgress = isNew ? p : 1;
    const x = pad.left + (i+0.5)*(plotW/validRuns.length) - barW/2;
    const fullBarH = (run.tti_ms / maxTTI) * plotH;
    const barH = fullBarH * effectiveProgress;
    const y = pad.top + plotH - barH;
    const isSel = run.id === effectiveSelected;
    let color = run.tti_ms > avg*1.2 ? '#f85149' : run.tti_ms < avg*0.8 ? '#3fb950' : '#58a6ff';
    ctx.globalAlpha = isSel ? 1 : 0.6;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barW, barH, [4,4,0,0]);
    else { ctx.moveTo(x+4,y); ctx.lineTo(x+barW-4,y); ctx.quadraticCurveTo(x+barW,y,x+barW,y+4); ctx.lineTo(x+barW,y+barH); ctx.lineTo(x,y+barH); ctx.lineTo(x,y+4); ctx.quadraticCurveTo(x,y,x+4,y); ctx.closePath(); }
    ctx.fill();
    ctx.globalAlpha = 1;
    if (isSel) { ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.stroke(); }
    // Value label (only when bar is mostly grown)
    if (barW > 16 && effectiveProgress > 0.7) {
      ctx.fillStyle = isSel ? '#c9d1d9' : '#8b949e';
      ctx.font = (isSel ? 'bold ' : '') + '11px -apple-system, sans-serif'; ctx.textAlign = 'center';
      if (y > pad.top + 16) ctx.fillText(run.tti_ms+' ms', x+barW/2, y-6);
      ctx.fillStyle = '#8b949e'; ctx.font = '10px -apple-system, sans-serif';
      ctx.fillText('R'+run.id, x+barW/2, H-pad.bottom+18);
    }
  });

  // Avg line
  const avgY = pad.top + plotH - (avg/maxTTI)*plotH;
  ctx.setLineDash([6,4]); ctx.strokeStyle = '#d29922'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(pad.left, avgY); ctx.lineTo(W-pad.right, avgY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#d29922'; ctx.font = 'bold 11px -apple-system, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('avg: '+avg.toFixed(0)+' ms', W-pad.right+4, avgY+4);
}

function animateComparison(newRunId) {
  compNewBarId = newRunId;
  compAnimProgress = 0;
  if (compAnimFrame) cancelAnimationFrame(compAnimFrame);
  function step() {
    compAnimProgress = Math.min(1, compAnimProgress + 0.06);
    drawComparison(compAnimProgress);
    if (compAnimProgress < 1) compAnimFrame = requestAnimationFrame(step);
    else { compAnimFrame = null; compNewBarId = null; }
  }
  requestAnimationFrame(step);
}

// ─── Timeline chart ──────────────────────────────────────────────────────────
function drawTimeline(data) {
  const canvas = document.getElementById('timelineCanvas');
  if (!canvas || !data.length) return;
  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr; canvas.height = 280 * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = '280px';
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = 280;
  const pad = {top:20,right:20,bottom:40,left:70};
  const plotW = W-pad.left-pad.right, plotH = H-pad.top-pad.bottom;
  const maxT = Math.max(...data.map(d=>d.t));
  const maxMem = Math.max(...data.map(d=>d.rss)) * 1.1;
  const xScale = t => pad.left + (t/maxT)*plotW;
  const yScale = v => pad.top + plotH - (v/maxMem)*plotH;
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = 'rgba(48,54,61,0.5)'; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top+(i/5)*plotH;
    ctx.beginPath(); ctx.moveTo(pad.left,y); ctx.lineTo(W-pad.right,y); ctx.stroke();
    ctx.fillStyle='#8b949e'; ctx.font='11px -apple-system,sans-serif'; ctx.textAlign='right';
    ctx.fillText(((maxMem*(5-i)/5)/1048576).toFixed(0)+' MB', pad.left-8, y+4);
  }
  ctx.textAlign='center';
  for (let i = 0; i <= 5; i++) { const t=maxT*i/5; ctx.fillStyle='#8b949e'; ctx.font='11px -apple-system,sans-serif'; ctx.fillText(t.toFixed(0)+' ms', xScale(t), H-pad.bottom+20); }
  const series = [{key:'rss',color:'#f85149',label:'RSS'},{key:'heapTotal',color:'#d29922',label:'Heap Total'},{key:'heapUsed',color:'#58a6ff',label:'Heap Used'},{key:'external',color:'#bc8cff',label:'External'}];
  for (const s of series) {
    ctx.beginPath(); ctx.strokeStyle=s.color; ctx.lineWidth=2; let first=true;
    for (const d of data) { const x=xScale(d.t),y=yScale(d[s.key]||0); if(first){ctx.moveTo(x,y);first=false;}else ctx.lineTo(x,y); }
    ctx.stroke();
    ctx.globalAlpha=0.08; ctx.lineTo(xScale(data[data.length-1].t),yScale(0)); ctx.lineTo(xScale(data[0].t),yScale(0)); ctx.fillStyle=s.color; ctx.fill(); ctx.globalAlpha=1;
  }
  let lx = pad.left;
  for (const s of series) { ctx.fillStyle=s.color; ctx.fillRect(lx,H-14,12,12); ctx.fillStyle='#c9d1d9'; ctx.font='11px -apple-system,sans-serif'; ctx.textAlign='left'; ctx.fillText(s.label,lx+16,H-4); lx+=ctx.measureText(s.label).width+36; }
}

// ─── Live status bar ─────────────────────────────────────────────────────────
function updateLiveBar(status) {
  const dot = document.getElementById('liveDot');
  const state = document.getElementById('liveState');
  const meta = document.getElementById('liveMeta');
  dot.className = 'live-dot ' + (status.state||'starting');
  state.className = 'live-state ' + (status.state||'starting');
  if (status.state === 'running') {
    state.textContent = 'RUNNING';
    meta.innerHTML = \`Starting run <strong>\${status.nextRunId}</strong>…\`;
  } else if (status.state === 'idle') {
    state.textContent = 'READY';
    const tti = status.lastTTI != null ? status.lastTTI+' ms' : 'TIMEOUT';
    meta.innerHTML = \`Run <strong>\${status.lastRunId}</strong> complete — TTI <strong>\${tti}</strong> · next run starting shortly\`;
    // Flash TTI toast
    const flash = document.getElementById('ttiFlash');
    flash.textContent = tti;
    flash.classList.remove('visible'); void flash.offsetWidth; flash.classList.add('visible');
  } else if (status.state === 'error') {
    state.textContent = 'ERROR';
    meta.textContent = status.error || 'Unknown error — retrying in 5s…';
  } else {
    state.textContent = 'Starting';
    meta.textContent = 'Initializing…';
  }
}

// ─── SSE connection ───────────────────────────────────────────────────────────
const evtSource = new EventSource('/events');

evtSource.addEventListener('init', (e) => {
  const data = JSON.parse(e.data);
  RUNS = data.runs || [];
  updateLiveBar(data.status || {state:'starting'});
  document.getElementById('liveRunCount').textContent = RUNS.length;
  if (RUNS.length > 0) {
    currentRun = RUNS[RUNS.length - 1];
    updateStatsBar(currentRun, false);
    renderFlameGraphs(currentRun);
    updateRunBadges(null);
    drawComparison(1);
  }
});

evtSource.addEventListener('run', (e) => {
  const data = JSON.parse(e.data);
  const run = data.run;
  const newRunId = data.newRunId;

  // Append or update run in list
  const idx = RUNS.findIndex(r => r.id === run.id);
  if (idx >= 0) RUNS[idx] = run; else RUNS.push(run);
  RUNS.sort((a, b) => a.id - b.id);

  // Update badges (add new badge with animation, update existing)
  updateRunBadges(newRunId);

  // If following latest, switch flame graphs to new run
  if (selectedRunId === null) {
    currentRun = run;
    renderFlameGraphs(run);
    // Flash sections to indicate update
    ['cpu','wall','memory','timeline'].forEach(id => {
      flashSection(id); flashTabBtn(id === 'timeline' ? 'timeline' : id === 'memory' ? 'memory' : id);
    });
  }

  updateStatsBar(currentRun || run, true);
  flashTabBtn('comparison');
  animateComparison(newRunId); // animate the new bar growing
});

evtSource.addEventListener('status', (e) => {
  updateLiveBar(JSON.parse(e.data));
});

evtSource.onerror = () => {
  updateLiveBar({ state: 'error', error: 'Connection lost — reconnecting…' });
};

// ─── Tab navigation ───────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    setTimeout(() => {
      Object.values(flameGraphs).forEach(fg => { fg._resize(); fg.render(); });
      if (currentRun?.memTimeline) drawTimeline(currentRun.memTimeline);
      drawComparison(1);
    }, 50);
  });
});

['cpuSearch','wallSearch','memSearch'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => { if (e.key==='Enter') searchFlame(id.replace('Search','')); });
});

window.addEventListener('resize', () => {
  if (currentRun?.memTimeline) drawTimeline(currentRun.memTimeline);
  drawComparison(1);
});
</script>
</body>
</html>`;
