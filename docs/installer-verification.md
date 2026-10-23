# Installer and English-language verification

Automated checks for this change ran on Linux with Node.js **22.22.3** and the standard OpenCode **2.1.3** client/private server. These checks used synthetic settings and isolated directories, not a real account or the user's running service.

## Results

- Installer regression tests: **27 passed**. Coverage includes JSON/JSONC preservation, per-side options, duplicate entries, invalid/ambiguous files, symlink/hard-link protection, private backups, concurrent edits, locking, and rollback after configuration or runtime-verification failures. Publication-window tests inject saves during temporary-file sync, actual-file displacement, exclusive publication, and rollback; they also create an alternate server configuration after planning and during publication.
- Copilot tests: **41 passed**; dynamic-key tests: **87 passed**. Both TypeScript checks passed.
- Project-owned text passed the English scan. Dependencies, Git history, and ignored local test artifacts are excluded.
- A clean working-tree copy without `node_modules`, using paths with spaces and an unrelated working directory, successfully bootstrapped the installer dependency and installed both plugins.
- The complete installer smoke also passed with `NODE_ENV=production` and `NPM_CONFIG_OMIT=dev`: source preparation explicitly includes development dependencies for the build, while runtime consumers still omit them.
- Rerunning the installer repaired deliberately stale installed runtime files at the same package version. Existing server/client options were retained, configuration bytes remained unchanged on no-op updates, and plugin entries were not duplicated.
- A first dynamic-key install without options failed before package promotion/configuration changes. A synthetic credential command was never executed, including during server loading.
- Changed configuration files were retained as mode-`0600` backups inside mode-`0700` directories. Publication captures the actual displaced file, not just the earlier planned contents. A detected concurrent save is left in place or recoverable from the private backup; recovery also uses exclusive publication. The actual production configuration hashes remained unchanged.
- A private OpenCode server loaded both installed plugins from the installer-written user-level XDG configuration, without inline plugin overrides. Copilot RPC returned `disconnected` with null usage; unauthenticated RPC returned HTTP 401. The private server exited with code 0.
- Full-TUI probes rendered the English home footer and `/copilot` details for a disconnected account, and the prompt footer/details for a synthetic quota fixture. The reset-date fallback remained correct. Both TUI/private-server pairs exited with code 0, with no attempted or forwarded model requests.

The initial smoke harness queried a plugin-list snapshot before initialization and used the RPC ID instead of the server plugin ID. The corrected harness waits for initialization and asserts the actual `copilot.credits.server` / `dynamic-api-key` IDs and `state.status`; the complete corrected run passed.

## Reproduce

From the repository root:

```sh
npm ci --ignore-scripts
npm test
npm run check:english
node scripts/installer-smoke.mjs /absolute/path/opencode
```

The smoke script copies project-owned working-tree files into `$TMPDIR`, builds and installs the real packages, then starts only its explicitly isolated server. It requires network access for locked npm dependencies and refuses existing `/etc/opencode` discovery. It leaves its disposable sandbox for follow-up inspection; logs and the JSON report are under ignored `.artifacts/installer-smoke-*/`.

Use the installed Copilot package path printed in that report for rendered checks:

```sh
python3 plugins/copilot-credits/scripts/host-probe.py \
  --binary /absolute/path/opencode --expected-version 2.1.3 \
  --package /absolute/path/to/installed/opencode-copilot-credits --tui
python3 plugins/copilot-credits/scripts/host-probe.py \
  --binary /absolute/path/opencode --expected-version 2.1.3 \
  --package /absolute/path/to/installed/opencode-copilot-credits \
  --tui --session --synthetic-fixture
```

The host probe defaults to its historical 2.1.2 version gate; `--expected-version` selects an exact version for a new check. Its scratch environment uses `$TMPDIR`, with a project-local fallback. Host reports remain in the plugin's ignored `.artifacts/` directory.

These results do not claim npm/Git publication, active user installation, real quota access, real credential issuance, Node-distribution/mini support, or native Windows/macOS compatibility. No commit, push, production configuration change, or shared-service restart was part of these checks.
