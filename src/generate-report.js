#!/usr/bin/env node
// =============================================================================
// Gemini CLI Startup Testbed — Report Generator
// =============================================================================
// Transforms CPU profiles (.cpuprofile), memory traces, and wall-time traces
// into a single interactive HTML dashboard with flame graphs.
// =============================================================================

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, basename, resolve } from 'path';
import { argv, exit } from 'process';
import http from 'http';
import { exec } from 'child_process';

// ─── CLI args ───────────────────────────────────────────────────────────────
let inputDir = './profiles';
let outputDir = './output';
let shouldServe = false;
let port = 8080;

for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--input' && argv[i + 1]) inputDir = argv[++i];
  if (argv[i] === '--output' && argv[i + 1]) outputDir = argv[++i];
  if (argv[i] === '--serve') shouldServe = true;
  if (argv[i] === '--port' && argv[i + 1]) port = parseInt(argv[++i], 10);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Parse V8 CPU Profile into flame graph data ────────────────────────────
function cpuProfileToFlameGraph(profile) {
  const { nodes, startTime, endTime } = profile;
  if (!nodes || nodes.length === 0) return null;

  // Build node map
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, {
      ...node,
      children: node.children || [],
      selfTime: 0,
      totalTime: 0
    });
  }

  // Calculate times from samples + timeDeltas
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const nodeId = profile.samples[i];
      const delta = profile.timeDeltas[i] || 0;
      const node = nodeMap.get(nodeId);
      if (node) node.selfTime += delta;
    }
  }

  // Propagate total times
  function calcTotalTime(id) {
    const node = nodeMap.get(id);
    if (!node) return 0;
    node.totalTime = node.selfTime;
    for (const childId of node.children) {
      node.totalTime += calcTotalTime(childId);
    }
    return node.totalTime;
  }
  calcTotalTime(nodes[0].id);

  // Convert to d3-flame-graph format
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

    return {
      name: label,
      value: Math.max(node.totalTime, 1),
      selfValue: node.selfTime,
      children,
      data: {
        functionName: name,
        url,
        lineNumber,
        selfTime_us: node.selfTime,
        totalTime_us: node.totalTime
      }
    };
  }

  const root = toFlameNode(nodes[0].id);
  if (root) {
    root.name = '(root)';
  }
  return root;
}

// ─── Parse wall trace (require hook output) into flame graph data ───────────
function wallTraceToFlameGraph(events) {
  if (!Array.isArray(events) || events.length === 0) return null;

  // Sort by timestamp
  events.sort((a, b) => a.ts - b.ts);

  // Group by category
  const requires = events.filter(e => e.cat === 'require');
  const gcs = events.filter(e => e.cat === 'gc');
  const lags = events.filter(e => e.cat === 'event_loop');

  // Build a hierarchical flame graph from require events
  // We'll use a stack-based approach: parent is the require whose time span contains the child
  const root = { name: '(startup)', value: 0, children: [], data: { category: 'root' } };

  if (requires.length === 0) return root;

  const totalDuration = requires.reduce((sum, e) => sum + (e.dur || 0), 0);
  root.value = totalDuration;

  // Build tree by nesting overlapping time spans
  const stack = [root];

  for (const req of requires) {
    const node = {
      name: req.name,
      value: req.dur || 1,
      children: [],
      data: {
        category: 'require',
        parent: req.args?.parent || '',
        duration_ms: ((req.dur || 0) / 1000).toFixed(2),
        timestamp_ms: ((req.ts - requires[0].ts) / 1000).toFixed(2)
      }
    };

    // Pop stack until we find the parent that contains this event
    while (stack.length > 1) {
      const parent = stack[stack.length - 1];
      if (parent._end && req.ts >= parent._end) {
        stack.pop();
      } else {
        break;
      }
    }

    node._end = req.ts + (req.dur || 0);
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  // Add GC events as children of root
  if (gcs.length > 0) {
    const gcRoot = {
      name: `GC (${gcs.length} events)`,
      value: gcs.reduce((s, e) => s + (e.dur || 0), 0),
      children: gcs.map(gc => ({
        name: gc.name,
        value: gc.dur || 1,
        children: [],
        data: { category: 'gc', duration_ms: ((gc.dur || 0) / 1000).toFixed(2) }
      })),
      data: { category: 'gc' }
    };
    root.children.push(gcRoot);
    root.value += gcRoot.value;
  }

  // Add event loop lag events
  if (lags.length > 0) {
    const lagRoot = {
      name: `Event Loop Lag (${lags.length} events)`,
      value: lags.reduce((s, e) => s + (e.dur || 0), 0),
      children: lags.map(lag => ({
        name: lag.name,
        value: lag.dur || 1,
        children: [],
        data: { category: 'event_loop', lag_ms: lag.args?.lag_ms }
      })),
      data: { category: 'event_loop' }
    };
    root.children.push(lagRoot);
    root.value += lagRoot.value;
  }

  return root;
}

// ─── Parse memory trace into timeline + flame data ──────────────────────────
function memTraceToData(memData) {
  if (!memData || !memData.snapshots) return null;

  const snapshots = memData.snapshots;

  // Create flame graph from memory attribution
  // Group modules by their heap contribution
  const moduleMemory = new Map();

  for (const snap of snapshots) {
    if (snap.label.startsWith('__')) continue;
    const existing = moduleMemory.get(snap.label) || { peak: 0, count: 0 };
    existing.peak = Math.max(existing.peak, snap.heapUsed);
    existing.count++;
    moduleMemory.set(snap.label, existing);
  }

  // Build flame graph: root → category → module
  const categories = new Map();
  for (const [mod, data] of moduleMemory) {
    // Categorize by path
    let cat = 'other';
    if (mod.includes('node_modules')) {
      const parts = mod.split('node_modules/');
      cat = parts[parts.length - 1].split('/')[0];
      if (cat.startsWith('@')) cat += '/' + parts[parts.length - 1].split('/')[1];
    } else if (mod.startsWith('.') || mod.startsWith('/')) {
      cat = 'app';
    } else if (!mod.includes('/')) {
      cat = 'node_builtin';
    }

    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push({ name: mod, value: data.peak, count: data.count });
  }

  const root = {
    name: '(memory)',
    value: 0,
    children: []
  };

  for (const [cat, modules] of categories) {
    const catValue = modules.reduce((s, m) => s + m.value, 0);
    root.children.push({
      name: cat,
      value: catValue,
      children: modules.map(m => ({
        name: m.name,
        value: m.value,
        children: [],
        data: { heap_bytes: m.value, load_count: m.count }
      })),
      data: { category: cat }
    });
    root.value += catValue;
  }

  return {
    flameGraph: root,
    timeline: snapshots.map(s => ({
      t: s.timestamp_ms,
      heapUsed: s.heapUsed,
      heapTotal: s.heapTotal,
      rss: s.rss,
      external: s.external,
      label: s.label,
      moduleIndex: s.moduleIndex
    })),
    totalModules: memData.totalModulesLoaded
  };
}

// ─── Aggregate run data ─────────────────────────────────────────────────────
function collectRunData(inputDir) {
  const runs = [];
  const combinedDir = join(inputDir, 'combined');

  if (!existsSync(combinedDir)) {
    console.error(`No combined profile directory found at ${combinedDir}`);
    console.error('Generating report with demo data for visualization testing...');
    return { runs: [], useDemoData: true };
  }

  for (const entry of readdirSync(combinedDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run_')) continue;

    const runDir = join(combinedDir, entry.name);
    const runNum = parseInt(entry.name.replace('run_', ''), 10);
    const run = { id: runNum, dir: runDir };

    // TTI
    const ttiFile = join(runDir, 'tti_ms');
    if (existsSync(ttiFile)) {
      const val = readFileSync(ttiFile, 'utf-8').trim();
      run.tti_ms = val === 'TIMEOUT' ? null : parseInt(val, 10);
    }

    // CPU profile
    const cpuFiles = findFiles(runDir, /\.cpuprofile$/);
    if (cpuFiles.length > 0) {
      try {
        const profile = JSON.parse(readFileSync(cpuFiles[0], 'utf-8'));
        run.cpuFlame = cpuProfileToFlameGraph(profile);
        run.cpuProfileRaw = cpuFiles[0];
      } catch (e) {
        console.error(`  Warning: Could not parse CPU profile: ${e.message}`);
      }
    }

    // Wall trace
    const wallFile = join(runDir, 'wall_trace.json');
    if (existsSync(wallFile)) {
      try {
        const events = JSON.parse(readFileSync(wallFile, 'utf-8'));
        run.wallFlame = wallTraceToFlameGraph(events);
        run.wallEventsCount = events.length;
      } catch (e) {
        console.error(`  Warning: Could not parse wall trace: ${e.message}`);
      }
    }

    // Memory trace
    const memFile = join(runDir, 'mem_trace.json');
    if (existsSync(memFile)) {
      try {
        const memRaw = JSON.parse(readFileSync(memFile, 'utf-8'));
        const memData = memTraceToData(memRaw);
        if (memData) {
          run.memFlame = memData.flameGraph;
          run.memTimeline = memData.timeline;
          run.totalModules = memData.totalModules;
        }
      } catch (e) {
        console.error(`  Warning: Could not parse memory trace: ${e.message}`);
      }
    }

    // System info
    const sysFile = join(runDir, 'system_info.json');
    if (existsSync(sysFile)) {
      try {
        run.system = JSON.parse(readFileSync(sysFile, 'utf-8'));
      } catch (e) { /* ignore */ }
    }

    runs.push(run);
  }

  runs.sort((a, b) => a.id - b.id);
  return { runs, useDemoData: false };
}

// ─── Generate demo data for testing the visualization ───────────────────────
function generateDemoData() {
  function makeFlameNode(name, value, children = []) {
    return { name, value, children, data: {} };
  }

  const cpuFlame = makeFlameNode('(root)', 5000, [
    makeFlameNode('Module._load', 3200, [
      makeFlameNode('@google/gemini-cli/build/cli.js', 2800, [
        makeFlameNode('initialize()', 1200, [
          makeFlameNode('loadConfig()', 400, [
            makeFlameNode('readFileSync()', 150),
            makeFlameNode('JSON.parse()', 100),
            makeFlameNode('validateConfig()', 120),
          ]),
          makeFlameNode('initializeAuth()', 500, [
            makeFlameNode('loadCredentials()', 200),
            makeFlameNode('validateToken()', 180),
            makeFlameNode('refreshToken()', 80),
          ]),
          makeFlameNode('loadPlugins()', 250, [
            makeFlameNode('discoverPlugins()', 100),
            makeFlameNode('requirePlugin()', 120),
          ]),
        ]),
        makeFlameNode('setupUI()', 900, [
          makeFlameNode('ink.render()', 600, [
            makeFlameNode('React.createElement()', 200),
            makeFlameNode('reconciler.createContainer()', 250),
            makeFlameNode('layoutEngine()', 100),
          ]),
          makeFlameNode('setupKeyBindings()', 150),
          makeFlameNode('loadTheme()', 100),
        ]),
        makeFlameNode('connectAPI()', 500, [
          makeFlameNode('resolveEndpoint()', 80),
          makeFlameNode('createGrpcChannel()', 300, [
            makeFlameNode('tls.connect()', 150),
            makeFlameNode('http2.connect()', 120),
          ]),
          makeFlameNode('healthCheck()', 80),
        ]),
      ]),
    ]),
    makeFlameNode('node:internal/modules/cjs/loader', 800, [
      makeFlameNode('Module._resolveFilename', 300),
      makeFlameNode('Module._compile', 400),
    ]),
    makeFlameNode('v8.compileFunction', 600),
    makeFlameNode('(idle)', 200),
  ]);

  const wallFlame = makeFlameNode('(startup)', 8500, [
    makeFlameNode('node:module', 400, [
      makeFlameNode('node:path', 50),
      makeFlameNode('node:fs', 80),
      makeFlameNode('node:util', 40),
      makeFlameNode('node:events', 30),
    ]),
    makeFlameNode('@google/gemini-cli', 5200, [
      makeFlameNode('commander', 180),
      makeFlameNode('ink', 1200, [
        makeFlameNode('react', 400),
        makeFlameNode('yoga-layout', 350),
        makeFlameNode('chalk', 80),
        makeFlameNode('cli-cursor', 40),
      ]),
      makeFlameNode('@google/genai', 800, [
        makeFlameNode('google-auth-library', 350, [
          makeFlameNode('gtoken', 120),
          makeFlameNode('gaxios', 100),
        ]),
        makeFlameNode('protobufjs', 200),
      ]),
      makeFlameNode('conf', 300, [
        makeFlameNode('env-paths', 40),
        makeFlameNode('ajv', 180),
      ]),
      makeFlameNode('marked', 250),
      makeFlameNode('marked-terminal', 150),
      makeFlameNode('glob', 200),
      makeFlameNode('inquirer', 350, [
        makeFlameNode('rxjs', 180),
        makeFlameNode('ansi-escapes', 40),
      ]),
    ]),
    makeFlameNode('GC (12 events)', 350, [
      makeFlameNode('GC (scavenge)', 120),
      makeFlameNode('GC (scavenge)', 80),
      makeFlameNode('GC (mark-sweep)', 150),
    ]),
    makeFlameNode('Event Loop Lag (3 events)', 180, [
      makeFlameNode('Event Loop Lag: 45.2ms', 80),
      makeFlameNode('Event Loop Lag: 62.1ms', 100),
    ]),
  ]);

  const memFlame = makeFlameNode('(memory)', 85000000, [
    makeFlameNode('node_builtin', 12000000, [
      makeFlameNode('fs', 3000000),
      makeFlameNode('path', 1500000),
      makeFlameNode('http2', 4000000),
      makeFlameNode('crypto', 2500000),
      makeFlameNode('util', 1000000),
    ]),
    makeFlameNode('app', 18000000, [
      makeFlameNode('./src/cli.ts', 5000000),
      makeFlameNode('./src/ui/app.tsx', 4000000),
      makeFlameNode('./src/core/agent.ts', 3000000),
      makeFlameNode('./src/auth/auth.ts', 3000000),
      makeFlameNode('./src/config/config.ts', 2000000),
      makeFlameNode('./src/tools/index.ts', 1000000),
    ]),
    makeFlameNode('ink', 15000000, [
      makeFlameNode('react', 8000000),
      makeFlameNode('yoga-layout', 5000000),
      makeFlameNode('chalk', 2000000),
    ]),
    makeFlameNode('@google/genai', 12000000, [
      makeFlameNode('google-auth-library', 5000000),
      makeFlameNode('protobufjs', 4000000),
      makeFlameNode('gaxios', 3000000),
    ]),
    makeFlameNode('inquirer', 8000000, [
      makeFlameNode('rxjs', 5000000),
      makeFlameNode('ansi-escapes', 1500000),
      makeFlameNode('figures', 1500000),
    ]),
    makeFlameNode('other', 20000000, [
      makeFlameNode('ajv', 6000000),
      makeFlameNode('marked', 4000000),
      makeFlameNode('glob', 3000000),
      makeFlameNode('commander', 2000000),
      makeFlameNode('conf', 3000000),
      makeFlameNode('semver', 2000000),
    ]),
  ]);

  const memTimeline = [];
  for (let i = 0; i <= 100; i++) {
    const t = i * 45; // ~4.5s total
    const phase = i < 10 ? 'bootstrap' : i < 40 ? 'require_heavy' : i < 70 ? 'init' : 'ready';
    const base = phase === 'bootstrap' ? 15 : phase === 'require_heavy' ? 40 : phase === 'init' ? 70 : 80;
    const noise = Math.sin(i * 0.3) * 3 + Math.random() * 2;
    memTimeline.push({
      t,
      heapUsed: (base + noise) * 1024 * 1024,
      heapTotal: (base + 20 + noise * 0.5) * 1024 * 1024,
      rss: (base + 40 + noise * 0.3) * 1024 * 1024,
      external: 5 * 1024 * 1024,
      label: phase,
      moduleIndex: Math.floor(i * 2.5)
    });
  }

  return [{
    id: 1,
    tti_ms: 4520,
    cpuFlame,
    wallFlame,
    memFlame,
    memTimeline,
    totalModules: 247,
    system: {
      node_version: 'v20.11.0',
      os: 'Linux',
      arch: 'x86_64',
      cpus: 8,
      memory_total_kb: 16384000,
      load_average: '1.2, 0.8, 0.5'
    }
  }];
}

// ─── HTML Template ──────────────────────────────────────────────────────────
function generateHTML(runs) {
  const runsJSON = JSON.stringify(runs, null, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gemini CLI Startup Latency — Flame Graph Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --fg: #c9d1d9; --fg2: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --orange: #d29922;
    --purple: #bc8cff; --pink: #f778ba;
    --border: #30363d; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.5;
    overflow-x: hidden;
  }

  /* Header */
  .header {
    background: linear-gradient(135deg, #1a1f35, #0d1117);
    border-bottom: 1px solid var(--border);
    padding: 24px 32px;
  }
  .header h1 { font-size: 24px; font-weight: 600; }
  .header h1 span { color: var(--accent); }
  .header .subtitle { color: var(--fg2); margin-top: 4px; font-size: 14px; }

  /* Stats bar */
  .stats-bar {
    display: flex; gap: 16px; padding: 16px 32px;
    background: var(--bg2); border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .stat-card {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px 20px; min-width: 150px;
  }
  .stat-card .label { font-size: 11px; text-transform: uppercase; color: var(--fg2); letter-spacing: 0.5px; }
  .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 2px; }
  .stat-card .value.time { color: var(--accent); }
  .stat-card .value.count { color: var(--green); }
  .stat-card .value.mem { color: var(--purple); }
  .stat-card .unit { font-size: 14px; font-weight: 400; color: var(--fg2); }

  /* Tab nav */
  .tab-nav {
    display: flex; gap: 0; padding: 0 32px;
    background: var(--bg2); border-bottom: 1px solid var(--border);
  }
  .tab-btn {
    padding: 12px 24px; cursor: pointer; border: none;
    background: transparent; color: var(--fg2); font-size: 14px;
    font-weight: 500; border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }
  .tab-btn:hover { color: var(--fg); background: var(--bg3); }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* Panels */
  .tab-panel { display: none; padding: 24px 32px; }
  .tab-panel.active { display: block; }

  /* Flame graph container */
  .flame-section {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: var(--radius); margin-bottom: 20px; overflow: hidden;
  }
  .flame-section .section-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    background: var(--bg3);
  }
  .flame-section .section-title { font-weight: 600; font-size: 15px; }
  .flame-section .section-subtitle { color: var(--fg2); font-size: 12px; }

  /* Flame graph */
  .flame-container {
    width: 100%; min-height: 400px; position: relative;
    overflow-x: auto; overflow-y: hidden;
  }
  .flame-container canvas { display: block; }

  /* Tooltip */
  .flame-tooltip {
    position: fixed; z-index: 1000; pointer-events: none;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 14px; font-size: 12px;
    max-width: 400px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    display: none;
  }
  .flame-tooltip .tt-name { font-weight: 600; color: var(--accent); margin-bottom: 4px; word-break: break-all; }
  .flame-tooltip .tt-row { display: flex; justify-content: space-between; gap: 16px; }
  .flame-tooltip .tt-label { color: var(--fg2); }
  .flame-tooltip .tt-val { font-weight: 500; font-family: 'SF Mono', Monaco, Consolas, monospace; }

  /* Search */
  .search-bar {
    display: flex; gap: 8px; align-items: center;
  }
  .search-bar input {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 12px; color: var(--fg);
    font-size: 13px; width: 250px; outline: none;
  }
  .search-bar input:focus { border-color: var(--accent); }
  .search-bar button {
    background: var(--bg3); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 12px; color: var(--fg);
    cursor: pointer; font-size: 13px;
  }
  .search-bar button:hover { background: var(--border); }

  /* Memory timeline */
  .mem-timeline { width: 100%; height: 250px; }
  .mem-timeline canvas { width: 100%; height: 100%; }

  /* Run selector */
  .run-selector {
    display: flex; gap: 8px; align-items: center; padding: 8px 16px;
    background: var(--bg3); border-bottom: 1px solid var(--border);
  }
  .run-selector label { font-size: 13px; color: var(--fg2); }
  .run-selector select {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 8px; color: var(--fg); font-size: 13px;
  }

  /* Info panel */
  .info-panel {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px; margin-bottom: 20px;
    font-size: 13px; line-height: 1.8;
  }
  .info-panel code {
    background: var(--bg3); padding: 2px 6px; border-radius: 3px;
    font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 12px;
  }

  /* Breadcrumb zoom path */
  .zoom-breadcrumb {
    display: flex; gap: 4px; align-items: center; flex-wrap: wrap;
    padding: 8px 16px; background: var(--bg); border-bottom: 1px solid var(--border);
    font-size: 12px; min-height: 32px;
  }
  .zoom-breadcrumb .crumb {
    color: var(--accent); cursor: pointer; padding: 2px 6px;
    border-radius: 3px;
  }
  .zoom-breadcrumb .crumb:hover { background: var(--bg3); }
  .zoom-breadcrumb .sep { color: var(--fg2); }

  /* Color legend */
  .legend {
    display: flex; gap: 16px; padding: 8px 16px;
    border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  .legend-item {
    display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--fg2);
  }
  .legend-swatch {
    width: 14px; height: 14px; border-radius: 3px;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .stats-bar { flex-direction: column; }
    .header, .tab-panel, .tab-nav { padding-left: 16px; padding-right: 16px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1><span>Gemini CLI</span> Startup Latency Testbed</h1>
  <div class="subtitle">Interactive flame graphs — CPU, Wall Time, Memory</div>
</div>

<div class="stats-bar" id="statsBar"></div>

<div class="tab-nav">
  <button class="tab-btn active" data-tab="cpu">CPU Flame Graph</button>
  <button class="tab-btn" data-tab="wall">Wall Time Flame Graph</button>
  <button class="tab-btn" data-tab="memory">Memory Flame Graph</button>
  <button class="tab-btn" data-tab="timeline">Memory Timeline</button>
  <button class="tab-btn" data-tab="comparison">Run Comparison</button>
</div>

<!-- CPU Flame Graph -->
<div class="tab-panel active" id="tab-cpu">
  <div class="flame-section">
    <div class="section-header">
      <div>
        <div class="section-title">CPU Time Flame Graph</div>
        <div class="section-subtitle">V8 CPU profile — where CPU cycles are spent during startup</div>
      </div>
      <div class="search-bar">
        <input id="cpuSearch" placeholder="Search functions..." />
        <button onclick="searchFlame('cpu')">Search</button>
        <button onclick="resetFlame('cpu')">Reset</button>
      </div>
    </div>
    <div class="legend" id="cpuLegend"></div>
    <div class="zoom-breadcrumb" id="cpuBreadcrumb"></div>
    <div class="flame-container" id="cpuFlame"></div>
  </div>
</div>

<!-- Wall Time Flame Graph -->
<div class="tab-panel" id="tab-wall">
  <div class="flame-section">
    <div class="section-header">
      <div>
        <div class="section-title">Wall Time Flame Graph</div>
        <div class="section-subtitle">Module require() tree — where wall-clock time goes</div>
      </div>
      <div class="search-bar">
        <input id="wallSearch" placeholder="Search modules..." />
        <button onclick="searchFlame('wall')">Search</button>
        <button onclick="resetFlame('wall')">Reset</button>
      </div>
    </div>
    <div class="legend" id="wallLegend"></div>
    <div class="zoom-breadcrumb" id="wallBreadcrumb"></div>
    <div class="flame-container" id="wallFlame"></div>
  </div>
</div>

<!-- Memory Flame Graph -->
<div class="tab-panel" id="tab-memory">
  <div class="flame-section">
    <div class="section-header">
      <div>
        <div class="section-title">Memory Attribution Flame Graph</div>
        <div class="section-subtitle">Heap memory allocated per module during startup</div>
      </div>
      <div class="search-bar">
        <input id="memSearch" placeholder="Search modules..." />
        <button onclick="searchFlame('mem')">Search</button>
        <button onclick="resetFlame('mem')">Reset</button>
      </div>
    </div>
    <div class="legend" id="memLegend"></div>
    <div class="zoom-breadcrumb" id="memBreadcrumb"></div>
    <div class="flame-container" id="memFlame"></div>
  </div>
</div>

<!-- Memory Timeline -->
<div class="tab-panel" id="tab-timeline">
  <div class="flame-section">
    <div class="section-header">
      <div>
        <div class="section-title">Memory Usage Timeline</div>
        <div class="section-subtitle">Heap, RSS, and external memory over startup duration</div>
      </div>
    </div>
    <div class="flame-container" style="min-height:300px;">
      <canvas id="timelineCanvas"></canvas>
    </div>
  </div>
</div>

<!-- Run Comparison -->
<div class="tab-panel" id="tab-comparison">
  <div class="flame-section">
    <div class="section-header">
      <div>
        <div class="section-title">Run Comparison</div>
        <div class="section-subtitle">Time-to-interactive across all profiling runs</div>
      </div>
    </div>
    <div class="flame-container" style="min-height: 300px;">
      <canvas id="comparisonCanvas"></canvas>
    </div>
  </div>
</div>

<div class="flame-tooltip" id="tooltip"></div>

<script>
// ─── DATA ───────────────────────────────────────────────────────────────────
const RUNS = ${runsJSON};
let currentRun = RUNS[0] || {};

// ─── FLAME GRAPH RENDERER (Canvas-based, interactive) ───────────────────────

// Deterministic hash for stable per-node colors (avoids flicker on re-render)
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

class FlameGraph {
  constructor(container, data, options = {}) {
    this.container = container;
    this.rootData = data;
    this.options = {
      colorScheme: options.colorScheme || 'warm',
      valueLabel: options.valueLabel || 'time',
      valueFormatter: options.valueFormatter || (v => v.toLocaleString() + ' μs'),
      minWidth: options.minWidth || 1,
      ...options
    };

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    container.innerHTML = '';
    container.appendChild(this.canvas);

    this.zoomStack = [data];
    this.highlighted = new Set();
    this.hoveredNode = null;
    this.ROW_HEIGHT = 22;
    this.PADDING = 1;
    this.MIN_VISIBLE_WIDTH = 2;

    this._layoutCache = new Map();
    this._setupResize();
    this._setupEvents();
    this.render();
  }

  _setupResize() {
    const ro = new ResizeObserver(() => {
      this._resize();
      this.render();
    });
    ro.observe(this.container);
    this._resize();
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.canvas.width = rect.width * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._layoutCache.clear();
  }

  currentRoot() {
    return this.zoomStack[this.zoomStack.length - 1];
  }

  // Layout: compute x, y, width for each node
  _layout(root) {
    const nodes = [];
    const totalValue = root.value || 1;
    let maxDepth = 0;

    const visit = (node, x, depth) => {
      const w = (node.value / totalValue) * this.width;
      if (w < this.MIN_VISIBLE_WIDTH && depth > 0) return;

      nodes.push({ node, x, y: depth, w });
      maxDepth = Math.max(maxDepth, depth);

      let childX = x;
      if (node.children) {
        // Sort children by value descending for stable layout
        const sorted = [...node.children].sort((a, b) => b.value - a.value);
        for (const child of sorted) {
          visit(child, childX, depth + 1);
          childX += (child.value / totalValue) * this.width;
        }
      }
    };

    visit(root, 0, 0);
    this.maxDepth = maxDepth;

    const height = (maxDepth + 1) * this.ROW_HEIGHT + 10;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.height = height * dpr;
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    return nodes;
  }

  // Color schemes
  _color(node, layoutNode) {
    const name = node.name || '';
    const scheme = this.options.colorScheme;

    // Highlighted?
    if (this.highlighted.size > 0 && !this.highlighted.has(name)) {
      return 'rgba(80,80,80,0.4)';
    }

    // Hovered?
    const isHovered = this.hoveredNode === layoutNode;

    const jitter = hashStr(name) % 12; // 0–11, deterministic per node name
    if (scheme === 'warm') {
      // CPU: warm oranges/reds based on self-time proportion
      const selfRatio = (node.selfValue || node.data?.selfTime_us || 0) / Math.max(node.value, 1);
      const h = 10 + (1 - selfRatio) * 40; // 10 (red) to 50 (orange)
      const s = 70 + selfRatio * 20;
      const l = isHovered ? 60 : 40 + jitter;
      return \`hsl(\${h}, \${s}%, \${l}%)\`;
    } else if (scheme === 'cool') {
      // Wall time: blues/greens based on category
      let h = 200;
      if (name.includes('node:') || name.includes('node_builtin')) h = 140;
      else if (name.includes('@google')) h = 210;
      else if (name.includes('GC')) h = 0;
      else if (name.includes('Event Loop')) h = 45;
      else if (name.includes('react') || name.includes('ink')) h = 270;
      else h = 170 + (name.charCodeAt(0) || 0) % 60;
      const l = isHovered ? 55 : 30 + jitter;
      return \`hsl(\${h}, 65%, \${l}%)\`;
    } else if (scheme === 'purple') {
      // Memory: purples/magentas
      let h = 280;
      if (name.includes('node_builtin')) h = 200;
      else if (name.includes('app') || name.startsWith('./')) h = 140;
      else h = 260 + (name.charCodeAt(0) || 0) % 40;
      const l = isHovered ? 55 : 30 + jitter;
      return \`hsl(\${h}, 55%, \${l}%)\`;
    }
    return '#555';
  }

  render() {
    const root = this.currentRoot();
    if (!root) return;

    const nodes = this._layout(root);
    const ctx = this.ctx;

    ctx.clearRect(0, 0, this.width, this.canvas.height / (window.devicePixelRatio || 1));

    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';

    for (const ln of nodes) {
      const y = ln.y * this.ROW_HEIGHT;
      const h = this.ROW_HEIGHT - this.PADDING;
      const x = ln.x;
      const w = Math.max(ln.w - this.PADDING, 1);

      // Fill
      ctx.fillStyle = this._color(ln.node, ln);
      ctx.fillRect(x, y, w, h);

      // Border
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, w, h);

      // Label
      if (w > 40) {
        ctx.fillStyle = '#fff';
        const label = ln.node.name.length > w / 7
          ? ln.node.name.substring(0, Math.floor(w / 7) - 1) + '…'
          : ln.node.name;
        ctx.fillText(label, x + 4, y + h / 2);
      }
    }

    this._layoutNodes = nodes;
  }

  _setupEvents() {
    const tooltip = document.getElementById('tooltip');

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let found = null;
      if (this._layoutNodes) {
        for (let i = this._layoutNodes.length - 1; i >= 0; i--) {
          const ln = this._layoutNodes[i];
          const y = ln.y * this.ROW_HEIGHT;
          if (mx >= ln.x && mx <= ln.x + ln.w && my >= y && my <= y + this.ROW_HEIGHT) {
            found = ln;
            break;
          }
        }
      }

      if (found) {
        this.hoveredNode = found;
        this.canvas.style.cursor = 'pointer';
        const node = found.node;
        const root = this.currentRoot();
        const pct = ((node.value / root.value) * 100).toFixed(1);

        let html = \`<div class="tt-name">\${node.name}</div>\`;
        html += \`<div class="tt-row"><span class="tt-label">Total:</span><span class="tt-val">\${this.options.valueFormatter(node.value)} (\${pct}%)</span></div>\`;
        if (node.selfValue) {
          html += \`<div class="tt-row"><span class="tt-label">Self:</span><span class="tt-val">\${this.options.valueFormatter(node.selfValue)}</span></div>\`;
        }
        if (node.data) {
          for (const [k, v] of Object.entries(node.data)) {
            if (k === 'functionName' || k === 'category') continue;
            html += \`<div class="tt-row"><span class="tt-label">\${k}:</span><span class="tt-val">\${v}</span></div>\`;
          }
        }
        if (node.children) {
          html += \`<div class="tt-row"><span class="tt-label">Children:</span><span class="tt-val">\${node.children.length}</span></div>\`;
        }

        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 420) + 'px';
        tooltip.style.top = (e.clientY + 12) + 'px';
      } else {
        this.hoveredNode = null;
        this.canvas.style.cursor = 'default';
        tooltip.style.display = 'none';
      }

      this.render();
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredNode = null;
      tooltip.style.display = 'none';
      this.render();
    });

    // Click to zoom in
    this.canvas.addEventListener('click', (e) => {
      if (this.hoveredNode && this.hoveredNode.node.children?.length > 0) {
        this.zoomStack.push(this.hoveredNode.node);
        this.render();
        this._updateBreadcrumb();
      }
    });

    // Right click to zoom out
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.zoomStack.length > 1) {
        this.zoomStack.pop();
        this.render();
        this._updateBreadcrumb();
      }
    });
  }

  _updateBreadcrumb() {
    const id = this.options.breadcrumbId;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;

    el.innerHTML = '';
    this.zoomStack.forEach((node, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = ' › ';
        el.appendChild(sep);
      }
      const crumb = document.createElement('span');
      crumb.className = 'crumb';
      crumb.textContent = node.name.substring(0, 40) + (node.name.length > 40 ? '…' : '');
      crumb.onclick = () => {
        this.zoomStack = this.zoomStack.slice(0, i + 1);
        this.render();
        this._updateBreadcrumb();
      };
      el.appendChild(crumb);
    });
  }

  search(query) {
    if (!query) { this.highlighted.clear(); this.render(); return; }
    this.highlighted.clear();
    const lq = query.toLowerCase();
    const visit = (node) => {
      if (node.name.toLowerCase().includes(lq)) this.highlighted.add(node.name);
      if (node.children) node.children.forEach(visit);
    };
    visit(this.rootData);
    this.render();
  }

  reset() {
    this.zoomStack = [this.rootData];
    this.highlighted.clear();
    this.render();
    this._updateBreadcrumb();
  }
}

// ─── INITIALIZE ─────────────────────────────────────────────────────────────
const flameGraphs = {};

function initDashboard() {
  if (!currentRun) return;

  // Stats bar
  const statsBar = document.getElementById('statsBar');
  const tti = currentRun.tti_ms;
  const modules = currentRun.totalModules || '—';
  const mem = currentRun.memTimeline
    ? (Math.max(...currentRun.memTimeline.map(s => s.rss)) / 1024 / 1024).toFixed(0)
    : '—';

  statsBar.innerHTML = \`
    <div class="stat-card"><div class="label">Time to Interactive</div><div class="value time">\${tti ?? '—'}<span class="unit"> ms</span></div></div>
    <div class="stat-card"><div class="label">Modules Loaded</div><div class="value count">\${modules}</div></div>
    <div class="stat-card"><div class="label">Peak RSS</div><div class="value mem">\${mem}<span class="unit"> MB</span></div></div>
    <div class="stat-card"><div class="label">Profiling Runs</div><div class="value count">\${RUNS.length}</div></div>
    <div class="stat-card"><div class="label">Node.js</div><div class="value" style="font-size:16px;color:var(--fg)">\${currentRun.system?.node_version || '—'}</div></div>
  \`;

  // CPU flame graph
  if (currentRun.cpuFlame) {
    flameGraphs.cpu = new FlameGraph(
      document.getElementById('cpuFlame'),
      currentRun.cpuFlame,
      {
        colorScheme: 'warm',
        valueLabel: 'CPU time',
        valueFormatter: v => v > 1000000 ? (v/1000000).toFixed(1) + ' s' : v > 1000 ? (v/1000).toFixed(1) + ' ms' : v + ' μs',
        breadcrumbId: 'cpuBreadcrumb'
      }
    );
    setupLegend('cpuLegend', [
      { color: 'hsl(10, 80%, 45%)', label: 'High self-time' },
      { color: 'hsl(35, 75%, 50%)', label: 'Medium self-time' },
      { color: 'hsl(50, 70%, 50%)', label: 'Low self-time (mostly children)' },
    ]);
  }

  // Wall time flame graph
  if (currentRun.wallFlame) {
    flameGraphs.wall = new FlameGraph(
      document.getElementById('wallFlame'),
      currentRun.wallFlame,
      {
        colorScheme: 'cool',
        valueLabel: 'Wall time',
        valueFormatter: v => v > 1000000 ? (v/1000000).toFixed(1) + ' s' : v > 1000 ? (v/1000).toFixed(1) + ' ms' : v + ' μs',
        breadcrumbId: 'wallBreadcrumb'
      }
    );
    setupLegend('wallLegend', [
      { color: 'hsl(140, 65%, 40%)', label: 'Node builtins' },
      { color: 'hsl(210, 65%, 40%)', label: '@google packages' },
      { color: 'hsl(270, 65%, 40%)', label: 'React/Ink (UI)' },
      { color: 'hsl(0, 65%, 40%)', label: 'Garbage Collection' },
      { color: 'hsl(45, 65%, 40%)', label: 'Event Loop Lag' },
      { color: 'hsl(180, 65%, 40%)', label: 'Other modules' },
    ]);
  }

  // Memory flame graph
  if (currentRun.memFlame) {
    flameGraphs.mem = new FlameGraph(
      document.getElementById('memFlame'),
      currentRun.memFlame,
      {
        colorScheme: 'purple',
        valueLabel: 'Heap bytes',
        valueFormatter: v => v > 1024*1024 ? (v/1024/1024).toFixed(1) + ' MB' : v > 1024 ? (v/1024).toFixed(1) + ' KB' : v + ' B',
        breadcrumbId: 'memBreadcrumb'
      }
    );
    setupLegend('memLegend', [
      { color: 'hsl(200, 55%, 40%)', label: 'Node builtins' },
      { color: 'hsl(140, 55%, 40%)', label: 'App code' },
      { color: 'hsl(280, 55%, 40%)', label: 'Dependencies' },
    ]);
  }

  // Memory timeline
  if (currentRun.memTimeline) {
    drawTimeline(currentRun.memTimeline);
  }

  // Run comparison
  drawComparison();
}

function setupLegend(id, items) {
  const el = document.getElementById(id);
  el.innerHTML = items.map(i =>
    \`<div class="legend-item"><div class="legend-swatch" style="background:\${i.color}"></div>\${i.label}</div>\`
  ).join('');
}

function searchFlame(type) {
  const input = document.getElementById(type + 'Search');
  if (flameGraphs[type] && input) flameGraphs[type].search(input.value);
}

function resetFlame(type) {
  const input = document.getElementById(type + 'Search');
  if (input) input.value = '';
  if (flameGraphs[type]) flameGraphs[type].reset();
}

// ─── Memory Timeline Chart ──────────────────────────────────────────────────
function drawTimeline(data) {
  const canvas = document.getElementById('timelineCanvas');
  if (!canvas || !data.length) return;

  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = 280 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '280px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = rect.width;
  const H = 280;
  const pad = { top: 20, right: 20, bottom: 40, left: 70 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const maxT = Math.max(...data.map(d => d.t));
  const maxMem = Math.max(...data.map(d => d.rss)) * 1.1;

  const xScale = t => pad.left + (t / maxT) * plotW;
  const yScale = v => pad.top + plotH - (v / maxMem) * plotH;

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(48,54,61,0.5)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (i / 5) * plotH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(((maxMem * (5 - i) / 5) / 1024 / 1024).toFixed(0) + ' MB', pad.left - 8, y + 4);
  }

  // X axis labels
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const t = (maxT * i / 5);
    const x = xScale(t);
    ctx.fillStyle = '#8b949e';
    ctx.fillText(t.toFixed(0) + ' ms', x, H - pad.bottom + 20);
  }

  // Draw lines
  const series = [
    { key: 'rss', color: '#f85149', label: 'RSS' },
    { key: 'heapTotal', color: '#d29922', label: 'Heap Total' },
    { key: 'heapUsed', color: '#58a6ff', label: 'Heap Used' },
    { key: 'external', color: '#bc8cff', label: 'External' },
  ];

  for (const s of series) {
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    let first = true;
    for (const d of data) {
      const x = xScale(d.t);
      const y = yScale(d[s.key] || 0);
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under
    ctx.globalAlpha = 0.08;
    ctx.lineTo(xScale(data[data.length-1].t), yScale(0));
    ctx.lineTo(xScale(data[0].t), yScale(0));
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Legend
  let lx = pad.left;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, H - 14, 12, 12);
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 16, H - 4);
    lx += ctx.measureText(s.label).width + 36;
  }
}

// ─── Run Comparison Chart ───────────────────────────────────────────────────
function drawComparison() {
  const canvas = document.getElementById('comparisonCanvas');
  if (!canvas || RUNS.length === 0) return;

  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = 280 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '280px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = rect.width;
  const H = 280;
  const pad = { top: 30, right: 30, bottom: 50, left: 70 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const validRuns = RUNS.filter(r => r.tti_ms != null);
  if (validRuns.length === 0) return;

  const maxTTI = Math.max(...validRuns.map(r => r.tti_ms)) * 1.2;
  const barW = Math.min(60, plotW / validRuns.length - 10);

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(48,54,61,0.5)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (i / 5) * plotH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText((maxTTI * (5 - i) / 5).toFixed(0) + ' ms', pad.left - 8, y + 4);
  }

  // Bars
  const avg = validRuns.reduce((s, r) => s + r.tti_ms, 0) / validRuns.length;
  validRuns.forEach((run, i) => {
    const x = pad.left + (i + 0.5) * (plotW / validRuns.length) - barW / 2;
    const barH = (run.tti_ms / maxTTI) * plotH;
    const y = pad.top + plotH - barH;

    // Bar
    const color = run.tti_ms > avg * 1.2 ? '#f85149' : run.tti_ms < avg * 0.8 ? '#3fb950' : '#58a6ff';
    ctx.fillStyle = color;
    ctx.beginPath();
    // roundRect with fallback for older browsers
    if (ctx.roundRect) {
      ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
    } else {
      ctx.moveTo(x + 4, y);
      ctx.lineTo(x + barW - 4, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + 4);
      ctx.lineTo(x + barW, y + barH);
      ctx.lineTo(x, y + barH);
      ctx.lineTo(x, y + 4);
      ctx.quadraticCurveTo(x, y, x + 4, y);
      ctx.closePath();
    }
    ctx.fill();

    // Value label
    ctx.fillStyle = '#c9d1d9';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(run.tti_ms + ' ms', x + barW / 2, y - 8);

    // X label
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('Run ' + run.id, x + barW / 2, H - pad.bottom + 20);
  });

  // Average line
  const avgY = pad.top + plotH - (avg / maxTTI) * plotH;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#d29922';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.left, avgY);
  ctx.lineTo(W - pad.right, avgY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#d29922';
  ctx.font = 'bold 11px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('avg: ' + avg.toFixed(0) + ' ms', W - pad.right + 4, avgY + 4);
}

// ─── TAB NAVIGATION ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

    // Re-render flame graphs on tab switch (canvas resize)
    setTimeout(() => {
      Object.values(flameGraphs).forEach(fg => { fg._resize(); fg.render(); });
      if (currentRun.memTimeline) drawTimeline(currentRun.memTimeline);
      drawComparison();
    }, 50);
  });
});

// Search on Enter key
['cpuSearch', 'wallSearch', 'memSearch'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchFlame(id.replace('Search', ''));
  });
});

// Init
initDashboard();

// Handle resize
window.addEventListener('resize', () => {
  if (currentRun.memTimeline) drawTimeline(currentRun.memTimeline);
  drawComparison();
});
</script>
</body>
</html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log('Gemini CLI Startup Testbed — Report Generator');
console.log('─'.repeat(50));

const { runs, useDemoData } = collectRunData(inputDir);

let reportRuns;
if (useDemoData || runs.length === 0) {
  console.log('No profiling data found. Generating demo visualization...');
  reportRuns = generateDemoData();
} else {
  console.log(`Found ${runs.length} profiling run(s)`);
  reportRuns = runs;
}

const html = generateHTML(reportRuns);

mkdirSync(outputDir, { recursive: true });
const outPath = join(outputDir, 'index.html');
writeFileSync(outPath, html);
console.log(`\nReport written to: ${outPath}`);

if (shouldServe) {
  const server = http.createServer((req, res) => {
    let url = req.url === '/' ? '/index.html' : req.url;
    // Basic sanitization
    const safeUrl = url.split('?')[0].replace(/\.\./g, '');
    const filePath = join(outputDir, safeUrl);

    try {
      const content = readFileSync(filePath);
      const ext = filePath.split('.').pop();
      const contentType = {
        'html': 'text/html',
        'js': 'application/javascript',
        'css': 'text/css',
        'json': 'application/json',
        'png': 'image/png',
        'jpg': 'image/jpeg',
      }[ext] || 'text/plain';

      res.setHeader('Content-Type', contentType);
      res.end(content);
    } catch (e) {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\nServer running at: ${url}`);
    console.log('Press Ctrl+C to stop');

    const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
    exec(`${start} ${url}`, (err) => {
      if (err) {
        console.log(`Note: Browser could not be opened automatically. Navigate to: ${url}`);
      }
    });
  });
}
