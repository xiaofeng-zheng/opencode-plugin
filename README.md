# opencode-plugin

OpenCode v2 插件集合。每个插件在 `plugins/<name>/` 下独立维护自己的版本、依赖、文档和测试；仓库根目录不是一个插件包。

## 插件

- **[dynamic-api-key](plugins/dynamic-api-key/)** — 在请求前运行自定义 command 获取 API key，支持 TTL、提前刷新、JSON expiry、HTTP/WebSocket、并发单飞与失败阻断。npm 包名：`opencode-dynamic-api-key`。
- **[copilot-credits](plugins/copilot-credits/)** — 在 OpenCode 2.1.2 完整 TUI 的底栏显示 Copilot 账户额度，`/copilot` 查看余额、重置时间及额外使用。npm 包名：`opencode-copilot-credits`；不发起模型请求。

## 安装 dynamic-api-key

```sh
git clone https://github.com/xiaofeng-zheng/opencode-plugin.git
cd opencode-plugin/plugins/dynamic-api-key
npm ci
npm run build
```

将下面内容合并到 OpenCode v2 的 `opencode.json(c)`。把目录和命令换成你的实际路径：

```json
{
  "plugins": [{
    "package": "/absolute/path/opencode-plugin/plugins/dynamic-api-key",
    "options": {
      "providers": {
        "openai": {
          "command": ["/absolute/path/mint-key"],
          "ttlSeconds": 3300,
          "refreshAheadSeconds": 60,
          "allowedOrigins": ["https://api.openai.com"]
        }
      }
    }
  }]
}
```

`package` 指向**插件目录**，不能指向 `server.js` 或 `dist/index.js`。命令默认从 stdout 输出单行 key；key 只保存在内存中，后续轮换无需重启 service。首次加载配置由 OpenCode 管理。

完整参数、安全边界、已有 OAuth 账户与自定义 provider 的使用说明，见 [插件 README](plugins/dynamic-api-key/README.md)。无 Session 的 `generate.text` 不经过这些钩子，不在支持范围内。

## 安装 copilot-credits

```sh
cd opencode-plugin/plugins/copilot-credits
npm ci
npm run build
npm run pack:check
```

生成 `.artifacts/opencode-copilot-credits-0.1.0.tgz`。该插件会预编译 TUI JSX；请分发构建后的包，**不要直接在源码根目录执行 `npm pack`**。将包安装到你选择的目录，再按 [插件 README](plugins/copilot-credits/README.md) 配置服务端与客户端入口。服务端须已有 OpenCode 原生 Copilot 登录；本插件不使用或替代 `gh` 的登录凭证。

## 开发与验证

在目标插件目录中执行，而不是仓库根目录：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

打包方式由各插件决定：`dynamic-api-key` 使用 `npm pack`；`copilot-credits` 使用 `npm run pack:check`，从预编译的 `.artifacts/package/` 打包并验证干净安装。

动态 key 插件还提供真实私有 OpenCode + loopback HTTP/WebSocket 测试：

```sh
node scripts/integration.mjs --self-test
node scripts/integration.mjs   --binary /absolute/path/opencode   --output .artifacts/integration.json
```

集成 harness 要求 Linux、Node >=22、已安装依赖，以及不含宿主配置的 `/etc/opencode`。它只启动自己的隔离测试进程，不重启共享 service。测试边界与已完成验收见 [verification](plugins/dynamic-api-key/docs/verification.md)。

## 新增插件

```text
plugins/
├── dynamic-api-key/
│   ├── package.json
│   ├── package-lock.json
│   ├── server.js
│   ├── src/
│   ├── dist/
│   ├── tests/
│   ├── examples/
│   └── README.md
├── copilot-credits/
│   ├── package.json
│   ├── package-lock.json
│   ├── index.ts / server.ts / tui.tsx / rpc.ts
│   ├── src/
│   ├── tests/
│   ├── scripts/
│   └── README.md
└── <next-plugin>/
    └── ...
```

每个插件使用独立 npm 包名与版本，提供自己的 README、配置示例、构建和测试命令，并在上方目录中登记。依赖与锁文件保留在各自目录，不强制共用 SDK 版本。`dynamic-api-key` 保留经验证的 `dist/` 和 `server.js`；`copilot-credits` 的构建包位于忽略的 `.artifacts/package/`，按其脚本重新生成。不要混用入口或打包方式。许可证以各插件的 `LICENSE` / `package.json` 为准。

不提交 API key、`.env`、node_modules、测试 DB、临时授权信息或本地运行日志。GitHub Actions 和 npm 自动发布尚未配置；本仓库不会自动安装插件到你的 service。
