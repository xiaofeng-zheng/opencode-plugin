import { empty } from "./dto.js";
export function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function numeric(value) {
  if (typeof value === "string") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
const nonnegative = v => {
  const n = numeric(v);
  return n !== null && n >= 0 ? n : null;
};
const boolean = v => typeof v === "boolean" ? v : null;
function date(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v)) return null;
  const day = new Date(v.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== v.slice(0, 10)) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function reset(bucket, root) {
  const seconds = nonnegative(bucket.quota_reset_at);
  // GitHub uses zero as an absent reset sentinel, not the Unix epoch.
  if (seconds !== null && seconds > 0 && seconds <= 253402300799) return new Date(seconds * 1000).toISOString();
  return date(root.quota_reset_date_utc) ?? date(root.quota_reset_date) ?? date(root.limited_user_reset_date);
}

/** Pure whitelist mapper. No plan/date guessing and no summing unrelated buckets. */
export function parseQuota(value, now, account = null) {
  const root = record(value),
    buckets = record(root.quota_snapshots);
  const premium = record(buckets.premium_interactions);
  let chat = record(buckets.chat);
  // Official legacy Free fallback. Completions are intentionally never selected.
  if (!Object.keys(chat).length && numeric(record(root.monthly_quotas).chat) !== null) {
    chat = {
      entitlement: record(root.monthly_quotas).chat,
      quota_remaining: record(root.limited_user_quotas).chat
    };
  }
  // A zero premium allocation on Free must not hide the useful chat bucket.
  const name = Object.keys(premium).length && !(numeric(premium.entitlement) === 0 && premium.unlimited !== true && Object.keys(chat).length) ? "premium_interactions" : Object.keys(chat).length ? "chat" : "unknown";
  const result = empty("invalid_data", account);
  result.fetchedAt = new Date(now).toISOString();
  if (name === "unknown") return result;
  const b = name === "chat" ? chat : premium;
  result.bucket = name;
  const top = boolean(root.token_based_billing),
    local = boolean(b.token_based_billing);
  const malformedFlag = root.token_based_billing !== undefined && top === null || b.token_based_billing !== undefined && local === null;
  const mode = malformedFlag || top !== null && local !== null && top !== local ? null : top ?? local;
  result.unit = mode === true ? "ai_credits" : mode === false ? name === "chat" ? "chat_requests" : "premium_requests" : "unknown";
  result.resetAt = reset(b, root);
  result.additionalUsed = nonnegative(b.overage_count);
  result.additionalAllowance = nonnegative(b.overage_entitlement);
  result.additionalAllowed = boolean(b.overage_permitted);
  result.absoluteCreditsUsed = mode === true ? nonnegative(b.credits_used) : null;
  const allowance = nonnegative(b.entitlement);
  const primary = nonnegative(b.quota_remaining);
  const remaining = primary ?? nonnegative(b.remaining);
  result.legacyRemaining = primary === null && remaining !== null;
  const p = nonnegative(b.percent_remaining);
  const percent = p !== null && p <= 100 ? p : null;
  if (b.unlimited === true || mode === true && b.entitlement === undefined && result.absoluteCreditsUsed !== null) {
    result.scope = "pooled_or_unlimited";
    result.poolHasQuota = boolean(b.has_quota);
  } else if (allowance !== null) {
    result.scope = "finite";
    result.allowance = allowance;
    if (remaining !== null && remaining <= allowance) {
      result.remaining = remaining;
      result.used = allowance - remaining;
      // GitHub reports the percentage with its own rounding precision.
      result.usedPercent = allowance > 0 ? percent === null ? result.used / allowance * 100 : 100 - percent : null;
      if (allowance > 0 && percent !== null && Math.abs(remaining / allowance * 100 - percent) > 1) {
        result.usedPercent = null;
        return result;
      }
    } else if (remaining === null && b.quota_remaining === undefined && b.remaining === undefined && percent !== null && allowance > 0) {
      result.approximate = true;
      result.remaining = allowance * (percent / 100);
      result.used = allowance - result.remaining;
      result.usedPercent = 100 - percent;
    }
  }
  if (result.unit !== "unknown" && (result.used !== null || result.scope === "pooled_or_unlimited")) {
    result.status = "ok";
    result.error = null;
  }
  return result;
}
