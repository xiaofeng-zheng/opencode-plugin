# opencode-dynamic-api-key

Obtain short-lived API keys from a trusted command for **OpenCode v2 Session HTTP and WebSocket requests**. Keys stay in memory; expired or failed refreshes block new sends. Once loaded, key rotation does not rewrite configuration or require a service restart.

This is Session-scoped, not a process-wide credential service. Sessionless `generate.text` is **not supported**. Historical private-server verification covered OpenCode **2.0.32** and **2.1.2** on Linux; see the [verification history](docs/verification.md).

## Install for your user

You need **Node.js >=22.15**, **npm**, **Git** for cloning, an existing **OpenCode v2 standard CLI**, and a trusted credential command usable by the OpenCode **server** account. Native Windows/macOS runtimes have not been verified.

```sh
git clone https://github.com/xiaofeng-zheng/opencode-plugin.git
cd opencode-plugin
```

Review the checkout, `install.sh`, and its helper/package scripts before running them. Run as the intended user, **without `sudo`**. All installer commands below run from the **repository root**, not this plugin directory.

### Prepare options

Create `/absolute/path/options.json` containing **only the plugin options**. This example is for an already configured `openai` provider; replace its command, provider ID, TTL, and allowed origins with the user's real values:

```json
{
  "providers": {
    "openai": {
      "command": ["/absolute/path/mint", "--plain"],
      "ttlSeconds": 3300,
      "refreshAheadSeconds": 60,
      "timeoutSeconds": 15,
      "allowedOrigins": ["https://api.openai.com"]
    }
  }
}
```

The file is not a full OpenCode configuration: do not wrap it in `plugins` or `options`, or put provider settings in it. The installer does not create provider definitions. The ID must match the intended OpenCode provider. For a custom provider or an existing OpenAI OAuth connection, read [provider setup](docs/reference.md#provider-configuration) before installation; replacing a header does not change OAuth routing.

The default command output is one nonempty, header-compatible key on stdout, optionally followed by one newline. Prefer an argv array and absolute executable paths. Never put a key itself in argv or the options file. Allowed origins must be exact canonical HTTP(S) origins, without a trailing slash, path, or wildcard; do not broaden them to bypass an error. See the [command and options reference](docs/reference.md#command-and-output) for JSON expiry, environment, and other settings.

### Run the installer

```sh
./install.sh dynamic-api-key --options /absolute/path/options.json
```

The runtime is installed at:

```text
<config-dir>/installed-plugins/dynamic-api-key/node_modules/opencode-dynamic-api-key
```

The installer updates only this plugin's entry in the existing `opencode.json` or `opencode.jsonc`, creating `opencode.jsonc` if neither exists. It refuses simultaneous server configuration files rather than discarding a layer. Unrelated settings, plugins, and comments are preserved; changed files are backed up before replacement. The runtime is outside the autodiscovery `plugins/` directory.

`<config-dir>` defaults to `OPENCODE_CONFIG_DIR`, otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. Use `--config-dir DIR`, `--opencode PATH`, or `--help` as needed. See [all installer safeguards](../../README.md#paths-flags-and-safeguards).

## Update and load

Update from the current reviewed checkout while preserving existing options:

```sh
./install.sh dynamic-api-key
```

Remote code updates are separate: preserve local changes, explicitly run `git pull --ff-only` if wanted, review the result, then rerun the installer. The installer neither pulls code nor discards a dirty checkout. Pass `--options /absolute/path/options.json` only to **replace** this plugin's options; fields are not merged.

The installer never executes the credential command, reads auth tokens, makes model requests, installs/upgrades OpenCode, or starts/restarts services. **Installed/configured is not active.** Initial loading and later options changes depend on OpenCode; request approval for any reload/restart and reopen the TUI only when appropriate. The no-restart guarantee concerns subsequent key rotation in an already loaded plugin, not initial installation or configuration changes.

The command runs with the server's permissions and environment, not automatically in the client's terminal. Treat it as trusted executable code. Requests outside the supported Session hooks and effects of other plugins remain outside this plugin's guarantees; read the [safety boundaries](docs/reference.md#server-environment-and-safety).

## Instructions for AI agents

1. Scope the task to **`dynamic-api-key`**, the intended user's configuration directory, and the existing OpenCode executable. Check Node.js >=22.15, npm, Git if cloning, and the standard OpenCode v2 CLI using passive version/help checks. Do not upgrade OpenCode implicitly.
2. Review the trusted checkout, `install.sh`, and its helper/package scripts. Preserve local changes, existing plugins/providers, and configuration comments. Pull remote code only when requested, with `git pull --ff-only`, and review it before execution.
3. On a first install, obtain the real **provider ID, trusted credential command, exact allowed origins, and TTL** if missing. Confirm the provider exists and the server account can use the command. Consult the [reference](docs/reference.md) for command format, environment, expiry, transport, or OAuth questions. Do not invent keys, treat demo values as production settings, widen origins, or execute the credential command just to check installation.
4. Prepare an options-only JSON object and run `./install.sh dynamic-api-key --options /absolute/path/options.json` from the repository root. Use `--config-dir DIR` and `--opencode PATH` when needed. On updates, run `./install.sh dynamic-api-key` without `--options` unless replacement was requested.
5. Read the printed installation/configuration/backup paths and inspect only the matching plugin entry and installed package files. Verify unrelated settings were preserved without dumping secrets, complete configurations, or command output. Stop on ambiguity or symlink refusals instead of overwriting user files.
6. Report **installed/configured** separately from **active**. Check service state passively with `opencode service status`; use `opencode plugin list` only against the intended running server, or after approval to start one. Require approval for reopening the TUI or any reload/restart. Never ask for/export tokens or make a model request as an installation check. Report actual results and anything still unverified.

For complete configuration and safety details, see the [reference](docs/reference.md). Maintainer-only procedures are in the [integration guide](docs/integration.md).
