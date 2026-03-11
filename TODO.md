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
