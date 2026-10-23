import { test } from "node:test"
import assert from "node:assert/strict"
import { empty, ErrorCode, type Snapshot } from "../src/dto.ts"
import { details, footer } from "../src/format.ts"
import { parseQuota } from "../src/parser.ts"

// All account and quota values are synthetic, not live-account results.
const finite = parseQuota({
  token_based_billing: true,
  quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
  quota_snapshots: { premium_interactions: {
    entitlement: 13000, quota_remaining: 807.7, credits_used: 14517,
    overage_count: 12.5, overage_entitlement: 50, overage_permitted: true,
  } },
}, Date.parse("2026-10-22T00:00:00.000Z"), "Synthetic account")

const source = "Source: GitHub internal API, best-effort snapshot; not an authoritative bill."

test("finite details use English labels and preserve amounts, units, and billing caveats", () => {
  assert.deepEqual(details(finite).split("\n"), [
    "Copilot: 12,192.3 / 13,000 AI credits used (93.787%)",
    "Account: Synthetic account",
    "Remaining: 807.7 AI credits",
    "Scope: personal quota / user budget",
    "Reset (UTC): 2026-11-01T00:00:00.000Z",
    "Additional usage: 12.5 / 50 AI credits; allowed: yes",
    "Absolute consumption: 14,517 AI credits (not the finite-quota numerator)",
    "Fetched at (UTC): 2026-10-22T00:00:00.000Z",
    source,
  ])
})

test("disconnected details keep unknown values and never invent a zero balance", () => {
  assert.deepEqual(details(empty("disconnected")).split("\n"), [
    "Copilot: unknown",
    "Account: unknown",
    "Remaining: ? unknown",
    "Scope: unknown",
    "Reset (UTC): unknown",
    "Additional usage: ? / ? unknown; allowed: unknown",
    "Absolute consumption: ? AI credits (not the finite-quota numerator)",
    "Fetched at (UTC): not yet fetched successfully",
    "Status: No Copilot account connected",
    source,
  ])
})

test("every error code has a safe English explanation", () => {
  const messages: Record<ErrorCode, string> = {
    disconnected: "No Copilot account connected",
    unsupported: "Only native GitHub.com OAuth credentials are supported",
    unavailable: "Server plugin is not loaded at the current location, or RPC is unavailable",
    unauthenticated: "GitHub credentials unavailable (401)",
    forbidden: "GitHub permission or policy restriction (403)",
    not_found: "Endpoint unavailable or insufficient permissions (404)",
    rate_limited: "GitHub rate limit reached; wait until the retry time",
    upstream: "GitHub service temporarily unavailable",
    timeout: "Quota request timed out",
    network: "Network request failed",
    invalid_data: "Quota data is missing, inconsistent, or unsupported",
    account_changed: "Account changed; waiting for a new snapshot",
    disposed: "Plugin unloaded",
  }
  for (const code of ErrorCode.options) {
    assert.ok(details(empty(code)).split("\n").includes(`Status: ${messages[code]}`), code)
  }
})

test("pooled details preserve exhaustion and unlimited-usage warnings in English", () => {
  const pooled: Snapshot = { ...empty(), status: "ok", unit: "ai_credits", scope: "pooled_or_unlimited" }
  const exhausted: Snapshot = { ...pooled, poolHasQuota: false }
  assert.equal(footer(pooled), "Copilot: pooled/unlimited AI credits")
  assert.equal(footer({ ...pooled, absoluteCreditsUsed: 14517 }), "Copilot: 14,517 AI credits used · pooled")
  assert.equal(footer(exhausted), "Copilot: pooled AI credits · quota unavailable")
  assert.equal(footer({ ...exhausted, status: "stale" }), "Copilot: pooled AI credits · quota unavailable · stale")
  const lines = details(exhausted).split("\n")
  assert.ok(lines.includes("Scope: shared pool / no personal limit; does not mean free unlimited usage"))
  assert.ok(lines.includes("The shared pool may be exhausted"))
  assert.ok(lines.includes(source))
})

test("stale details retain retry time, approximation, legacy field, and additional-usage permission", () => {
  const snapshot: Snapshot = {
    ...finite, status: "stale", error: "rate_limited", approximate: true, legacyRemaining: true,
    retryAt: "2026-10-22T01:00:00.000Z", additionalAllowed: false,
  }
  assert.equal(footer(snapshot), "Copilot: ≈12,192.3 / 13,000 AI credits used (93.787%) · stale")
  const lines = details(snapshot).split("\n")
  assert.ok(lines.includes("Fetched at (UTC): 2026-10-22T00:00:00.000Z"))
  assert.ok(lines.includes("Retry at (UTC): 2026-10-22T01:00:00.000Z"))
  assert.ok(lines.includes("≈ Quantities estimated from the remaining percentage"))
  assert.ok(lines.includes("Balance uses the legacy remaining field"))
  assert.ok(lines.includes("Additional usage: 12.5 / 50 AI credits; allowed: no"))
})

test("English formatting keeps AI credits, premium requests, and chat requests distinct", () => {
  for (const [unit, label] of [
    ["ai_credits", "AI credits"], ["premium_requests", "premium requests"], ["chat_requests", "chat requests"],
  ] as const) {
    const snapshot: Snapshot = { ...finite, unit }
    assert.equal(footer(snapshot), `Copilot: 12,192.3 / 13,000 ${label} used (93.787%)`)
    assert.ok(details(snapshot).split("\n").includes(`Remaining: 807.7 ${label}`))
    assert.ok(details(snapshot).split("\n").includes(`Additional usage: 12.5 / 50 ${label}; allowed: yes`))
    assert.ok(details(snapshot).split("\n").includes("Absolute consumption: 14,517 AI credits (not the finite-quota numerator)"))
  }
})
