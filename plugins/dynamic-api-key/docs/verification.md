# Dynamic API key verification history

This is a **historical record**, translated from the [verification document at commit 7090da0](https://github.com/xiaofeng-zheng/opencode-plugin/blob/7090da09ccbbde2b2210731f7975f0c7a4253826/plugins/dynamic-api-key/docs/verification.md). It preserves previously reported results, not a new test run or verification of later source, packaging, or installer changes. Machine-specific runtime logs were not committed.

## Recorded checks

- OpenCode servers **2.0.32** and **2.1.2** each passed **25** real HTTP/WebSocket integration cases.
- Node **22.22.3** passed **87** unit tests.
- Node **20.20.2** passed **86**, with **1 explicitly skipped**: the upstream Host test helper depends on Node >=22.15 `registerHooks`. The plugin runtime does not import that helper.
- Strict TypeScript typechecking, building, npm packing, fresh tarball installation, and real-server directory loading passed.
- The npm package contained the actual `server.js` entry. Installed bytes were checked; the test did not use a substitute wrapper to claim installation success.

The record states that the original plugin's runtime code stayed unchanged when imported into the multi-plugin layout and that directory-related checks were rerun.

## Recorded scenarios

**HTTP:** A/A cache reuse within one Session, B after TTL with an unchanged server PID, one command for concurrent refreshes, and no additional upstream request on nonzero exit, timeout, or empty output. The record also covers recovery, generation-scoped 401 invalidation, replacement of native static authentication, custom headers, JSON expiry, and origin restrictions.

**WebSocket:** real Upgrades and outbound frames, socket reuse for the same key, reconnect for a new key, and no frame after failed refresh. Delayed Upgrade caused expiry between handshake and send; the probe observed zero-frame rejection and subsequent recovery. HTTP fallback was not counted as a WebSocket pass.

A separate core safety review was recorded as finding no **Critical / Important** issues. That is a historical review outcome, not a guarantee for subsequent revisions. The documented availability trade-off remains: if a connection is cancelled or fails after handshake but before send, the next handshake can be conservatively rejected once; a later call recovers without allowing the old key. A regression test covered that behavior.

## Reproducing checks

Use the [build and integration guide](integration.md) from the plugin source directory. It preserves the source checks, harness self-test, multi-version matrix, package-loading requirements, and isolation rules.

For actual distributable acceptance, point `--plugin` at the installed package directory. Require `pluginPackaging.mode: direct-package-directory` and `fullPluginMatrixPassed: true` in the report. `--http-only`, `--runtime-probe`, and a JS-file debug wrapper are not complete package acceptance.

The harness generates reviewable local reports containing machine-specific paths and process/session IDs; those reports are not committed. It uses private servers and loopback upstreams, not real-provider requests or installation into a shared service.

## Not established by this record

- Sessionless `generate.text` or arbitrary third-party SDK/plugin combinations.
- Every possible title/compaction/retry combination as an individual integration case.
- Real vendor token-issuance services, OAuth migration, or native Windows/macOS runtimes.
- An OS-level network sandbox, physical zeroing of JS strings, or forced interruption of streams when TTL expires.
- Loading/activation in a particular user's configuration or verification of the new user-level installer.

See the [reference](reference.md) for the runtime, permission, and environment boundaries.
