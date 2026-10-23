# Copilot credits reference

For installation and updates, use the [plugin README](../README.md). For packaging and isolated host probes, use the [integration guide](integration.md). Recorded runtime results are kept separately in the [verification history](verification.md).

## Configuration and deployment

The repository installer manages a package directory under `<config-dir>/installed-plugins/copilot-credits/node_modules/opencode-copilot-credits` and adds matching server/TUI entries. Use `--options FILE` only to replace this plugin's options explicitly; omitting it preserves existing options independently on each side.

For manual or split-host deployments, OpenCode v2's server configuration uses the plural `plugins` array and an **installed package directory**, not an individual TS file. This is an example for a separately chosen installation directory, not the installer's default path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/copilot-plugin/node_modules/opencode-copilot-credits",
    "options": { "cacheTtlSeconds": 300, "timeoutSeconds": 10, "refreshSeconds": 300 }
  }]
}
```

A local host can discover both entries. The installer writes both the server entry and an explicit `cli.json` TUI entry. When connecting to a remote server, install the package on the client too and configure the TUI half in the client's selected `cli.json`:

```json
{
  "plugins": [{
    "package": "/absolute/client/path/copilot-plugin/node_modules/opencode-copilot-credits",
    "options": { "refreshSeconds": 300 }
  }]
}
```

Client and server paths must exist on their respective hosts. The local installer affects only the selected local configuration directory, not a remote server. Preserve other settings/plugins when making a separate manual change. The configuration-directory default is `OPENCODE_CONFIG_DIR` when set, otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`; `--config-dir DIR` overrides it for the installer.

### Options

| Option | Default | Accepted values | Applied on |
| --- | --- | --- | --- |
| `cacheTtlSeconds` | `300` | 30-3600 seconds | Server memory cache |
| `timeoutSeconds` | `10` | 1-30 seconds | Server account request |
| `refreshSeconds` | `300` | 30-3600 seconds; `0` disables automatic polling | TUI |

Invalid configuration falls back to defaults. In a split deployment, configure client polling and server TTL separately. The TUI reads once on startup, then polls at the configured interval. Disabling polling does not disable the initial read or manual refresh.

## Account access and refresh

Installation can complete without a connected account. Quota access requires the server's active **OpenCode-native `github-copilot` OAuth connection** for GitHub.com. The plugin only reads the active connection; it does not log in or change accounts. `gh login` is not a substitute, and users should not copy or export tokens for this plugin.

On the server, the native provider contract supplies the GitHub user OAuth credential in `refresh`. Credentials remain server-side. The TUI uses the current location's authenticated OpenCode RPC, `copilot.credits.get({force?: boolean})`, and receives only a whitelisted DTO.

- `/copilot` bypasses the ordinary cache, but still honors GitHub `Retry-After` / rate-limit backoff.
- Concurrent requests share a single in-flight fetch; no model request is made.
- Errors display `unknown`. A previous successful snapshot for the same confirmed account can be shown as `stale`, preserving its original fetch time.
- If an RPC disconnect prevents confirmation of the account, the display is unknown. Switching accounts clears the prior snapshot and resolves the active connection again.
- No connection is `disconnected`, not a zero allowance.

## Units and quota semantics

- Display **AI credits** only when `token_based_billing: true` is explicit. `false` means **premium requests**, or chat requests for the chat bucket. Consistent bucket flags may be a fallback; missing or contradictory flags leave units unknown.
- For finite quota, `used = entitlement - quota_remaining`, with support for `remaining`. `percent_remaining` is the remaining percentage, not usage. Quantities derived only from that percentage carry `≈`. The footer shows at most three decimal places; RPC preserves numeric precision.
- `credits_used` is independent absolute consumption, not the finite-quota numerator. For example, entitlement 13000, remaining 807.7, and absolute consumption 14517 produce quota-used **12192.3 / 13000**, not 14517 / 13000.
- Free accounts may fall back to the chat bucket. Completion counts are not credits, and different buckets are not summed.
- Shared pools and accounts without a personal budget do not get invented personal limits, balances, or percentages. `unlimited` does not mean free unlimited spending. A zero allocation has no calculated percentage.
- Overage usage, overage budget, and whether paid overage is allowed are displayed independently.
- Reset time prefers a valid positive bucket Unix timestamp in **seconds**. `0` and `"0"` are absent sentinels, not 1970 reset dates. Invalid or absent timestamps fall back in order to the UTC date, ordinary date, then limited-user date. Without a valid fallback the reset is unknown.

## Network and security boundary

Only **GitHub.com** is supported. Enterprise and unknown credential metadata return unsupported. The production request is fixed to `GET https://api.github.com/copilot_internal/user`, without redirects or a configurable production endpoint.

This is an **internal, best-effort GitHub snapshot**, not an authoritative billing API. A 404 may mean insufficient permission rather than no subscription. The plugin does not substitute local cost estimates, token totals, hard-coded plan balances, or an inference probe for account quota.

TUI/RPC output is restricted to safe display fields and sanitized errors. Credentials are not returned to the TUI. Synthetic quota fixtures are test data, not real account balances. Any live account check requires separate authorization; installation alone is not permission to read an account, switch credentials, start a service, or make a model request.

Compatibility evidence is limited to the versions and platforms in the [verification history](verification.md). In particular, it does not establish support for the Node-distribution CLI, `mini`, an older shared server with a newer client, Enterprise, or native Windows/macOS runtimes.
