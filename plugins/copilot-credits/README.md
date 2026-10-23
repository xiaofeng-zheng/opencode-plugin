# opencode-copilot-credits

Show GitHub Copilot account quota in OpenCode's home/prompt footer. Use `/copilot` to refresh and view balance, reset time, overage, fetch time, and safe error messages. It does not make model requests.

The recorded runtime verification covers the **OpenCode 2.1.2 standard Bun CLI and full TUI** on Linux, not `mini` or the Node distribution. See the [verification history](docs/verification.md).

## Install for your user

You need **Node.js >=22.15**, **npm**, **Git** for cloning, and an existing **OpenCode v2 standard CLI**. Native Windows/macOS runtimes have not been verified.

Clone the repository if needed:

```sh
git clone https://github.com/xiaofeng-zheng/opencode-plugin.git
cd opencode-plugin
```

Review the checkout, `install.sh`, and its helper/package scripts. Then run as the intended user, **without `sudo`**, from the **repository root**, not this plugin directory:

```sh
./install.sh copilot-credits
```

The installer places the runtime at:

```text
<config-dir>/installed-plugins/copilot-credits/node_modules/opencode-copilot-credits
```

It adds or updates this plugin's server entry in `opencode.json` or `opencode.jsonc`, and its TUI entry in `cli.json`. If neither server configuration exists, it creates `opencode.jsonc`; if both exist, it refuses the ambiguity. Existing unrelated settings, plugins, comments, and separate server/TUI options are preserved. Changed files are backed up before replacement.

`<config-dir>` defaults to `OPENCODE_CONFIG_DIR`, otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. Use `--config-dir DIR` to select another directory, `--opencode PATH` to select an existing executable, or `--help` for usage. See [all installer safeguards](../../README.md#paths-flags-and-safeguards).

### Optional settings

Defaults are a 300-second cache and refresh interval, with a 10-second request timeout. To replace this plugin's options explicitly, put only the options object in a JSON file:

```json
{ "cacheTtlSeconds": 300, "timeoutSeconds": 10, "refreshSeconds": 300 }
```

```sh
./install.sh copilot-credits --options /absolute/path/options.json
```

This replaces the selected plugin's options on both configured sides; it does not merge fields. Omit `--options` to keep the existing per-side options. For accepted ranges and remote-client setup, see the [reference](docs/reference.md).

## Update and load

To update from the current reviewed checkout, rerun:

```sh
./install.sh copilot-credits
```

To obtain remote changes, preserve local work and separately run `git pull --ff-only`, review the changes, then rerun the installer. It neither pulls code nor discards local changes.

Installation works **without a connected account**. To fetch quota later, the server needs OpenCode's native `github-copilot` login for GitHub.com. `gh login` is not a substitute. The plugin does not log in, switch accounts, or require you to copy/export tokens.

The installer does not start/restart OpenCode or query an account. A successful install is not proof that a running server or TUI loaded it. Reopening the **full TUI** and an approved server reload may be needed. With a remote server, package/configuration paths must exist on their respective server and client hosts; a local installation does not update the remote host.

Once loaded, `/copilot` refreshes the account snapshot while respecting GitHub rate-limit backoff. A missing connection is `disconnected`, not a fabricated zero balance. Quota is an internal, best-effort GitHub snapshot, not an authoritative invoice; see [units and limits](docs/reference.md#units-and-quota-semantics).

## Instructions for AI agents

1. Scope this installation to **`copilot-credits`** and the intended user's configuration directory. Check Node.js >=22.15, npm, Git if cloning, and the existing standard OpenCode v2 executable with passive version/help checks; do not install or upgrade OpenCode implicitly.
2. Inspect the trusted checkout, `install.sh`, and its helper/package scripts. Preserve user changes and existing configuration. Pull remote code only when requested, with `git pull --ff-only`, and review it before execution.
3. Run `./install.sh copilot-credits` from the repository root. Add `--config-dir DIR` or `--opencode PATH` if needed. Pass `--options /absolute/path/options.json` only for an explicitly requested options replacement; otherwise preserve separate server/TUI settings.
4. Read the printed paths and inspect this plugin's server/TUI entries and installed package files. Confirm backups and unrelated configuration preservation without displaying secrets or whole configuration files. Stop on ambiguities or symlink refusals instead of bypassing them.
5. Allow disconnected installation. Quota access requires a separate native OpenCode `github-copilot` login, not `gh login`; never ask for/export tokens or read credential stores. Do not make model requests.
6. Distinguish **installed/configured** from **active**. Use passive `opencode service status` first; `opencode plugin list` may start a stopped server, so obtain approval before that happens. Require approval for reopening the TUI or any reload/restart. Report actual paths, checks, backups, and remaining activation/authentication work, not assumed success.

For configuration, quota interpretation, and security boundaries, read the [reference](docs/reference.md). Maintainer-only procedures are in the [integration guide](docs/integration.md).
