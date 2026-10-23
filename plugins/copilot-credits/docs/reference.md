# Copilot credits reference

See the [README](../README.md) for installation and the [integration guide](integration.md) for maintainer checks.

## Configuration

Use `opencode debug paths` to locate global `opencode.json(c)`. Replace only the matching plugin entry to set options:

```json
{
  "package": "github:xiaofeng-zheng/opencode-plugins#main::path:plugins/copilot-credits",
  "options": { "cacheTtlSeconds": 300, "timeoutSeconds": 10, "refreshSeconds": 300 }
}
```

| Option | Default | Range | Applies to |
| --- | --- | --- | --- |
| `cacheTtlSeconds` | `300` | 30-3600 seconds | Server cache |
| `timeoutSeconds` | `10` | 1-30 seconds | Account request |
| `refreshSeconds` | `300` | 30-3600 seconds; `0` disables polling | TUI |

Invalid values use defaults. Disabling polling retains the initial read and manual refresh. For remote servers, make the package available on the client and add the same locator to the client's `cli.json` `plugins` array; configure client polling and server cache separately.

## Account and refresh

- Quota uses the server's active OpenCode-native `github-copilot` OAuth connection for GitHub.com. The plugin neither logs in nor switches accounts; `gh login` is not a substitute.
- Credentials remain server-side; authenticated RPC returns only display fields.
- `/copilot` bypasses ordinary cache but honors GitHub rate-limit backoff. Concurrent refreshes share one request; no model request is made.
- Errors display `unknown`. A previous successful snapshot for the same confirmed account may appear as `stale`, with its original fetch time. Account changes clear the previous snapshot.
- No connection is `disconnected`, not zero quota.

## Units and limits

- Explicit `token_based_billing: true` selects AI credits; `false` selects premium requests, or chat requests for the chat bucket. Missing/conflicting flags leave units unknown.
- Finite usage is `entitlement - quota_remaining`, with legacy `remaining` support. `percent_remaining` means remaining percentage; derived quantities carry `≈`.
- `credits_used` is separate absolute consumption, not the finite-quota numerator. Different buckets are not summed; completions are not credits.
- Shared pools have no invented personal budget or percentage. `unlimited` does not mean free unlimited spending; zero allocation has no percentage.
- Overage usage, budget, and permission are separate. Reset dates prefer valid positive Unix seconds; zero/missing values fall back to validated date fields, never an invented 1970 reset.

## Security and compatibility

Only GitHub.com is supported. The fixed endpoint is `https://api.github.com/copilot_internal/user`; redirects and configurable production endpoints are not allowed. It is an internal, best-effort snapshot, not an invoice. A 404 can indicate insufficient permissions.

Errors and display labels are sanitized. Installation does not authorize account access, credential export, or model requests. Linux standard-CLI checks do not establish native Windows/macOS, Node-distribution, `mini`, or Enterprise compatibility.
