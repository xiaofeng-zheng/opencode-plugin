# Dynamic API key

Obtain short-lived keys from a trusted command for OpenCode v2 Session HTTP/WebSocket requests. Failed refreshes block new sends. Sessionless `generate.text` is not supported.

## Install

```sh
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

Requires OpenCode v2 and Git. Installation does not supply credentials; configure valid options before using the plugin.

## Configure

Locate global `opencode.json(c)` with `opencode debug paths`. Replace only this plugin's string entry with an object, preserving other entries:

```json
{
  "package": "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key",
  "options": {
    "providers": {
      "openai": {
        "command": ["/absolute/path/mint", "--plain"],
        "ttlSeconds": 3300,
        "refreshAheadSeconds": 60,
        "allowedOrigins": ["https://api.openai.com"]
      }
    }
  }
}
```

Use your real provider ID, command, TTL, and exact allowed origins. The provider must already exist. The command runs as the **server user** and outputs one key on stdout; never put the key itself in arguments or configuration.

## Update

```sh
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/dynamic-api-key"
```

[Options and safety](https://github.com/xiaofeng-zheng/opencode-plugin/blob/main/plugins/dynamic-api-key/docs/reference.md) · [AI-agent installation checklist](https://github.com/xiaofeng-zheng/opencode-plugin#for-ai-agents)
