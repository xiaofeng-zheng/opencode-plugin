import type { Snapshot, ErrorCode } from "./dto.ts"

const units = { ai_credits: "AI credits", premium_requests: "premium requests", chat_requests: "chat requests", unknown: "unknown" }
const number = (n: number | null) => n === null ? "?" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n)
const messages: Record<ErrorCode, string> = {
  disconnected: "No Copilot account connected", unsupported: "Only native GitHub.com OAuth credentials are supported", unavailable: "Server plugin is not loaded at the current location, or RPC is unavailable",
  unauthenticated: "GitHub credentials unavailable (401)", forbidden: "GitHub permission or policy restriction (403)", not_found: "Endpoint unavailable or insufficient permissions (404)",
  rate_limited: "GitHub rate limit reached; wait until the retry time", upstream: "GitHub service temporarily unavailable", timeout: "Quota request timed out", network: "Network request failed",
  invalid_data: "Quota data is missing, inconsistent, or unsupported", account_changed: "Account changed; waiting for a new snapshot", disposed: "Plugin unloaded",
}
export function footer(s: Snapshot): string {
  const suffix = s.status === "stale" ? " · stale" : s.status !== "ok" ? " · unknown" : ""
  if (s.unit === "unknown") return `Copilot: unknown${s.status === "stale" ? " · stale" : ""}`
  if (s.scope === "pooled_or_unlimited") {
    if (s.poolHasQuota === false) return `Copilot: pooled ${units[s.unit]} · quota unavailable${suffix}`
    if (s.absoluteCreditsUsed === null) return `Copilot: pooled/unlimited ${units[s.unit]}${suffix}`
    return `Copilot: ${number(s.absoluteCreditsUsed)} ${units[s.unit]} used · pooled${suffix}`
  }
  return `Copilot: ${s.approximate ? "≈" : ""}${number(s.used)} / ${number(s.allowance)} ${units[s.unit]} used (${number(s.usedPercent)}%)${suffix}`
}
export function details(s: Snapshot): string {
  return [footer(s), `Account: ${s.account ?? "unknown"}`, `Remaining: ${number(s.remaining)} ${units[s.unit]}`,
    `Scope: ${s.scope === "pooled_or_unlimited" ? "shared pool / no personal limit; does not mean free unlimited usage" : s.scope === "finite" ? "personal quota / user budget" : "unknown"}`,
    `Reset (UTC): ${s.resetAt ?? "unknown"}`,
    `Additional usage: ${number(s.additionalUsed)} / ${number(s.additionalAllowance)} ${units[s.unit]}; allowed: ${s.additionalAllowed === null ? "unknown" : s.additionalAllowed ? "yes" : "no"}`,
    `Absolute consumption: ${number(s.absoluteCreditsUsed)} AI credits (not the finite-quota numerator)`,
    `Fetched at (UTC): ${s.fetchedAt ?? "not yet fetched successfully"}`, ...(s.retryAt ? [`Retry at (UTC): ${s.retryAt}`] : []),
    ...(s.approximate ? ["≈ Quantities estimated from the remaining percentage"] : []), ...(s.legacyRemaining ? ["Balance uses the legacy remaining field"] : []),
    ...(s.poolHasQuota === false ? ["The shared pool may be exhausted"] : []), ...(s.error ? [`Status: ${messages[s.error]}`] : []),
    "Source: GitHub internal API, best-effort snapshot; not an authoritative bill.",
  ].join("\n")
}
