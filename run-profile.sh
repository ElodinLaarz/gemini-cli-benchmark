#!/usr/bin/env bash
# =============================================================================
# Gemini CLI Startup Latency Testbed — Orchestrator
# =============================================================================
# Measures wall time, CPU, and memory from `gemini` invocation to prompt-ready.
#
# Usage:
#   bash run-profile.sh [OPTIONS]
#
# Options:
#   --runs N          Number of profiling runs (default: 5)
#   --cpu-only        Only collect CPU profile
#   --mem-only        Only collect memory/heap profile
#   --wall-only       Only collect wall-time trace
#   --timeout N       Seconds to wait for prompt ready (default: 120)
#   --gemini-path P   Path to gemini binary (default: auto-detect)
#   --output-dir D    Output directory (default: ./profiles)
#   --cold            Drop filesystem caches between runs (requires sudo)
#   --no-report       Skip HTML report generation
#   --serve           Start a local server to view the report
#   --port N          Port for the local server (default: 8080)
# =============================================================================

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
RUNS=5
START_RUN=1
CPU_ONLY=false
MEM_ONLY=false
WALL_ONLY=false
TIMEOUT=120
GEMINI_PATH=""
OUTPUT_DIR="./profiles"
COLD_START=false
NO_REPORT=false
SHOULD_SERVE=false
SERVE_PORT=8080
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Parse arguments ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)       RUNS="$2";        shift 2 ;;
    --start-run)  START_RUN="$2";   shift 2 ;;
    --cpu-only)   CPU_ONLY=true;    shift ;;
    --mem-only)   MEM_ONLY=true;    shift ;;
    --wall-only)  WALL_ONLY=true;   shift ;;
    --timeout)    TIMEOUT="$2";     shift 2 ;;
    --gemini-path) GEMINI_PATH="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2";  shift 2 ;;
    --cold)       COLD_START=true;  shift ;;
    --no-report)  NO_REPORT=true;   shift ;;
    --serve)      SHOULD_SERVE=true; shift ;;
    --port)       SERVE_PORT="$2";  shift 2 ;;
    *)            echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ─── Resolve gemini binary ──────────────────────────────────────────────────
if [[ -z "$GEMINI_PATH" ]]; then
  GEMINI_PATH="$(which gemini 2>/dev/null || true)"
  if [[ -z "$GEMINI_PATH" ]]; then
    echo "ERROR: 'gemini' not found in PATH. Install with: npm install -g @google/gemini-cli"
    echo "       Or pass --gemini-path /path/to/gemini"
    exit 1
  fi
fi

# Resolve symlinks to find the actual Node.js entry point
GEMINI_REAL="$(readlink -f "$GEMINI_PATH" 2>/dev/null || realpath "$GEMINI_PATH" 2>/dev/null || echo "$GEMINI_PATH")"
GEMINI_DIR="$(dirname "$GEMINI_REAL")"

# Try to find the JS entry point for direct node invocation
GEMINI_ENTRY=""
for candidate in \
  "$GEMINI_DIR/../lib/node_modules/@google/gemini-cli/build/cli.js" \
  "$GEMINI_DIR/../lib/node_modules/@google/gemini-cli/dist/cli.js" \
  "$GEMINI_DIR/../lib/node_modules/@google/gemini-cli/dist/index.js" \
  "$GEMINI_DIR/../lib/node_modules/@google/gemini-cli/src/cli.js" \
  "$GEMINI_DIR/cli.js" \
  "$GEMINI_DIR/index.js" \
  "$GEMINI_REAL"; do
  if [[ -f "$candidate" ]]; then
    GEMINI_ENTRY="$(readlink -f "$candidate" 2>/dev/null || realpath "$candidate" 2>/dev/null || echo "$candidate")"
    break
  fi
done

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║         Gemini CLI Startup Latency Testbed v1.0                ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Gemini binary:  $GEMINI_PATH"
echo "║  Resolved entry: ${GEMINI_ENTRY:-<shell wrapper>}"
echo "║  Runs:           $RUNS"
echo "║  Timeout:        ${TIMEOUT}s"
echo "║  Cold start:     $COLD_START"
echo "║  Output:         $OUTPUT_DIR"
echo "╚══════════════════════════════════════════════════════════════════╝"

mkdir -p "$OUTPUT_DIR"/{cpu,mem,wall,combined}

# ─── Utility: detect prompt-ready ────────────────────────────────────────────
# Gemini CLI prints a prompt indicator when ready (e.g., ">" or "❯" or colored input area).
# We use `script` + timeout + pattern matching to detect this.
PROMPT_PATTERNS='(NORMAL mode|\[INSERT\]|for shortcuts|shift.tab to accept|Enter a prompt|Type a message|Type your message|Gemini>|>>>)'

detect_prompt_ready() {
  local logfile="$1"
  local start_ns="$2"

  while IFS= read -r line; do
    if echo "$line" | grep -qEi "$PROMPT_PATTERNS"; then
      local end_ns
      end_ns=$(date +%s%N 2>/dev/null || python3 -c "import time; print(int(time.time()*1e9))")
      local elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
      echo "$elapsed_ms"
      return 0
    fi
  done < <(tail -f "$logfile" 2>/dev/null)
}

# ─── Node.js flags for profiling ────────────────────────────────────────────
NODE_CPU_FLAGS="--cpu-prof --cpu-prof-interval=100"
NODE_HEAP_FLAGS="--heap-prof --heap-prof-interval=512"
NODE_TRACE_FLAGS="--trace-event-categories=v8,node,node.async_hooks"

# ─── Wall-time tracing via Node.js require hook ─────────────────────────────
create_require_hook() {
  cat > "$OUTPUT_DIR/wall/_require_hook.cjs" << 'HOOKEOF'
// Monkey-patch require() to trace module load times
const Module = require('module');
const origLoad = Module._load;
const fs = require('fs');
const { performance } = require('perf_hooks');

const traceData = [];
const startTime = performance.now();
const startTimestamp = Date.now() * 1000; // microseconds

Module._load = function(request, parent, isMain) {
  const loadStart = performance.now();
  const result = origLoad.apply(this, arguments);
  const loadEnd = performance.now();
  const durationMs = loadEnd - loadStart;

  if (durationMs > 0.1) { // Only trace loads > 0.1ms
    traceData.push({
      name: request,
      cat: "require",
      ph: "X",
      ts: Math.round((loadStart - startTime) * 1000 + startTimestamp),
      dur: Math.round(durationMs * 1000),
      pid: process.pid,
      tid: 1,
      args: {
        parent: parent ? parent.filename : '<root>',
        duration_ms: durationMs.toFixed(2)
      }
    });
  }
  return result;
};

// Also track GC and event loop
const gcTraces = [];
try {
  const obs = new (require('perf_hooks').PerformanceObserver)((list) => {
    for (const entry of list.getEntries()) {
      gcTraces.push({
        name: `GC (${entry.detail ? entry.detail.kind : 'unknown'})`,
        cat: "gc",
        ph: "X",
        ts: Math.round((entry.startTime - startTime) * 1000 + startTimestamp),
        dur: Math.round(entry.duration * 1000),
        pid: process.pid,
        tid: 2,
        args: { kind: entry.detail ? entry.detail.kind : 0 }
      });
    }
  });
  obs.observe({ entryTypes: ['gc'] });
} catch(e) { /* GC observation not available */ }

// Track event loop lag
const lagTraces = [];
let lastLagCheck = performance.now();
const lagInterval = setInterval(() => {
  const now = performance.now();
  const lag = now - lastLagCheck - 50; // expected 50ms interval
  if (lag > 5) { // >5ms lag is notable
    lagTraces.push({
      name: `Event Loop Lag: ${lag.toFixed(1)}ms`,
      cat: "event_loop",
      ph: "X",
      ts: Math.round((now - lag - startTime) * 1000 + startTimestamp),
      dur: Math.round(lag * 1000),
      pid: process.pid,
      tid: 3,
      args: { lag_ms: lag.toFixed(1) }
    });
  }
  lastLagCheck = now;
}, 50);

// Flush on exit (synchronous, fires on process.exit() and signals)
process.on('exit', () => {
  clearInterval(lagInterval);
  const output = JSON.stringify([...traceData, ...gcTraces, ...lagTraces], null, 2);
  const outPath = process.env.WALL_TRACE_OUTPUT || '/tmp/gemini_wall_trace.json';
  fs.writeFileSync(outPath, output);
  console.error(`[testbed] Wall trace written: ${traceData.length} requires, ${gcTraces.length} GCs, ${lagTraces.length} lags → ${outPath}`);
});
// Handle signals from PTY close (SIGHUP) or graceful shutdown (SIGTERM)
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
HOOKEOF
}

# ─── Memory snapshot via Node.js require hook ────────────────────────────────
create_memory_hook() {
  cat > "$OUTPUT_DIR/mem/_memory_hook.cjs" << 'MEMEOF'
// Track memory usage during module loading
const Module = require('module');
const origLoad = Module._load;
const fs = require('fs');
const v8 = require('v8');
const { performance } = require('perf_hooks');

const memSnapshots = [];
const startTime = performance.now();
const startMem = process.memoryUsage();
let lastSnapshot = startTime;
let moduleCount = 0;

function takeSnapshot(label) {
  const now = performance.now();
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  memSnapshots.push({
    timestamp_ms: now - startTime,
    label: label,
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers || 0,
    heapSizeLimit: heapStats.heap_size_limit,
    totalPhysicalSize: heapStats.total_physical_size,
    mallocedMemory: heapStats.malloced_memory,
    peakMallocedMemory: heapStats.peak_malloced_memory,
    numberOfNativeContexts: heapStats.number_of_native_contexts,
    numberOfDetachedContexts: heapStats.number_of_detached_contexts,
    moduleIndex: moduleCount
  });
}

takeSnapshot('__start__');

Module._load = function(request, parent, isMain) {
  const pre = process.memoryUsage();
  const result = origLoad.apply(this, arguments);
  const post = process.memoryUsage();
  moduleCount++;

  const heapDelta = post.heapUsed - pre.heapUsed;
  const rssDelta = post.rss - pre.rss;

  // Snapshot every module that allocates >50KB or every 20th module
  if (Math.abs(heapDelta) > 50 * 1024 || moduleCount % 20 === 0) {
    takeSnapshot(request);
  }

  return result;
};

// Periodic snapshots every 100ms
const snapInterval = setInterval(() => {
  takeSnapshot('__periodic__');
}, 100);

// Flush on exit (synchronous, fires on process.exit() and signals)
process.on('exit', () => {
  clearInterval(snapInterval);
  takeSnapshot('__end__');
  const outPath = process.env.MEM_TRACE_OUTPUT || '/tmp/gemini_mem_trace.json';
  fs.writeFileSync(outPath, JSON.stringify({
    startMemory: startMem,
    snapshots: memSnapshots,
    totalModulesLoaded: moduleCount
  }, null, 2));
  console.error(`[testbed] Memory trace: ${memSnapshots.length} snapshots, ${moduleCount} modules → ${outPath}`);
});
// Handle signals from PTY close (SIGHUP) or graceful shutdown (SIGTERM)
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
MEMEOF
}

# ─── Run a single profiling iteration ────────────────────────────────────────
run_iteration() {
  local iter="$1"
  local run_cpu="$2"
  local run_mem="$3"
  local run_wall="$4"

  echo ""
  echo "━━━ Run $iter/$RUNS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Drop caches if cold-start requested
  if [[ "$COLD_START" == "true" ]]; then
    echo "  [cold] Dropping filesystem caches..."
    sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || \
      echo "  [cold] WARNING: Could not drop caches (need sudo)"
  fi

  local iter_dir="$OUTPUT_DIR/combined/run_${iter}"
  rm -rf "$iter_dir"
  mkdir -p "$iter_dir"

  local LOGFILE="$iter_dir/terminal_output.log"
  local NODE_FLAGS=""
  local PRELOAD_FLAGS=""
  local ENV_VARS=""

  # Configure CPU profiling
  if [[ "$run_cpu" == "true" ]]; then
    NODE_FLAGS="$NODE_FLAGS $NODE_CPU_FLAGS --cpu-prof-dir=$iter_dir"
  fi

  # Configure wall-time tracing
  if [[ "$run_wall" == "true" ]]; then
    create_require_hook
    local wall_out="$iter_dir/wall_trace.json"
    PRELOAD_FLAGS="--require $OUTPUT_DIR/wall/_require_hook.cjs"
    ENV_VARS="WALL_TRACE_OUTPUT=$wall_out"
  fi

  # Configure memory profiling
  if [[ "$run_mem" == "true" ]]; then
    create_memory_hook
    local mem_out="$iter_dir/mem_trace.json"
    PRELOAD_FLAGS="$PRELOAD_FLAGS --require $OUTPUT_DIR/mem/_memory_hook.cjs"
    ENV_VARS="$ENV_VARS MEM_TRACE_OUTPUT=$mem_out"
  fi

  # Configure trace events
  if [[ "$run_cpu" == "true" || "$run_wall" == "true" ]]; then
    NODE_FLAGS="$NODE_FLAGS $NODE_TRACE_FLAGS --trace-event-file-pattern=$iter_dir/trace_events_%p.log"
  fi

  # Record start timestamp
  local start_ns
  start_ns=$(date +%s%N 2>/dev/null || python3 -c "import time; print(int(time.time()*1e9))")
  local start_epoch_ms=$(( start_ns / 1000000 ))
  echo "$start_epoch_ms" > "$iter_dir/start_timestamp"

  echo "  [start] $(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')"

  # Launch gemini with profiling
  # We use `script` to capture PTY output (for prompt detection) and
  # `timeout` to kill it after the prompt is found or timeout elapses.
  if [[ -n "$GEMINI_ENTRY" && ("$GEMINI_ENTRY" != "$GEMINI_PATH" || "$GEMINI_ENTRY" == *.js) ]]; then
    # Direct node invocation for full profiling control
    local CMD="env $ENV_VARS NODE_OPTIONS=\"$NODE_FLAGS $PRELOAD_FLAGS\" node $GEMINI_ENTRY"
  else
    # Shell wrapper — limited profiling via NODE_OPTIONS
    local CMD="env $ENV_VARS NODE_OPTIONS=\"$NODE_FLAGS $PRELOAD_FLAGS\" $GEMINI_PATH"
  fi

  echo "  [cmd] $CMD"

  # Launch in background, capture output
  # -f/--flush ensures PTY output is written to LOGFILE in real-time (not buffered until exit)
  script -q -f -c "timeout ${TIMEOUT}s $CMD" "$LOGFILE" &>/dev/null &
  local PID=$!

  # Monitor for prompt-ready
  local elapsed_ms=0
  local found=false
  local check_interval=0.1
  local checks=0
  local max_checks=$(( TIMEOUT * 10 ))

  while [[ $checks -lt $max_checks ]]; do
    if ! kill -0 $PID 2>/dev/null; then
      # Process exited
      break
    fi

    if [[ -f "$LOGFILE" ]] && grep -qEi "$PROMPT_PATTERNS" "$LOGFILE" 2>/dev/null; then
      local end_ns
      end_ns=$(date +%s%N 2>/dev/null || python3 -c "import time; print(int(time.time()*1e9))")
      elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
      found=true
      break
    fi

    sleep $check_interval
    checks=$((checks + 1))
  done

  # Kill gemini process — SIGTERM to script closes the PTY, which sends SIGHUP to
  # the node child, triggering our flush handlers before it exits.
  kill $PID 2>/dev/null || true
  # Give node 3 seconds to handle SIGHUP and write trace files before we proceed
  sleep 3
  wait $PID 2>/dev/null || true

  # Also kill any lingering node processes from this run
  pkill -f "cpu-prof-dir=$iter_dir" 2>/dev/null || true

  if [[ "$found" == "true" ]]; then
    echo "  [done] Prompt ready in ${elapsed_ms}ms"
    echo "$elapsed_ms" > "$iter_dir/tti_ms"
  else
    echo "  [timeout] Prompt not detected within ${TIMEOUT}s"
    echo "TIMEOUT" > "$iter_dir/tti_ms"
  fi

  # Move any CPU profile files generated in CWD
  mv ./*.cpuprofile "$iter_dir/" 2>/dev/null || true
  mv ./*.heapprofile "$iter_dir/" 2>/dev/null || true

  # Record system state
  cat > "$iter_dir/system_info.json" << SYSEOF
{
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "node_version": "$(node --version 2>/dev/null || echo unknown)",
  "npm_version": "$(npm --version 2>/dev/null || echo unknown)",
  "os": "$(uname -s)",
  "arch": "$(uname -m)",
  "kernel": "$(uname -r)",
  "cpus": $(nproc 2>/dev/null || echo 1),
  "memory_total_kb": $(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0),
  "memory_available_kb": $(grep MemAvailable /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0),
  "load_average": "$(uptime | sed 's/.*load average: //')"
}
SYSEOF

  sleep 1  # Brief cooldown between runs
}

# ─── Determine what to profile ──────────────────────────────────────────────
RUN_CPU=true
RUN_MEM=true
RUN_WALL=true

if [[ "$CPU_ONLY" == "true" ]]; then
  RUN_MEM=false; RUN_WALL=false
elif [[ "$MEM_ONLY" == "true" ]]; then
  RUN_CPU=false; RUN_WALL=false
elif [[ "$WALL_ONLY" == "true" ]]; then
  RUN_CPU=false; RUN_MEM=false
fi

# ─── Execute profiling runs ─────────────────────────────────────────────────
echo ""
echo "Starting $RUNS profiling run(s)..."
echo ""

END_RUN=$(( START_RUN + RUNS - 1 ))
for i in $(seq "$START_RUN" "$END_RUN"); do
  run_iteration "$i" "$RUN_CPU" "$RUN_MEM" "$RUN_WALL"
done

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                     Results Summary                            ║"
echo "╠══════════════════════════════════════════════════════════════════╣"

total_ms=0
count=0
min_ms=999999
max_ms=0

for dir in "$OUTPUT_DIR"/combined/run_*; do
  if [[ -f "$dir/tti_ms" ]]; then
    val=$(cat "$dir/tti_ms")
    if [[ "$val" != "TIMEOUT" ]]; then
      total_ms=$((total_ms + val))
      count=$((count + 1))
      [[ $val -lt $min_ms ]] && min_ms=$val
      [[ $val -gt $max_ms ]] && max_ms=$val
      printf "║  Run %-3s: %6d ms                                           ║\n" "$(basename "$dir" | sed 's/run_//')" "$val"
    else
      printf "║  Run %-3s: TIMEOUT                                            ║\n" "$(basename "$dir" | sed 's/run_//')"
    fi
  fi
done

if [[ $count -gt 0 ]]; then
  avg_ms=$((total_ms / count))
  echo "╠══════════════════════════════════════════════════════════════════╣"
  printf "║  Min:     %6d ms                                           ║\n" "$min_ms"
  printf "║  Max:     %6d ms                                           ║\n" "$max_ms"
  printf "║  Avg:     %6d ms  (n=$count)                                ║\n" "$avg_ms"
fi
echo "╚══════════════════════════════════════════════════════════════════╝"

# ─── Generate report ─────────────────────────────────────────────────────────
if [[ "$NO_REPORT" != "true" ]]; then
  echo ""
  echo "Generating interactive flame graph report..."
  SERVE_ARGS=""
  [[ "$SHOULD_SERVE" == "true" ]] && SERVE_ARGS="--serve --port $SERVE_PORT"
  node "$SCRIPT_DIR/src/generate-report.js" --input "$OUTPUT_DIR" --output "$SCRIPT_DIR/output" $SERVE_ARGS
  echo "Report: $SCRIPT_DIR/output/index.html"
fi
