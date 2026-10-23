# OpenCode plugins

User-level plugins for OpenCode v2:

| Plugin | Purpose |
| --- | --- |
| [copilot-credits](plugins/copilot-credits/README.md) | Show GitHub Copilot account quota in the full TUI footer and `/copilot` dialog, without model requests. Package: `opencode-copilot-credits`. |
| [dynamic-api-key](plugins/dynamic-api-key/README.md) | Obtain short-lived API keys from a trusted command for Session HTTP/WebSocket requests. Package: `opencode-dynamic-api-key`. |

## Install

Requirements: **Node.js >=22.15**, **npm**, **Git** for cloning, and an existing **OpenCode v2 standard CLI**. The documented environment is Linux; native Windows/macOS runtime compatibility has not been verified. Copilot's full-TUI verification was on the standard Bun CLI **2.1.2**; see each plugin's verification history for its tested scope.

```sh
git clone https://github.com/xiaofeng-zheng/opencode-plugin.git
cd opencode-plugin
```

Review the checkout, `install.sh`, and the scripts it invokes before running it. Run as the intended user, **without `sudo`**. From the repository root, choose the plugin you want:

```sh
./install.sh copilot-credits
```

Or, after preparing [dynamic-api-key options](plugins/dynamic-api-key/README.md#prepare-options):

```sh
./install.sh dynamic-api-key --options /absolute/path/options.json
```

The options file must be a JSON object containing **only that plugin's options**, not a complete OpenCode configuration. A first-time dynamic-key installation needs the real provider ID, credential command, allowed origins, and TTL. Copilot can be installed while disconnected; quota access later requires OpenCode's native `github-copilot` login, not `gh login`. No token export is needed.

## Update

Rerun the command for the selected plugin to install the code in the **current checkout**. Omit `--options` to preserve existing options, including separate Copilot server/TUI options:

```sh
./install.sh copilot-credits
./install.sh dynamic-api-key
```

These are independent commands; run only the one you need. Remote updates are a separate, explicit action. Preserve local changes, then, if you want the remote revision:

```sh
git status --short
git pull --ff-only
```

Review the changed code before rerunning the installer. The installer does not pull remote code or discard a dirty checkout. Passing `--options FILE` explicitly **replaces only the selected plugin's options**; it does not merge individual option fields.

## Paths, flags, and safeguards

The default configuration directory is `OPENCODE_CONFIG_DIR` when set, otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. Select the directory used by the intended OpenCode setup: `--config-dir` only changes the install destination, not a running server/client's environment or configuration discovery.

| Flag | Meaning |
| --- | --- |
| `--config-dir DIR` | Select a different user configuration directory. |
| `--options FILE` | Replace the selected plugin's options with this JSON object. Omit on updates to retain existing options. |
| `--opencode PATH` | Select the existing OpenCode v2 executable. |
| `--help` | Show installer usage. |

The installer builds and packages the current checkout, installs production dependencies, and manages the runtime at:

```text
<config-dir>/installed-plugins/<slug>/node_modules/<npm-name>
```

This is outside the autodiscovery `plugins/` directory. The installer updates only the matching `plugins` entry in the existing `opencode.json` **or** `opencode.jsonc`; it creates `opencode.jsonc` when neither exists. Copilot also gets a TUI entry in `cli.json`. Unrelated settings, plugins, comments, and existing per-side options are preserved, and changed files are backed up before replacement.

Simultaneous `opencode.json` and `opencode.jsonc`, ambiguous plugin entries, linked configuration files, or symlinked managed targets can cause a refusal. Backups retain the actual displaced file inside a private `.bak-*` directory. Resolve the reported ambiguity deliberately rather than deleting configuration or user changes to force installation.

The installer never runs credential commands, reads auth tokens, installs/upgrades OpenCode, makes model requests, or starts/restarts services. **Installed and configured does not mean active.** OpenCode still needs to load the plugin; reopening the full TUI or an approved reload may be necessary. Installation is not permission to restart a shared server.

## Instructions for AI agents

Use this workflow when a user asks you to install or update a plugin:

1. **Confirm scope.** Ask which plugin only if it is unknown. Resolve the intended user configuration directory and existing OpenCode executable. Check Node.js >=22.15, npm, Git when cloning, and the standard OpenCode v2 CLI using passive version/help checks. A client version does not prove the running server's version.
2. **Review trusted code.** Inspect the checkout, `install.sh`, and its helper/package scripts before execution. Preserve local changes and existing configuration. Fetch remote updates only when requested, using `git pull --ff-only`; review the result before installation. Do not reset or clean the user's checkout.
3. **Collect only necessary options.** For a new `dynamic-api-key` installation, obtain the real provider ID, trusted command, exact allowed origins, and TTL if missing. Confirm that the provider is configured in OpenCode; the installer does not create provider definitions. Use the [options and safety reference](plugins/dynamic-api-key/docs/reference.md) for format, environment, or OAuth questions. Never invent credentials or widen origins to bypass an error. For Copilot, disconnected installation is valid; native OpenCode Copilot login is separate from `gh login`. Never ask for or export tokens.
4. **Install explicitly.** From the reviewed repository root run `./install.sh copilot-credits`, or `./install.sh dynamic-api-key --options /absolute/path/options.json` for a first install. Use `--config-dir DIR` and `--opencode PATH` when needed. On updates omit `--options` unless the user requested replacement; preserve distinct server/TUI options.
5. **Read back the result.** Inspect the printed installation/configuration/backup paths, the matching configuration entries, and the installed package files. Verify only the intended plugin changed, without dumping complete configurations, option values that may contain secrets, or credentials. Do not execute the credential command as an installation check.
6. **Separate activation.** Report installed/configured status separately from active status. `opencode service status` can check service state without starting one. Use `opencode plugin list` only against the intended running server, or after explicit approval to start a stopped server. Obtain approval before reopening the TUI or reloading/restarting a service; do not make a model request to verify installation.
7. **Report actual evidence.** Give the selected plugin, paths changed, backups, checks that really ran, and any unresolved load/authentication issue. Do not claim activation, account access, or runtime compatibility from installer success alone.

## Further documentation

- Copilot: [options and quota semantics](plugins/copilot-credits/docs/reference.md), [verification history](plugins/copilot-credits/docs/verification.md).
- Dynamic keys: [configuration and safety](plugins/dynamic-api-key/docs/reference.md), [verification history](plugins/dynamic-api-key/docs/verification.md).
- Repository maintainers: [package and verification reference](docs/reference.md).
