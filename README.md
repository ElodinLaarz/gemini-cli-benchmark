# Gemini CLI Startup Latency Testbed

A complete profiling testbed that measures **where time, CPU, and memory are spent** from the moment a user types `gemini` to the point the prompt is ready for input.

Produces an interactive HTML dashboard with zoomable flame graphs for CPU, wall time, and memory — plus a memory timeline and cross-run comparison chart.

## What It Measures

| Metric | How | Output |
|--------|-----|--------|
| **Wall time (TTI)** | PTY monitoring for prompt-ready pattern | Milliseconds from exec to interactive |
| **CPU flame graph** | V8 `--cpu-prof` at 100μs intervals | `.cpuprofile` → interactive flame chart |
| **Wall-time flame** | `require()` monkey-patch + GC observer + event loop lag | Module load tree with timing |
| **Memory flame** | Heap snapshots per module load via `process.memoryUsage()` | Attribution by module/package |
| **Memory timeline** | Periodic `v8.getHeapStatistics()` snapshots | RSS, heap, external over time |

## Architecture

```
run-profile.sh          ← Orchestrator: launches gemini with profiling flags
  ├── _require_hook.cjs ← Injected via --require: traces every require() call
  ├── _memory_hook.cjs  ← Injected via --require: snapshots heap per module
  └── node --cpu-prof   ← V8 CPU profiler via NODE_OPTIONS
        └── gemini CLI  ← The actual target being profiled

src/generate-report.js  ← Parses all profile data → single interactive HTML
  └── output/index.html ← Dashboard with canvas flame graphs
```

### Prompt-Ready Detection

The harness monitors terminal output for patterns indicating Gemini CLI is ready for input:
- `[INSERT]` / `NORMAL mode` — editor mode indicators in the input area
- `for shortcuts` / `shift+tab to accept` — UI chrome visible when prompt is ready
- `Enter a prompt` / `Type a message` — fallback text patterns

This gives the true **time-to-interactive (TTI)** — what the user actually experiences.

## Quick Start

```bash
# Prerequisites: Node.js 18+, gemini CLI installed and authenticated
npm install -g @google/gemini-cli
gemini  # complete auth setup before benchmarking

# Run 5 profiling iterations (default) and open the report
bash run-profile.sh
open output/index.html   # macOS
xdg-open output/index.html  # Linux

# Serve the report locally (auto-opens browser)
bash run-profile.sh --serve

# Faster iteration: fewer runs, explicit timeout
bash run-profile.sh --runs 3 --timeout 60

# Regenerate the report from existing profiles without re-running
node src/generate-report.js --input ./profiles --output ./output
open output/index.html
```

## Options

```
--runs N          Number of profiling runs (default: 5)
--cpu-only        Only collect CPU profile
--mem-only        Only collect memory/heap profile
--wall-only       Only collect wall-time trace
--timeout N       Seconds to wait for prompt ready (default: 120)
--gemini-path P   Path to gemini binary (default: auto-detect)
--output-dir D    Output directory (default: ./profiles)
--cold            Drop filesystem caches between runs (requires sudo)
--no-report       Skip HTML report generation
--serve           Start a local server and open the report in a browser
--port N          Port for the local server (default: 8080)
```

> **Note:** Complete `gemini` authentication before benchmarking. An unauthenticated or slow-auth session will inflate TTI numbers with network round-trips unrelated to startup performance.

## Dashboard Features

### Flame Graphs (CPU, Wall Time, Memory)
- **Click** any frame to zoom in
- **Right-click** to zoom back out
- **Search** to highlight matching frames
- **Hover** for detailed tooltips (self time, total time, file location)
- **Breadcrumb** trail shows zoom path
- Color-coded by category (Node builtins, app code, dependencies, GC)

### Memory Timeline
- RSS, Heap Total, Heap Used, External memory plotted over startup duration
- Shows exactly when memory spikes occur and which phase causes them

### Run Comparison
- Bar chart of TTI across all profiling runs
- Average line with variance indication
- Color-coded: green (fast), blue (normal), red (slow)

## How It Works

### Phase 1: Profiling
The orchestrator (`run-profile.sh`) launches `gemini` with:
1. **V8 CPU profiler** (`--cpu-prof --cpu-prof-interval=100`) — 100μs sampling
2. **Require hook** (`--require _require_hook.cjs`) — monkey-patches `Module._load` to time every `require()` call and builds a trace event timeline
3. **Memory hook** (`--require _memory_hook.cjs`) — snapshots `process.memoryUsage()` + `v8.getHeapStatistics()` around each module load
4. **PTY monitor** — watches terminal output via `script` command to detect the prompt-ready moment

### Phase 2: Report Generation
`src/generate-report.js` reads all collected profiles and:
1. Parses V8 `.cpuprofile` JSON into a d3-flamegraph-compatible tree
2. Converts the require trace events into a hierarchical wall-time tree
3. Groups memory snapshots by module/package into a memory attribution tree
4. Generates a single self-contained HTML file with Canvas-based interactive flame graphs

## Interpreting Results

### CPU Flame Graph
- **Wide frames at top** = functions taking most CPU overall
- **Red/orange** = high self-time (CPU spent in that function, not children)
- **Yellow** = mostly child time (orchestration functions)
- Look for unexpected hot spots in startup (e.g., JSON schema validation, crypto)

### Wall-Time Flame Graph
- **Wide frames** = slow-loading modules (disk I/O, compilation, initialization)
- **Blue tones** = Google packages, **Green** = Node builtins, **Purple** = UI (React/Ink)
- **Red** = GC pauses, **Yellow** = event loop lag
- The widest `require()` chains show the critical startup path

### Memory Flame Graph
- Size = heap bytes attributed to each module
- Identify which dependencies consume the most memory at startup
- Look for unexpectedly large allocations from utility packages

## Extending

### Custom Prompt Patterns
Edit `PROMPT_PATTERNS` in `run-profile.sh` if Gemini CLI changes its prompt indicator.

### Additional Profiling
Add more V8 flags in the `NODE_*_FLAGS` variables:
- `--trace-gc-verbose` for detailed GC logs
- `--max-old-space-size=256` to test under memory pressure
- `--prof` for V8 tick profiler (lower-level than cpu-prof)

### CI Integration
```bash
bash run-profile.sh --runs 3 --no-report --timeout 30
# Check profiles/combined/run_*/tti_ms for regression detection
```
