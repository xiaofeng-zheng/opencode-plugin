# opencode-copilot-credits

OpenCode **2.1.2 标准 Bun CLI、完整 TUI** 的 GitHub Copilot 账户额度插件。首页及输入框底栏追加已用量、额度和百分比；`/copilot` 强制刷新并显示余额、重置时间、额外使用、获取时间和安全错误。

## 安装

此包尚未发布到 npm。使用构建生成的 tarball，在你选择的本地目录安装：

```sh
npm install --prefix ./copilot-plugin /absolute/path/opencode-copilot-credits-0.1.0.tgz
```

服务端的 `opencode.jsonc` 使用复数 `plugins`，指向**已安装包目录**，不要指向单个 TS 文件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/copilot-plugin/node_modules/opencode-copilot-credits",
    "options": { "cacheTtlSeconds": 300, "timeoutSeconds": 10, "refreshSeconds": 300 }
  }]
}
```

本地双入口可自动加载。连接远程服务端时，客户端也需要自行安装包，并在客户端的 `~/.config/opencode/cli.json`（或 `$XDG_CONFIG_HOME/opencode/cli.json`）配置 TUI 半边：

```json
{
  "plugins": [{
    "package": "/absolute/client/path/copilot-plugin/node_modules/opencode-copilot-credits",
    "options": { "refreshSeconds": 300 }
  }]
}
```

服务端须已有 OpenCode 原生 `github-copilot` OAuth 登录。插件仅读取活动连接，不登录、不切账户。GitHub user OAuth 按原生 provider 合约取 `refresh`；凭据仅留在服务端。TUI 经当前 location 的已认证 OpenCode RPC `copilot.credits.get({force?: boolean})` 接收白名单 DTO。

## 刷新与显示

- 默认启动时读取一次、每 **300 秒**自动刷新；服务端内存缓存 TTL 同为 300 秒。
- `refreshSeconds`：30–3600，`0` 关闭自动轮询；`cacheTtlSeconds`：30–3600；`timeoutSeconds`：1–30。非法配置回退默认值。分端部署时分别配置客户端轮询和服务端 TTL。
- `/copilot` 绕过普通缓存，但始终遵守 GitHub `Retry-After` / rate-limit 退避。并发请求单飞，不发模型请求。
- 错误显示 `unknown`；同账户上次成功快照显示 `stale`，保留其获取时间。RPC 断开无法确认账户时显示未知。切换账户清除旧快照，重新解析活动连接。

## 单位与边界

- 明确 `token_based_billing: true` 才显示 **AI credits**，false 显示 **premium requests**（chat 桶显示 chat requests）。可使用一致的桶标记兜底；缺失或矛盾时单位未知。
- 有限配额：`used = entitlement − quota_remaining`，兼容 `remaining`；`percent_remaining` 是剩余比例，仅据此推算时标 `≈`。底栏最多显示三位小数，RPC 保留数值精度。
- `credits_used` 是独立绝对消费，不作有限配额分子。例如 13000 总额、807.7 余额、14517 绝对消费，配额已用为 **12192.3 / 13000**。
- Free 可回退 chat 桶；不把 completions 当 credits，不合计不同桶。共享池 / 无个人预算不伪造个人上限、余额或百分比；`unlimited` 不等于免费无限。零额度不计算百分比。
- 额外用量、额外预算、是否允许额外付费独立显示。重置优先桶的有效正数 Unix **秒**时间；`0` / `"0"` 是缺失哨兵，与无效时间一样依次回退到 UTC 日期、普通日期和 limited user 日期。无有效回退日期时显示未知，不显示 1970 年。
- 仅支持 GitHub.com。Enterprise 和未知凭据元数据返回 unsupported；固定 GET `https://api.github.com/copilot_internal/user`，不跟随重定向，也不提供可配置的生产 endpoint。
- 该接口是 GitHub **内部、尽力而为**的快照，并非权威账单；404 也可能表示权限不足。没有本地费用估算、token 汇总、套餐硬编码余额或推理探测。

## 开发与验证

以下命令在源码目录（或源码 ZIP 解压目录）运行，不是在仅含运行时文件的安装包目录运行。开发树保留 OpenTUI 所需的 Solid 版本，并将其 `seroval` 子依赖固定到已修复安全公告的 `1.6.8`；此设置不修改 OpenCode 宿主。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
# 可选：绝对路径指向标准 2.1.2 CLI，所有环境与 DB 均新建隔离
python3 scripts/host-probe.py --binary /absolute/path/opencode --tui
python3 scripts/host-probe.py --binary /absolute/path/opencode --tui --session --synthetic-fixture
```

`build` 在 `.artifacts/package/` 准备最小包：保留 TypeScript，用 Solid universal / OpenTUI preset 将 JSX 预编译成 JS（宿主转换器跳过 `node_modules`）；`pack:check` 从该目录执行 `npm pack`、干净沙盒安装和官方 Host 三入口解析。请分发该构建包，不要直接在源码根 `npm pack`。锁文件在本插件源码目录（`plugins/copilot-credits/`），不是多插件仓库根目录。Solid/OpenTUI 使用宿主运行时，不打包副本；PATH 不需要 Bun。**运行时仅验证标准 Bun CLI，不承诺 Node 版或 mini。** 2.0.32 共享服务跨版本加载未经验证。

测试均为明确的合成数据，不能代表真实账户结果。测试日志、tarball 和宿主验证记录在 `.artifacts/`，不进入 npm 包。`scripts/host-probe.py` 提供白名单环境、独立 HOME/XDG/DB 和显式私有 endpoint 的无模型宿主检查；导入本仓库后的验收见[验证说明](https://github.com/xiaofeng-zheng/opencode-plugin/blob/main/plugins/copilot-credits/docs/verification.md)；本机运行日志不提交到仓库。真实账户验证由调用方单独进行和记录。
