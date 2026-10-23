# Copilot credits

Show Copilot account quota in OpenCode's full TUI footer. `/copilot` refreshes the balance and reset details without a model request.

## Install

```sh
opencode plugin add "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
```

Requires OpenCode v2 and Git. Quota access uses OpenCode's native `github-copilot` connection for GitHub.com, not `gh login`. Installation can succeed while disconnected; `mini` is not supported.

## Update

```sh
opencode plugin update "github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits"
```

Defaults: 300-second refresh/cache and 10-second request timeout. See [configuration and limits](https://github.com/xiaofeng-zheng/opencode-plugin/blob/main/plugins/copilot-credits/docs/reference.md) for options and remote-client setup. Quota is a best-effort snapshot, not an invoice.

AI agents: follow the [installation checklist](https://github.com/xiaofeng-zheng/opencode-plugin#for-ai-agents).
