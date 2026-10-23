# opencode-dynamic-api-key

Obtain short-lived API keys from a trusted command for **OpenCode v2 Session HTTP and WebSocket requests**. Keys stay in memory; failed or expired refreshes block new sends. Once loaded, key rotation does not rewrite configuration or require a service restart. Sessionless `generate.text` is not supported.

## Install

With the OpenCode v2 standard CLI and Git installed:

```sh
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

The same syntax works in Bash, PowerShell, and Command Prompt. OpenCode downloads the precompiled package and registers it in global configuration. No npm publication, manual build, or GitHub workflow is required.

**Configure the plugin before using it.** `plugin add` installs the package but does not supply credential options. Setup fails closed until valid options are present.

## Configure

Find the user configuration directory with `opencode debug paths`. In its `opencode.json(c)`, replace only this plugin's matching string entry with the following object. Preserve all other plugins and provider settings:

```json
{
  "package": "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key",
  "options": {
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
}
```

Replace the provider ID, command, TTL, and origins with real values. On Windows, use native executable paths in the command array. The provider must already be configured in OpenCode; plugin options do not create it.

The command runs as the **OpenCode server** user, not automatically in the client's terminal. Prefer an argv array and absolute paths. Default stdout is one nonempty, header-compatible key, optionally followed by one newline. Never place the key itself in argv or configuration. Allowed origins are exact canonical HTTP(S) origins without a trailing slash, path, or wildcard; do not broaden them to bypass an error.

For custom providers, JSON expiry, environment settings, or existing OpenAI OAuth connections, consult the [configuration and safety reference](https://github.com/xiaofeng-zheng/opencode-plugin/blob/main/plugins/dynamic-api-key/docs/reference.md). Replacing an authorization header does not change OAuth routing.

## Update

```sh
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

Installation is separate from activation. Confirm valid options and successful loading before model use. `opencode plugin list` may start a stopped server; obtain approval for server/TUI starts or reloads. The no-restart guarantee concerns later key rotation in an already loaded plugin, not initial setup.

## Instructions for AI agents

1. Resolve the intended OpenCode executable and user configuration; check OpenCode v2/Git with passive version/help/path commands.
2. Review/back up relevant configuration and run the exact native install command above. Preserve unrelated entries and any existing options.
3. Obtain missing real provider ID, trusted command, TTL, and exact allowed origins. Merge the options into only this plugin's entry; do not invent credentials, treat example values as production values, or widen origins.
4. Inspect the installed entry and actual command result without dumping secrets. Do not execute the credential command or make a model request as an installation check.
5. Report installed/configured separately from active. Ask before starting/reloading/restarting a server or TUI; do not silently remove an older local installation.

[Verification history](https://github.com/xiaofeng-zheng/opencode-plugin/blob/main/plugins/dynamic-api-key/docs/verification.md)
