# OpenCode plugins

- **[copilot-credits](plugins/copilot-credits/README.md)** — Copilot quota in the full TUI footer and `/copilot` dialog.
- **[dynamic-api-key](plugins/dynamic-api-key/README.md)** — Short-lived API keys from a trusted command.

## Install

Requires OpenCode v2 and Git. Run the command for the plugin you need:

```sh
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

OpenCode manages the user-level installation. Copilot needs a native `github-copilot` connection to show quota; dynamic-api-key needs [provider options](plugins/dynamic-api-key/README.md#configure) before use.

## Update

```sh
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

## For AI agents

- Confirm the requested plugin; use the native commands above. Locate configuration with `opencode debug paths` and preserve existing plugins/options.
- Obtain real command, provider, TTL, and allowed-origin values when configuring dynamic-api-key. Never request/export tokens, invent credentials, or make model requests to test installation.
- Read back the installed entry. Installation is not activation: `opencode plugin list` may start a server, so ask before starting/reloading/restarting one.
