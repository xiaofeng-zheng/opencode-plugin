import { z } from "zod";
const quantity = z.number().finite().nonnegative().nullable();
export const ErrorCode = z.enum(["disconnected", "unsupported", "unavailable", "unauthenticated", "forbidden", "not_found", "rate_limited", "upstream", "timeout", "network", "invalid_data", "account_changed", "disposed"]);
export const SnapshotSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal("github-copilot-internal"),
  status: z.enum(["ok", "unknown", "stale", "disconnected", "unsupported", "unavailable"]),
  error: ErrorCode.nullable(),
  account: z.string().max(80).nullable(),
  unit: z.enum(["ai_credits", "premium_requests", "chat_requests", "unknown"]),
  scope: z.enum(["finite", "pooled_or_unlimited", "unknown"]),
  bucket: z.enum(["premium_interactions", "chat", "unknown"]),
  used: quantity,
  allowance: quantity,
  remaining: quantity,
  usedPercent: z.number().min(0).max(100).nullable(),
  approximate: z.boolean(),
  legacyRemaining: z.boolean(),
  absoluteCreditsUsed: quantity,
  additionalUsed: quantity,
  additionalAllowance: quantity,
  additionalAllowed: z.boolean().nullable(),
  poolHasQuota: z.boolean().nullable(),
  resetAt: z.string().datetime().nullable(),
  fetchedAt: z.string().datetime().nullable(),
  retryAt: z.string().datetime().nullable()
});
export const safeLabel = label => label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, 80);
export function empty(error = null, account = null) {
  return {
    version: 1,
    source: "github-copilot-internal",
    status: error === "disconnected" || error === "unsupported" ? error : "unknown",
    error,
    account: account === null ? null : safeLabel(account),
    unit: "unknown",
    scope: "unknown",
    bucket: "unknown",
    used: null,
    allowance: null,
    remaining: null,
    usedPercent: null,
    approximate: false,
    legacyRemaining: false,
    absoluteCreditsUsed: null,
    additionalUsed: null,
    additionalAllowance: null,
    additionalAllowed: null,
    poolHasQuota: null,
    resetAt: null,
    fetchedAt: null,
    retryAt: null
  };
}
