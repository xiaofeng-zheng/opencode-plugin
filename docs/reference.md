# Repository maintenance reference

For user installation and updates, follow the [root README](../README.md). This document preserves package-maintenance notes outside the installation guides.

## Independent packages

The repository root contains the private installer package, not a loadable plugin. Each `plugins/<name>/` directory owns its npm name, version, dependencies, lockfile, examples, documentation, and checks. Keep plugin-specific package commands in that plugin's directory; the root package and lockfile are for installer tooling. Do not require both plugins to share an SDK version.

```text
plugins/
  dynamic-api-key/
    package.json
    package-lock.json
    server.js
    src/
    dist/
    tests/
    scripts/
    examples/
    docs/
    README.md
  copilot-credits/
    package.json
    package-lock.json
    index.js / server.js / tui.js / rpc.js
    dist/
    src/
    tests/
    scripts/
    docs/
    README.md
```

## Packaging and checks

Use each plugin's existing packaging contract:

- **dynamic-api-key** keeps the compiled `dist/` and directory-discovery `server.js` in the repository and uses `npm pack` from its package root. See its [build and integration guide](../plugins/dynamic-api-key/docs/integration.md).
- **copilot-credits** keeps precompiled JavaScript and declarations in tracked `dist/`, with root JS entrypoints. `npm run compile` updates these files; `npm pack --ignore-scripts` packs the package root directly, and `npm run pack:check` verifies a clean consumer. See its [build and host-probe guide](../plugins/copilot-credits/docs/integration.md).

Both Git-facing manifests omit `build`, preparation/install lifecycle scripts, and `workspaces`, so native Git installation does not invoke a compiler. Developer builds use `npm run compile`; commit the resulting distribution files with source changes.

Keep source checks, clean tarball installation, real private-server loading, and live account/provider access as separate evidence levels. Historical results are documented for [dynamic-api-key](../plugins/dynamic-api-key/docs/verification.md) and [copilot-credits](../plugins/copilot-credits/docs/verification.md); they are not new verification of subsequent changes or of the user-level installer. Current English-language and installer checks are recorded in [installer verification](installer-verification.md).

For a new plugin, add an independent package with its own installation README, configuration examples, build/test scripts, and an entry in the root plugin list. Keep detailed development and safety material under its `docs/`. Licenses are defined by each plugin's `LICENSE` and/or `package.json`; this is not a single-license root package.

## Repository hygiene

Exclude API keys, `.env`, `node_modules`, test databases, temporary authorization data, and local runtime logs. The import records retained their original projects without copying local dependencies, test sandboxes, databases, or logs into this repository. No GitHub Actions or automated npm publishing workflow is configured in this checkout.

The user-level installer updates only the explicitly selected plugin's managed runtime and configuration entries. It does not publish packages, update remote code, or activate/restart OpenCode. Packaging tests and private-server probes are maintainer operations, not implied by a user's request to install a plugin.
