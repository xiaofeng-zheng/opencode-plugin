# Private OpenCode integration fixtures

These files support [scripts/integration.mjs](../integration.mjs); they are not a separately installable plugin and are excluded from the runtime package. They use Node built-ins, with no `ws` dependency or automatic package installation.

- To install the plugin for a user, follow the [plugin README](../../README.md).
- To run fixture checks or authorized private-server tests, read the [integration guide](../../docs/integration.md) for prerequisites, evidence levels, coverage, isolation, and cleanup.
- For previously recorded results, see the [verification history](../../docs/verification.md).

The fixtures use synthetic keys and loopback upstreams. They do not prove real-provider authentication, and a fixture-only or HTTP-only pass is not a complete plugin installation check.
