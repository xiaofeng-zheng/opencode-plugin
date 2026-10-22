# opencode-dynamic-api-key

OpenCode **v2 Session** 动态 API key 插件，ESM / Node.js ≥ 20。默认导出 `Plugin.define({ id: 'dynamic-api-key', setup })`，运行依赖精确锁定 `@opencode/plugin@2.0.32`。

插件已加载后，每个 provider 首次请求按需执行凭证 command，把短期 key 缓存在内存。在 HTTP 发出前、WS 握手前检查有效期并覆盖鉴权头；**轮换 key 不写配置、不调用 `provider.reload()`、不需要重启 service**。这里不是定时修改 `providers.openai.settings.apiKey`，也不是能覆盖整个进程的凭证服务。

## 构建与本地安装

在本项目目录运行（不是全局安装，也不修改 OpenCode service）：

```sh
npm install
npm run typecheck
npm test
npm run build
mkdir -p .artifacts
npm pack --pack-destination .artifacts
```

生成 `dist/index.js` 及类型声明、`.artifacts/opencode-dynamic-api-key-0.1.0.tgz`。有 lockfile 时也可用 `npm ci`。发行包白名单只有 `server.js`、`dist/`、`README.md`、`examples/` 和必要 npm metadata；源码、测试、集成脚本、测试日志、凭证不打入 npm 包。

可在**你明确选定的本地项目**安装 tarball：

```sh
npm install /absolute/path/opencode-dynamic-api-key-0.1.0.tgz
```

然后将下面配置中的 `package` 指向**插件包目录**，例如 `file:///absolute/path/app/node_modules/opencode-dynamic-api-key`，或直接指向本项目根目录 `file:///absolute/path/opencode-plugin/plugins/dynamic-api-key`。不要求发布到 npm。**不要指向 `dist/index.js` 或 `server.js` 文件**：实测 v2.0.32 / v2.1.2 会忽略显式配置的文件路径。包内的 `server.js` 是目录发现入口，仅 re-export 已编译的真实插件；npm 安装的包也包含它。以下示例需要自行替换绝对路径；**本项目不会自动安装插件、修改用户配置、停止或重启任何 service**。首次接入仍需要 OpenCode 正常加载插件；“不用重启”仅指已加载插件的后续 key 轮换，不是零配置热插拔。修改 options（如 TTL、command）也不是本插件提供的动态配置功能。

## 直接合并到 OpenCode v2 配置

v2 的 `plugins` 是数组，元素可以是含 `package` 和 `options` 的**对象**，不是 v1 的 tuple，也不是把整个 options 写成 provider settings。合并时保留你原有 plugins / providers，不要覆盖它们。

### 已有 `providers.openai`：显式 HTTP

```json
{
  "plugins": [
    {
      "package": "file:///absolute/path/opencode-plugin/plugins/dynamic-api-key",
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
  ],
  "providers": {
    "openai": {
      "settings": { "transport": "http" }
    }
  }
}
```

完整文件：[examples/openai-http.json](examples/openai-http.json)。无需向 settings 放真实 key 或假占位 key。同步 provider transform 只把**已经存在**且 activation 为 `auto` 的目标 provider 标记 `enabled`；不创建 provider、不覆盖 `disabled`，不修改 settings / models。后续 OpenCode 配置及 policy 仍有决定权。对于 native API-key provider，已配置/启用且没有凭证、没有 configured apiKey 时，OpenCode 的 `Auth.none` 允许请求先构造，再由本插件加头。

### OpenAI WebSocket

v2.0.32 与 v2.1.2 的内置 OpenAI 默认都可能使用 WebSocket，不能只装 HTTP hook 后宣称全部请求受保护。本插件也注册 `experimental.ws.handshake` / `experimental.ws.send`。将上例设置改成：

```json
{ "providers": { "openai": { "settings": { "transport": "websocket" } } } }
```

完整文件：[examples/openai-websocket.json](examples/openai-websocket.json)。`allowedOrigins` **仍写 HTTP(S) origin**：`wss://api.openai.com/...` 按 `https://api.openai.com` 匹配，`ws://host:port/...` 按 `http://host:port` 匹配。只对支持该 WS 协议的 provider 启用它；Chat Completions compatible provider 应使用 HTTP。

**已有 OpenAI OAuth 连接仍决定 protocol / endpoint。** 本插件仅替换配置指定的鉴权头，不把 OAuth 连接改造成 API-key 连接。如果最终 endpoint 不是 allowlist 中的 origin，会在执行 command 前拒绝。推荐下面的独立 compatible provider 别名，避免与内置 `openai` / 已保存 OAuth 连接混用，不要为绕过报错盲目扩大 allowlist。

### 新 custom provider：native Chat Completions

```json
{
  "plugins": [
    {
      "package": "file:///absolute/path/opencode-plugin/plugins/dynamic-api-key",
      "options": {
        "providers": {
          "rotating-compatible": {
            "command": ["/absolute/path/to/node", "/absolute/path/opencode-plugin/plugins/dynamic-api-key/examples/mint-demo.mjs", "--json"],
            "ttlSeconds": 240,
            "refreshAheadSeconds": 20,
            "timeoutSeconds": 5,
            "format": "json",
            "allowedOrigins": ["http://127.0.0.1:8787"]
          }
        }
      }
    }
  ],
  "providers": {
    "rotating-compatible": {
      "name": "Dynamic key local probe (example only)",
      "package": "@opencode/ai/providers/openai/chat",
      "env": [],
      "settings": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "transport": "http"
      },
      "models": {
        "probe": {
          "name": "Local probe (not a real model)",
          "limit": { "context": 8192, "output": 1024 },
          "capabilities": { "input": ["text"], "output": ["text"], "tools": false }
        }
      }
    }
  }
}
```

完整文件：[examples/custom-provider.json](examples/custom-provider.json)。`probe`、端口和 demo key 都只是本地测试占位；**这个例子不启动假 upstream、不请求真实模型**。正式使用时自行选择独立 provider ID、可信 `baseURL`、真实存在的模型定义及凭证程序。两个 `providers` 中的 ID 必须一致；插件 options 不是 provider 的定义替代品。

## command 与输出约定

### 推荐：argv 数组，不开 shell

```json
{
  "command": ["/absolute/path/to/node", "/absolute/path/mint-key.mjs", "--plain"],
  "ttlSeconds": 3300,
  "allowedOrigins": ["https://api.openai.com"]
}
```

首项是可执行程序，其余项原样传递，不展开 `$VAR`、`~`、管道或重定向。推荐绝对路径，**不要把 key 本身写到 argv**。`cwd` 是可选工作目录，相对路径基于 `ctx.location.directory`，省略也使用该 location。

### 显式 shell 字符串

```json
{
  "command": "exec /absolute/path/mint-key --plain",
  "ttlSeconds": 3300,
  "allowedOrigins": ["https://api.openai.com"]
}
```

字符串明确选择平台 shell（POSIX 通常 `/bin/sh`，Windows 使用 Node 的默认 shell / `ComSpec`）；不是交互式登录 shell，不保证加载 `.bashrc`。shell 的引号/变量扩展由你负责。不要拼入来自消息、模型输出或不可信项目的参数。

### text（默认）

stdout 必须是**一个非空、无空白或控制字符的 header-compatible key**。可无结尾换行，或只有一个 LF / CRLF；不 `trim()` key，也不接受前后空格、多个空行、调试输出、ANSI 控制序列。Web Headers 使用 ByteString，因此不能表示的 Unicode 字符也会被安全拒绝。

### json

配置 `"format": "json"`；stdout 是一个 JSON 对象，可选 expiry 二选一：

```json
{ "apiKey": "EXAMPLE_ONLY_NOT_A_REAL_KEY", "expiresIn": 300 }
```

或：

```json
{ "apiKey": "EXAMPLE_ONLY_NOT_A_REAL_KEY", "expiresAt": "2030-01-01T00:00:00Z" }
```

`expiresAt` 也可为有限的 UNIX **秒**数（不是毫秒）；ISO 日期需要完整时间和时区。`expiresIn` 是有限正秒数，支持小数。两者都省略则只使用 TTL，不能同时提供，未知 JSON 字段会被拒绝。key 本身遵守与 text 相同的规则，不允许内部换行。

到期时刻为 `min(command 开始时间 + ttlSeconds, 输出指定的 expiry)`；`expiresIn` 也从 command **开始**算。慢 command、终止清理耗时计入 TTL。返回时已经过期或进入 refresh-ahead 窗口的结果会直接拒绝，不缓存、不放行请求。示例 expiry 不代表真实凭证有效期，程序必须报告可信有效期。

安全演示（只输出固定的虚构字符串，不访问网络）：

```sh
node examples/mint-demo.mjs --plain
node examples/mint-demo.mjs --json
```

## 完整 options

顶层只允许 `providers`（必填非空 record）。每个 provider 独立设置：

| 字段 | 必填 / 默认 | 校验与含义 |
| --- | --- | --- |
| `command` | 必填 | 非空 argv 字符串数组或非空 shell 字符串；无 NUL；数组首项不可为空 |
| `ttlSeconds` | 必填 | 有限正数，支持小数；毫秒换算也必须有限 |
| `refreshAheadSeconds` | `0` | 有限数，`0 <= ahead < ttl` |
| `timeoutSeconds` | `15` | command 的有限正超时秒数；支持小数 |
| `allowedOrigins` | 必填 | 非空 HTTP(S) **canonical origin** 数组，精确匹配；无 userinfo、path、query、hash |
| `cwd` | location directory | 可选非空目录；相对 `ctx.location.directory` 解析 |
| `env` | `{}` | string record，叠加 OpenCode **server 进程**的环境；不是客户端终端环境 |
| `header` | `Authorization` | 合法 HTTP token 名称；不区分大小写覆盖 |
| `prefix` | `Bearer ` | 可为空，不得包含控制字符；最终值需是合法 Web Header |
| `format` | `text` | 只允许 `text` / `json` |

例如其它服务用 `"header": "x-api-key", "prefix": ""`。只覆盖这一种头；如果已有 `Authorization`，它会保持不变。

canonical origin 的示例是 `https://api.openai.com`、`http://127.0.0.1:8787`。结尾 `/`、大写主机、默认端口 `:443`、通配符、路径或账号密码都不接受，需写 URL 的规范 `origin`。请求本身可以含正常 API 路径和 query；会先按 origin 检查，之后才执行凭证命令。生产建议只用 HTTPS，HTTP 是显式信任明文网络（例子仅 loopback）。

未知配置字段、错误类型、无效范围在 setup 时拒绝，错误只报固定 schema 字段路径（如 `providers.*.ttlSeconds`），不反射 provider ID、command、env 或输入值。

## TTL、并发与失败语义

- **按需而非定时刷新**：启动不执行 command；没有预刷新 timer。`now >= expiresAt - refreshAheadSeconds` 即不可用于新发送，下一次请求执行 command。没有请求时不会定时生成 key，过期也不会主动打 upstream。
- 同一个 location/plugin 实例内，同 provider 的同时刷新共享一个 Promise；不同 provider 相互隔离。多个 location/实例不是跨进程全局缓存。
- 刷新开始就丢弃旧 lease；command 失败、超时、输出非法或过期都会阻断当前请求，即使旧 key 尚未到真正 expiry 也**不回退**。后续请求可重新执行 command 恢复，无永久熔断或隐藏重试。
- HTTP 每次实际 Session HTTP hook 发送都 `ensureFresh`，包括 OpenCode 自己进行的物理重试，不只是在最初模型解析时改 key。
- HTTP 401 只使该请求记录的 generation/key 失效；迟到的旧请求 401 不会清除已经轮换的新 generation。插件不重放 HTTP、不改变响应、不自动重试，以免重复有副作用的请求；OpenCode 自己的 retry policy 是另一层。
- WS handshake 每次 model call 运行，去掉所有大小写变体的配置头并写入当前 key。相同头允许原生 transport 复用 socket，不同头改变 affinity 并重连。
- WS send **只验证、不刷新**。握手后 lease 过期、进入 ahead、被 401 失效或被轮换，即使新 generation 恰好同 key，也拒绝旧握手发送；下一次 model call 需重新 handshake。不能把内存中的新 key 当作旧 socket 已认证。
- WS 状态按 provider/session/kind 保守保存，最多 1024 个 LRU 条目；被逐出的旧会话 send 会拒绝。原生 Session 会串行化 socket exchange；没有 exchange/socket ID 的 hook 下，检测到重叠的握手（或上一握手未曾 send）会保守拒绝并清状态，后续新 call 可恢复。连接失败尚未 send 时，这可能额外拒绝下一次 call，而不是借用不明身份。
- 已经在进行的 stream **不会因为 TTL 到期被强制中断**。检查是发送前的关卡，不承诺之后 JS 调度、body 转换、socket 排队中的每个物理字节都精确卡在到期毫秒前；请留合适 ahead。
- cleanup 先关闭发送关卡，再中止正在生成的 child、移除注册、清除内部 key/WS/request 引用。晚到的 command completion 不会重新激活插件。

## server 环境与安全边界

command 运行在 **OpenCode server** 进程的 OS 用户与权限下，不是在 CLI 所在机器/终端自动执行，也不是会弹 OpenCode tool 权限确认的模型工具。service 的 `PATH`、cwd、env 常与交互终端不同；用可执行程序绝对路径，检查 server 账户能读/执行必要文件。`env` 只在 spawn 时叠加，不修改全局 `process.env`。server 已启动后，外部终端的 `export` 不会更新它的继承环境；把可轮换凭证放在受控的 mint 程序所读取的来源，而不是靠给客户端 export 新变量。

- 配置 command 等同授权执行代码。仅允许可信配置/脚本，检查脚本和目录权限，不让不可信仓库替换它。优先 argv，审查 shell；不要用插件规避管理策略。
- stdout / stderr **分别最多 64 KiB**；stderr 始终 drain 但不保存、不打印。非零退出、启动失败、超时、abort、非法输出都使用脱敏错误，不附带底层 Error `cause` 或原始输出。超时后会有短暂终止宽限/强杀清理，不保证在 timeout 毫秒点同步返回。
- POSIX 使用独立子进程组，终止时先 SIGTERM，再 SIGKILL，包含同组 descendants；直接 child 先退出也不会取消必要 escalation。不允许命令自行 daemonize / `setsid` 逃离进程组；这不是 OS 沙箱。
- Windows 只保证 best-effort child 终止，没有 Job Object 级完整子树保证；实际子进程测试平台是 Linux，未验证 Windows/macOS。已在 Node.js 20.20.2 与 22.22.3 上运行核心单元测试及 packed-package smoke。使用上游 `Host` 工具的包发现回归测试需 Node ≥22.15，在 Node 20 下明确跳过；插件运行时不导入该工具。
- 真 key 只存在内存/命令输出和请求头，不写 provider/model settings、storage、credential 或用户配置。清引用/清 Buffer 不等于能在 JS 中保证所有字符串物理归零。不要在其它插件、代理、upstream 或 transport 日志里记录 Authorization；它们不在本插件的脱敏控制内。
- allowlist 只检查此 hook 看到的 URL，不是 DNS/网络沙箱；其它插件改 URL、底层跨 origin 重定向、自定义 SDK 绕过 hooks 都需另行审计。不要配置不可信 endpoint，尤其是可能转发自定义鉴权头的 redirect。

### 明确覆盖范围

| 路径 | 范围 |
| --- | --- |
| 普通 Session HTTP：primary / title / compaction / `session.generate` / 其 HTTP 重试 | 使用 provider-scoped `http.request` / `http.response` |
| 原生 Session WebSocket 及回退 HTTP | handshake/send guard；HTTP fallback 仍经过 HTTP hook |
| 无 Session 的 `ctx.generate.text` / API `generate.text` | **不支持**，它们绕过 Session hooks |
| 任意第三方 SDK、自定义 fetch、任意其它插件组合 | 未声明全覆盖，需按具体 transport 验证 |
| 已有在途 stream | 不强制中断，也不重新鉴权 |

不要使用不存在的 `event.request.settings.apiKey` 或 `model.error` hook。HTTP hook 位于 native auth 之后且 await 完成才进入 handler，抛错会阻断该发送；**后来注册的插件仍可能再次覆盖请求头**，并不存在“绝对最后优先级”。配置不合法会使插件 setup 失败，务必确认 OpenCode 实际加载成功；本插件不是宿主忽略/禁用插件时还能生效的全局网络开关。

## 开发与验证

- `src/config.ts`：严格校验；`src/command.ts`：有界子进程/输出解析；`src/key-manager.ts`：内存 single-flight；`src/index.ts`：公开类型的注册与生命周期。
- `tests/`：node:test + tsx；真实 Node 子进程验证超时/大输出/abort/descendant，注入 clock 验证边界和并发；mock context 仅用于 HTTP/WS hook 合约测试。`npm run typecheck` 使用发布的 `@opencode/plugin@2.0.32` 类型，不是自建假接口。
- npm 包不包含测试；源码包可在本项目重跑上述命令。构建后的包可直接 ESM import；验收范围见 [docs/verification.md](docs/verification.md)，本机运行日志不提交到仓库。
- **mock 通过不等于真实 OpenCode server 集成通过**。v2.0.32 / v2.1.2 的私有 server 与 loopback upstream 验证由独立 `scripts/` harness 执行，实际覆盖以其结果文件为准。没有对真实 provider 发请求，没有安装到共享 service。未验证真实厂商令牌签发、OAuth 迁移或任意第三方插件组合。
