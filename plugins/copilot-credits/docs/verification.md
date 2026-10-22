# 验证说明

本插件从独立项目引入 `plugins/copilot-credits/`，运行时代码和测试保持不变；仅补充仓库元数据、路径说明及插件索引。原目录保留，node_modules、测试沙盒、数据库和本机运行日志不提交。

## 本次导入后的实际检查

- Node.js 22.22.3：`npm ci`、`npm run typecheck`、`npm test` 成功，**35 tests / 35 pass / 0 fail**。
- `npm run build` 使用 Solid universal / OpenTUI preset 预编译 TUI JSX。
- `npm run pack:check` 成功：从 `.artifacts/package/` 打包，在干净 consumer 安装，并用官方 Host 验证 local-directory 与 npm 的 server / TUI / RPC 入口。
- 运行包 **17 个文件**与构建清单和实际安装内容逐字节一致，包含预编译的 `src/tui.js`，不包含原始 `src/tui.tsx`。

## 标准 OpenCode 2.1.2 Bun CLI

使用安装后的真实 tarball，启动独立 HOME/XDG/DB、独立密码和显式私有 endpoint 的测试进程。

1. **未连接账户**：实际 RPC 返回 disconnected，而不是伪造零额度；首页 footer 与 `/copilot` 详情可见。
2. **合成配额 fixture**：会话 prompt footer、`/copilot` 详情、配额计算和零重置时间的日期回退正确。
3. 未带测试认证的 RPC 请求返回 HTTP 401。
4. 两个场景均没有尝试或转发模型请求；TUI 和私有 server 均以 exit 0 结束。

测试没有查询真实 Copilot 账户，没有修改或重启现有共享 service。合成数据不是用户实际余额。

## 复跑

在本插件目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
python3 scripts/host-probe.py --binary /absolute/path/opencode --tui
python3 scripts/host-probe.py --binary /absolute/path/opencode --tui --session --synthetic-fixture
```

`--binary` 使用标准 2.1.2 CLI。不要直接在源码根运行 `npm pack`；发布包需要预编译的 JSX。源代码与 minimal runtime 包用途不同，详见 [README](../README.md)。

运行日志与 JSON 报告写入忽略的 `.artifacts/`；测试沙盒位于忽略的 `.test-sandbox/`。不承诺 Node 版 OpenCode、mini、2.0.32 共享 server 跨版本加载、Enterprise 或真实账户额度查询的普遍兼容性。
