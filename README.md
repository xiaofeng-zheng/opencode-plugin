# OpenCode plugins

User-level plugins for the OpenCode v2 standard CLI:

- **[copilot-credits](plugins/copilot-credits/README.md)** — Copilot account quota in the full TUI footer and `/copilot` dialog, without model requests.
- **[dynamic-api-key](plugins/dynamic-api-key/README.md)** — Short-lived API keys from a trusted command for Session HTTP/WebSocket requests.

## Install

Use OpenCode's native plugin manager with Git installed. Choose the plugin you need:

```sh
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

The same syntax works in Bash, PowerShell, and Command Prompt. OpenCode installs the precompiled package into its user-level cache and updates global configuration. No manual clone/build, npm publication, GitHub workflow, or online bootstrap is required. Keep the `::path:plugins/...` suffix: the repository root is a collection, not a plugin.

**Copilot credits:** quota access requires OpenCode's native `github-copilot` login, not `gh login`. Installation can succeed while disconnected. Use the full TUI, not `mini`.

**Dynamic API key:** [configure the trusted command, provider ID, TTL, and allowed origins](plugins/dynamic-api-key/README.md#configure) after installation and before model use. Setup fails closed until valid options are present.

Installation is separate from activation. `opencode plugin list` can check loading, but may start a stopped server. Native Windows/macOS runtime behavior has not been verified in this repository's local checks.

## Update

```sh
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

Run only the command for the intended plugin. Repeating `plugin add` avoids an identical configuration entry but does not replace `plugin update`. To pin a revision, replace `main` with a complete commit SHA; exact revisions are not automatically updated.

## Instructions for AI agents

1. Confirm the requested plugin and intended OpenCode installation. Check `opencode --version`, `opencode plugin add --help`, and `git --version`. `opencode debug paths` locates user configuration without starting a server.
2. Review/back up relevant configuration and run the exact native install command above. Preserve unrelated plugins, providers, and options; do not silently remove an older local installation or switch accounts.
3. For `dynamic-api-key`, obtain missing real provider/command/TTL/origin values and update only its matching plugin entry. Never invent credentials, broaden origins, or execute the credential command as an installation test. Copilot may remain disconnected; never request or export tokens.
4. Read back the matching configuration entry and actual command result without dumping secrets. An identical locator already configured as an object retains its options.
5. Distinguish installed/configured from active. Use `opencode service status` first and obtain approval before starting, reloading, or restarting a server/TUI. Do not make a model request to verify installation. Report actual results and remaining configuration work.

## Local-checkout fallback

The existing `install.sh` remains available for a reviewed local checkout on Linux. It requires Node.js >=22.15 and npm, manages a separate `installed-plugins/` directory, and backs up its own configuration changes:

```sh
./install.sh copilot-credits
./install.sh dynamic-api-key --options /absolute/path/options.json
```

Run from the repository root. Omit `--options` on later local updates to retain existing options; use `./install.sh --help` for path overrides. These local-script safeguards are separate from OpenCode's native plugin manager.

Detailed configuration is in each plugin's reference documentation. Maintainer notes are in [docs/reference.md](docs/reference.md).
