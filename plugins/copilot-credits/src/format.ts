import type { Snapshot, ErrorCode } from "./dto.ts"

const units = { ai_credits: "AI credits", premium_requests: "premium requests", chat_requests: "chat requests", unknown: "单位未知" }
const number = (n: number | null) => n === null ? "?" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n)
const messages: Record<ErrorCode, string> = {
  disconnected: "未连接 Copilot 账户", unsupported: "仅支持 GitHub.com 原生 OAuth 凭据", unavailable: "当前 location 未加载服务端插件或 RPC 不可用",
  unauthenticated: "GitHub 凭据不可用 (401)", forbidden: "GitHub 权限或政策限制 (403)", not_found: "接口不可用或权限不足 (404)",
  rate_limited: "GitHub 限流，请等待重试时间", upstream: "GitHub 服务暂不可用", timeout: "查询超时", network: "网络查询失败",
  invalid_data: "额度数据缺失、矛盾或不受支持", account_changed: "账户已切换，等待新快照", disposed: "插件已卸载",
}
export function footer(s: Snapshot): string {
  const suffix = s.status === "stale" ? " · stale" : s.status !== "ok" ? " · unknown" : ""
  if (s.unit === "unknown") return `Copilot: unknown${s.status === "stale" ? " · stale" : ""}`
  if (s.scope === "pooled_or_unlimited") {
    if (s.poolHasQuota === false) return `Copilot: pooled ${units[s.unit]} · 配额不可用${suffix}`
    if (s.absoluteCreditsUsed === null) return `Copilot: pooled/unlimited ${units[s.unit]}${suffix}`
    return `Copilot: ${number(s.absoluteCreditsUsed)} ${units[s.unit]} used · pooled${suffix}`
  }
  return `Copilot: ${s.approximate ? "≈" : ""}${number(s.used)} / ${number(s.allowance)} ${units[s.unit]} used (${number(s.usedPercent)}%)${suffix}`
}
export function details(s: Snapshot): string {
  return [footer(s), `账户: ${s.account ?? "未知"}`, `剩余: ${number(s.remaining)} ${units[s.unit]}`,
    `范围: ${s.scope === "pooled_or_unlimited" ? "共享池 / 无个人上限；不代表免费无限" : s.scope === "finite" ? "个人配额 / 用户预算" : "未知"}`,
    `重置 (UTC): ${s.resetAt ?? "未知"}`,
    `额外使用: ${number(s.additionalUsed)} / ${number(s.additionalAllowance)} ${units[s.unit]}; 允许: ${s.additionalAllowed === null ? "未知" : s.additionalAllowed ? "是" : "否"}`,
    `独立绝对消费: ${number(s.absoluteCreditsUsed)} AI credits（不作有限额度分子）`,
    `获取时间 (UTC): ${s.fetchedAt ?? "尚未成功获取"}`, ...(s.retryAt ? [`可重试 (UTC): ${s.retryAt}`] : []),
    ...(s.approximate ? ["≈ 数量由剩余百分比推算"] : []), ...(s.legacyRemaining ? ["余额使用兼容字段 remaining"] : []),
    ...(s.poolHasQuota === false ? ["共享池可能已耗尽"] : []), ...(s.error ? [`状态: ${messages[s.error]}`] : []),
    "来源: GitHub 内部接口，尽力提供快照；不是权威账单。",
  ].join("\n")
}
