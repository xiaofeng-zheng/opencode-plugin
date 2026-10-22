# 私有 OpenCode 集成测试

入口：`../integration.mjs`。仅使用 Node 内置模块，不需要 `ws`，不安装 npm 包，也不修改用户配置或现有 service。

## 三种证据等级

```sh
# 只验证命令 fixture、真实 HTTP/SSE 与 RFC6455 framing；不依赖编译产物。
node scripts/integration.mjs --self-test

# 真 OpenCode server + 原生 HTTP/WS provider，但使用固定 dummy key。
# 用于独立验证 API/schema/wire fixture，不代表动态插件通过。
node scripts/integration.mjs --runtime-probe --binary /absolute/path/opencode

# 编译及本地依赖已就绪后，执行动态插件完整矩阵。
node scripts/integration.mjs \
  --binary /absolute/path/opencode-old \
  --binary /absolute/path/opencode-new \
  --output .artifacts/integration.json
```

要求 Linux、Node >=22、OpenCode v2 可执行文件；完整模式还要求 `dist/index.js` 及其**已安装的本地依赖**。脚本不会等待其他 worker、运行 build 或联网安装。`--plugin` 可指定另一已安装插件包目录（推荐），也可显式指定编译文件进入仅供调试的 wrapper 模式；`--help` 列出 TTL、deadline、HTTP-only 等参数。

## 真实验收路径

- HTTP：`session.create` → 同一 session 的 `session.generate`，同时断言 `data.text === "DYNAMIC_KEY_OK"` 和 mock 上游实际 Authorization。
- WebSocket：`session.prompt` → `experimental.session.wait` → `session.context`，只接受**新 assistant message**。记录真正的 HTTP Upgrade Authorization、连接 ID、每条客户端 `response.create` frame 和关闭时间。
- `session.generate` 即使 provider 设置 `transport=websocket` 仍走 HTTP；不能用它证明 WS。`generate.text` 不经过 Session hooks，明确不在本矩阵覆盖范围。
- WS provider 的 HTTP `/responses` 请求会被 mock 明确拒绝；不能把 fallback 当作 WS 通过。
- 通过延迟 **101 Upgrade 响应**使 handshake lease 在第一次 send 前过期，断言已经握手但上游 frame 为零；恢复新 key 必须重新连接。

## 覆盖

HTTP 包括懒取、A/A 缓存、TTL 后 B、同 provider 多 session 并发单飞、非零退出/超时/空白输出失败且无上游请求、C 恢复、401 不自动重试并在下一次调用取得 D、新 session 共享新缓存、最后 hook 覆盖 native auth、自定义 header/prefix、JSON `expiresIn` 与 Unix 秒/ISO `expiresAt`、过期 JSON 拒绝和 origin 校验先于 command。

WS 包括懒取、同 key socket reuse、TTL 新 key 重连、refresh 失败无新 frame、恢复、新 session 共享 key cache、handshake/send 之间过期阻断及恢复。两个版本使用各自私有 server；每个版本内验证 PID 不变。结果报告逐 case pass/fail/skip、dummy key、真实 session IDs、command events/counts、Upgrade/frame 数、运行秒数，以及编译 JS 文件 SHA-256 一致性。

## 两版的本地插件加载陷阱

v2.0.32 和 v2.1.2 的 `core/src/config/plugin/source.ts` 会**丢弃配置里直接指向文件的插件路径**（`configured plugin path must be a directory`）。因此不能写 `plugins: [{package: "/.../dist/index.js", ...}]` 后就假定插件已加载。

Harness 默认直接把本项目根目录配置为插件目录，通过包内 `server.js` 加载 `dist/index.js`，不生成替代入口。可用 `--plugin /absolute/path/clean-install/node_modules/opencode-dynamic-api-key` 对实际 tarball 安装执行同一矩阵；报告必须显示 `pluginPackaging.mode: direct-package-directory`。只有显式把 `--plugin` 指向 JS 文件才生成临时 wrapper，这种调试模式不能作为安装验收。

## 隔离与清理

- 启动前检查 `/etc/opencode`，非空、不可读取或不是目录时拒绝；不会读取里面的配置内容。
- server/command 使用最小新建 env，不复制宿主 TOKEN、PROXY、NODE_OPTIONS、OPENCODE_CONFIG 等环境。HOME、测试 HOME、全部 XDG、config、DB、TMPDIR 均隔离。
- 本地空 model catalog、禁止 models fetch/project config/Claude config/file watcher/update；每个 session 明确 fake provider/model，工具权限 deny，禁用 title/compaction 辅助 agent。
- 只执行 `serve --hostname 127.0.0.1 --port 0`；不会使用 `service`、共享端口或发现/停止他人的 PID。
- 所有临时目录由 `$TMPDIR` 下 `mkdtemp` 创建（未设 TMPDIR 时用项目 `.integration`）；只保留显式 `--output` 报告。`--keep-temp` 可保留本次 dummy-only 隔离文件以诊断。
- `finally` 关闭 mock sockets、自己 spawn 的 process group、仍持有本次唯一 state argv 的 fixture PID；SIGINT/SIGTERM 与 deadline 也进入清理路径。
- 这不是 OS 级网络沙箱。配置和实际测试请求均为 loopback；报告明确 `networkSandbox: false`，不声称内核阻止了一切潜在外连。

失败退出非零；`--http-only` 与 `--runtime-probe` 的退出 0 **不等于完整动态插件矩阵通过**。读取 `fullPluginMatrixPassed` 和 `mode`。
