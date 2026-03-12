# Gemini CLI TODO

## Pending

- [ ] **Fast Auth Timeout** — `packages/cli/src/core/initializer.ts`: wraps `performInitialAuth` in a 300ms `Promise.race`
- [ ] **Skip Redundant Auth in Child Process** — `packages/cli/src/gemini.tsx`: skips auth when `GEMINI_CLI_NO_RELAUNCH` is set
- [ ] **Fallback Handler Auth Type Guard** — `packages/core/src/fallback/handler.ts`: early return if `authType !== LOGIN_WITH_GOOGLE`
- [ ] **Retry Logic Cleanup** — `packages/core/src/utils/retry.ts`, `packages/core/src/core/client.ts`: removed `INCOMPLETE_JSON_MESSAGE` from retryable errors, removed `retryFetchErrors` and `onRetry`

### Extension Migration Feature
**File:** `pr-description.md` (prepared, not yet implemented in source)

Allows extension authors to set a `migratedTo` field in `gemini-extension.json` to seamlessly migrate users to a new repo/name.

- [ ] Add `migratedTo` property to `ExtensionConfig` and `GeminiCLIExtension` types
- [ ] Update checker queries new repo URL when `migratedTo` is set
- [ ] `installOrUpdateExtension` transfers enablement state and deletes old directory
- [ ] Consent prompt explicitly warns users about migration/renaming
- [ ] Docs: `docs/extensions/reference.md`
- [ ] Docs: `docs/extensions/releasing.md`

## Go HTMX Server vs Node Server Parity

The Node server acts as a continuous, live profiling dashboard capturing detailed metrics (CPU, Memory, Wall time) and persisting them. The Go server acts as a generic Time-to-Interactive (TTI) benchmark runner but lacks deep V8 profiling, visualizations, and persistent storage.

### Phase 1: Storage and Execution
- [ ] **Persistent File Storage:** Modify `bench/internal/benchmark/store.go` to save job configurations and results to disk (e.g., using JSON files in a `data/` or `profiles/` directory) so history survives server restarts.
- [ ] **Integration with Profiling Scripts:** Update `runner.go` to either invoke `run-profile.sh` instead of the raw binary or natively implement the `NODE_OPTIONS` environment flags required to emit `.cpuprofile` and heap trace files.
- [ ] **System Information Capture:** Capture runtime system information (Node version, OS details) and store it with the benchmark result.

### Phase 2: Profile Parsing
- [ ] **CPU Profile Parser:** Implement logic in Go to parse V8 `.cpuprofile` JSON files and convert them into the hierarchical node structure required for the frontend flame graph (`cpuProfileToFlameGraph` equivalent).
- [ ] **Wall Trace Parser:** Implement logic to parse `wall_trace.json` to generate the wall-clock require() tree (`wallTraceToFlameGraph` equivalent).
- [ ] **Memory Trace Parser:** Implement logic to parse `mem_trace.json` snapshots to categorize memory usage by module and generate memory timelines (`memTraceToData` equivalent).

### Phase 3: Streaming and UI Visualizations
- [ ] **Server-Sent Events (SSE):** Replace or augment HTMX polling with an SSE endpoint in `handler.go` (similar to Node's `/events`) to push live updates and profile data to the client instantly.
- [ ] **Canvas Flame Graphs UI:** Port the frontend vanilla JS and Canvas implementation of `FlameGraph` and timeline charts from `live-server.js` into the Go server's `templates/` or associated static assets.
- [ ] **Dashboard Layout Update:** Redesign the detail page in the HTMX templates to include the multi-tab layout (CPU Flame, Wall Time, Memory, Timeline, Comparison) that exists in the Node dashboard.

### Phase 4: Continuous Mode (Optional Parity)
- [ ] **Infinite Loop Job Type:** Add a feature to the job dispatcher to allow "continuous" runs that loop indefinitely like the Node dashboard, running in the background until explicitly stopped by the user.
