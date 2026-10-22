import { test } from "node:test"
import assert from "node:assert/strict"
import { numeric, parseQuota } from "../src/parser.ts"
import { SnapshotSchema, safeLabel } from "../src/dto.ts"
import { footer, details } from "../src/format.ts"

// Every fixture is synthetic, including the published official regression numbers.
const NOW = Date.UTC(2026, 9, 22)
const fixture = (b: object, top: object = { token_based_billing: true }) => ({ ...top, quota_snapshots: { premium_interactions: b } })
test("finite TBB: credits_used regression, decimals, has_quota:false", () => {
  const s = parseQuota(fixture({ entitlement: 13000, quota_remaining: 807.7, credits_used: 14517, percent_remaining: 6.2, has_quota: false }), NOW)
  assert.equal(s.used, 12192.3); assert.equal(s.remaining, 807.7); assert.equal(s.absoluteCreditsUsed, 14517)
  assert.equal(s.status, "ok"); assert.equal(s.unit, "ai_credits")
  assert.equal(s.usedPercent, 93.8)
  assert.match(footer(s), /12,192.3 \/ 13,000 AI credits/)
  assert.ok(SnapshotSchema.safeParse(s).success)
})
test("legacy premium requests and remaining precedence", () => {
  const s = parseQuota(fixture({ entitlement: "300.5", quota_remaining: "200.25", remaining: 12 }, { token_based_billing: false }), NOW)
  assert.equal(s.unit, "premium_requests"); assert.equal(s.used, 100.25); assert.equal(s.legacyRemaining, false)
  const old = parseQuota(fixture({ entitlement: 300, remaining: 299 }, { token_based_billing: false }), NOW)
  assert.equal(old.used, 1); assert.equal(old.legacyRemaining, true)
})
test("free chat fallback and completions never called credits", () => {
  for (const mode of [true, false]) {
    const s = parseQuota({ token_based_billing: mode, quota_snapshots: { chat: { entitlement: 50, quota_remaining: 40 }, completions: { entitlement: 2000 } } }, NOW)
    assert.equal(s.bucket, "chat"); assert.equal(s.unit, mode ? "ai_credits" : "chat_requests")
  }
  assert.equal(parseQuota({ token_based_billing: true, quota_snapshots: { completions: { entitlement: 20 } } }, NOW).unit, "unknown")
  const free = parseQuota({ token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 0, quota_remaining: 0 }, chat: { entitlement: 50, quota_remaining: 40 } } }, NOW)
  assert.equal(free.bucket, "chat"); assert.equal(free.used, 10)
  const legacyFree = parseQuota({ token_based_billing: false, monthly_quotas: { chat: 50 }, limited_user_quotas: { chat: 12.5 } }, NOW)
  assert.equal(legacyFree.unit, "chat_requests"); assert.equal(legacyFree.used, 37.5)
})
test("flags absent/conflicting stay unknown; bucket fallback", () => {
  const b = { entitlement: 100, quota_remaining: 20 }
  assert.equal(parseQuota(fixture(b, {}), NOW).unit, "unknown")
  assert.equal(parseQuota(fixture({ ...b, token_based_billing: false }), NOW).unit, "unknown")
  assert.equal(parseQuota(fixture({ ...b, token_based_billing: true }, {}), NOW).unit, "ai_credits")
  assert.equal(parseQuota(fixture({ ...b, token_based_billing: true }, { token_based_billing: "true" }), NOW).unit, "unknown")
})
test("unlimited and no personal budget keep absolute consumption separate", () => {
  for (const b of [{ unlimited: true, entitlement: 13000, credits_used: 14517, has_quota: false }, { credits_used: "1.25" }]) {
    const s = parseQuota(fixture(b), NOW)
    assert.equal(s.scope, "pooled_or_unlimited"); assert.equal(s.used, null); assert.equal(s.usedPercent, null); assert.equal(s.allowance, null)
    assert.match(footer(s), /pooled/)
  }
})
test("percentage means remaining; derived quantities are approximate", () => {
  const s = parseQuota(fixture({ entitlement: 1500, percent_remaining: 75 }), NOW)
  assert.equal(s.used, 375); assert.equal(s.remaining, 1125); assert.equal(s.usedPercent, 25); assert.equal(s.approximate, true)
  assert.match(footer(s), /≈375/)
  const huge = parseQuota(fixture({ entitlement: 1e308, percent_remaining: 50 }), NOW)
  assert.equal(huge.remaining, 5e307); assert.ok(SnapshotSchema.safeParse(huge).success)
})
test("strict numeric parsing does not coerce empty, null, booleans or truncate", () => {
  for (const x of [null, undefined, "", " ", true, false, "12x", "0x10", NaN, Infinity, "Infinity", [], {}]) assert.equal(numeric(x), null)
  for (const x of [12.25, "12.25", " 12.25 ", "1.225e1"]) assert.equal(numeric(x), 12.25)
})
test("zero/missing/malformed/negative/inconsistent quantities", () => {
  const zero = parseQuota(fixture({ entitlement: 0, quota_remaining: 0 }), NOW)
  assert.equal(zero.used, 0); assert.equal(zero.usedPercent, null)
  for (const b of [{}, { entitlement: -1 }, { entitlement: "" }, { entitlement: 10, quota_remaining: -1 }, { entitlement: 10, quota_remaining: 11 }, { entitlement: 10, percent_remaining: 101 }]) {
    const s = parseQuota(fixture(b), NOW)
    assert.equal(s.status, "unknown"); assert.equal(s.used, null); assert.equal(s.usedPercent, null)
  }
  for (const value of [null, false, "body", {}, { quota_snapshots: [] }]) assert.equal(parseQuota(value, NOW).status, "unknown")
  assert.equal(parseQuota(fixture({ entitlement: 100, quota_remaining: 25, percent_remaining: 100 }), NOW).status, "unknown")
  assert.equal(parseQuota(fixture({ entitlement: -1, credits_used: 50 }), NOW).scope, "unknown")
  assert.equal(parseQuota(fixture({ entitlement: 100, quota_remaining: -1, percent_remaining: 50 }), NOW).used, null)
})
test("additional allowance separate and reset precedence is UNIX seconds", () => {
  const s = parseQuota(fixture({ entitlement: 1500, remaining: 1000, overage_count: "12.5", overage_entitlement: 50, overage_permitted: true, quota_reset_at: 1793491200 }, { token_based_billing: true, quota_reset_date_utc: "2027-01-01T00:00:00Z" }), NOW)
  assert.equal(s.used, 500); assert.equal(s.additionalUsed, 12.5); assert.equal(s.additionalAllowance, 50)
  assert.equal(s.resetAt, "2026-11-01T00:00:00.000Z")
  for (const field of ["quota_reset_date_utc", "quota_reset_date", "limited_user_reset_date"]) {
    assert.equal(parseQuota(fixture({ entitlement: 1, remaining: 1 }, { token_based_billing: true, [field]: "2027-02-01" }), NOW).resetAt, "2027-02-01T00:00:00.000Z")
  }
  assert.match(details(s), /额外使用: 12.5 \/ 50 AI credits/)
})
test("zero reset sentinel (number/string) falls back to the validated root date", () => {
  for (const quota_reset_at of [0, "0"]) {
    const s = parseQuota(fixture({ entitlement: 100, remaining: 25, quota_reset_at }, {
      token_based_billing: true,
      quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
      quota_reset_date: "2026-12-01",
    }), NOW)
    assert.equal(s.resetAt, "2026-11-01T00:00:00.000Z")
    assert.match(details(s), /重置 \(UTC\): 2026-11-01T00:00:00\.000Z/)
    assert.doesNotMatch(details(s), /1970-01-01/)
  }
})
test("zero reset without a valid fallback returns null, never 1970", () => {
  for (const quota_reset_at of [0, "0"]) {
    for (const dates of [{}, { quota_reset_date_utc: "invalid", quota_reset_date: "2026-02-30", limited_user_reset_date: null }]) {
      const s = parseQuota(fixture({ entitlement: 100, remaining: 25, quota_reset_at }, { token_based_billing: true, ...dates }), NOW)
      assert.equal(s.resetAt, null)
      assert.match(details(s), /重置 \(UTC\): 未知/)
    }
  }
})
test("invalid/negative/out-of-range reset fields use existing validated fallback order", () => {
  for (const quota_reset_at of [undefined, null, "", " ", false, true, "invalid", -1, "-1", NaN, Infinity, 253402300800, "253402300800"]) {
    const bucket = { entitlement: 100, remaining: 25, quota_reset_at }
    assert.equal(parseQuota(fixture(bucket, { token_based_billing: true, quota_reset_date_utc: "2026-11-01T00:00:00.000Z" }), NOW).resetAt, "2026-11-01T00:00:00.000Z")
    assert.equal(parseQuota(fixture(bucket), NOW).resetAt, null)
  }
  const bucket = { entitlement: 100, remaining: 25, quota_reset_at: 0 }
  assert.equal(parseQuota(fixture(bucket, { quota_reset_date_utc: "invalid", quota_reset_date: "2026-12-01", limited_user_reset_date: "2027-01-01" }), NOW).resetAt, "2026-12-01T00:00:00.000Z")
  assert.equal(parseQuota(fixture(bucket, { quota_reset_date_utc: "invalid", quota_reset_date: "2026-02-30", limited_user_reset_date: "2027-01-01" }), NOW).resetAt, "2027-01-01T00:00:00.000Z")
})
test("positive UNIX seconds retain precedence over valid root reset dates", () => {
  for (const quota_reset_at of [1793491200, "1793491200", 1, "1"]) {
    const s = parseQuota(fixture({ entitlement: 100, remaining: 25, quota_reset_at }, {
      token_based_billing: true, quota_reset_date_utc: "2027-01-01T00:00:00.000Z",
    }), NOW)
    assert.equal(s.resetAt, new Date(Number(quota_reset_at) * 1000).toISOString())
  }
})
test("whitelisted DTO and control-character-safe labels", () => {
  const s = parseQuota({ ...fixture({ entitlement: 5, remaining: 4 }), token: "synthetic-secret", arbitrary: "upstream-body" }, NOW, "hello\n\u001b\u202eworld")
  assert.equal(s.account, "helloworld"); assert.equal(safeLabel("x".repeat(100)).length, 80)
  assert.doesNotMatch(JSON.stringify(s), /synthetic-secret|upstream-body/)
  assert.equal(SnapshotSchema.safeParse({ ...s, headers: {} }).success, false)
})
