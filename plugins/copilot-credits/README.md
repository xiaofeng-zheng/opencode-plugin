# opencode-copilot-credits

Show GitHub Copilot account quota in OpenCode's home/prompt footer. `/copilot` refreshes and displays balance, reset time, overage, fetch time, and safe errors. No model request is made.

## Install

With the OpenCode v2 standard CLI and Git installed:

```sh
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
```

Use the same command in Bash, PowerShell, or Command Prompt. OpenCode downloads the ready-to-load package and registers it in the user-level server configuration. No npm publication, manual checkout/build, or GitHub workflow is required.

Installation can succeed without an account connection. To fetch quota, the server needs OpenCode's native `github-copilot` login for GitHub.com; `gh login` is not a substitute. Never copy or export tokens. Open the **full TUI** to use the footer and `/copilot`; `mini` is not supported.

## Optional settings

Defaults are a 300-second cache/refresh interval and a 10-second request timeout. To customize them, replace only the matching string entry in the global `opencode.json(c)` with this object, preserving all other entries:

```json
{
  "package": "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits",
  "options": { "cacheTtlSeconds": 300, "timeoutSeconds": 10, "refreshSeconds": 300 }
}
```

Find the global directory with `opencode debug paths`. For remote servers, the package must also be available on the client; configure the same locator in the client's `cli.json` `plugins` array. A server-local installation does not install files on another machine.

## Update

```sh
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
```

Installed/configured is not proof of activation. Check `opencode plugin list` when starting or connecting to the intended server is acceptable; obtain approval before a shared-service reload/restart. Quota is an internal, best-effort GitHub snapshot, not an invoice. A disconnected account is not shown as a fabricated zero balance.

## Instructions for AI agents

- Confirm the intended OpenCode executable, user configuration, and Git availability; use passive version/help/path checks first.
- Review/back up relevant configuration and run the exact native install command above. Preserve other plugins and existing options; no online bootstrap or workflow authorization is needed.
- Read back this locator's configuration entry and the command outcome without exposing credentials. Do not silently replace an existing local installation.
- Allow disconnected installation. Never request/export tokens or make a model request to verify it.
- Report installation separately from activation. `opencode plugin list` may start a stopped server; ask before starting or restarting one.

[Configuration and limits](https://github.com/xiaofeng-zheng/opencode-plugin/blob/main/plugins/copilot-credits/docs/reference.md) · [Verification history](https://github.com/xiaofeng-zheng/opencode-plugin/blob/main/plugins/copilot-credits/docs/verification.md)
