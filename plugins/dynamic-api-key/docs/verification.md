# dynamic-api-key 验证说明

## 已验证范围

- OpenCode server **2.0.32** 与 **2.1.2**：各 25 项真实 HTTP/WebSocket 集成用例通过。
- Node **22.22.3**：87 项单元测试通过。
- Node **20.20.2**：86 项通过、1 项明确跳过（上游 Host 测试工具依赖 Node >=22.15 的 `registerHooks`，插件运行时不导入该工具）。
- TypeScript strict typecheck、构建、npm pack、全新 tarball 安装与真实 server 目录加载通过。
- npm 包含实际 `server.js` 入口；安装包逐字节校验，测试没有使用替代 wrapper 冒充安装成功。

## 关键场景

HTTP：同一个 Session 中 A/A 命中缓存，TTL 后换 B，server PID 不变；并发刷新只启动一个 command；非零退出、超时、空输出阻断请求且 upstream 计数不增加；恢复、401 按 generation 失效、原生静态 key 覆盖、自定义 header、JSON expiry 与 origin 限制。

WebSocket：真实 Upgrade 和 outbound frames；相同 key 复用、新 key 重连；失败刷新不发送 frame；通过延迟 Upgrade 使 lease 在 handshake/send 之间过期，验证零 frame 阻断及恢复。不以 HTTP fallback 当成 WS 通过。

独立核心安全复核未发现 Critical / Important 问题。保留的可用性边界：握手成功后、发送前连接取消或失败，下一次握手可能保守拒绝一次，再次调用可恢复；此行为有回归测试，不会放行旧 key。

## 复跑

```sh
npm ci
npm run typecheck
npm test
npm run build
node scripts/integration.mjs --self-test
node scripts/integration.mjs   --binary /absolute/path/opencode-2.0.32   --binary /absolute/path/opencode-2.1.2   --output .artifacts/integration.json
```

使用实际安装包测试时，把 `--plugin` 指向安装后的包目录。报告应显示 `pluginPackaging.mode: direct-package-directory`，并确认 `fullPluginMatrixPassed: true`。`--http-only`、`--runtime-probe` 或 JS-file debug wrapper 不等于完整包验收。

本仓库不提交含本机路径、进程 ID 的运行日志；harness 会生成可复核报告。原插件导入多插件目录时保持运行时代码不变，并重跑目录相关测试。

## 未承诺范围

- 无 Session 的 `generate.text`、任意第三方 SDK/插件组合。
- 所有 title/compaction/retry 排列的逐一集成覆盖。
- 真实厂商签发服务、Windows/macOS。
- OS 级网络沙箱、JS 字符串物理归零或 TTL 到期强制中断进行中的 stream。

更多安全、权限与环境说明见 [README](../README.md)。
