import { test } from "node:test"
import assert from "node:assert/strict"
import { CreditsClient, USAGE_URL } from "../src/client.ts"
import type { Account, AccountState } from "../src/account.ts"

export const synthetic: Account = { key: "synthetic-a@github.com", host: "github.com", label: "Synthetic A", token: "synthetic-oauth" }
export const body = { token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 100, quota_remaining: 75 } } }
const ok = () => Response.json(body)
const tick = () => new Promise(resolve => setImmediate(resolve))
test("fixed URL, GET, honest headers, redirects disabled, TTL and force", async () => {
  let now = 100000, calls = 0
  const client = new CreditsClient({ account: async () => ({ account: synthetic }), now: () => now, fetch: async (url, init) => {
    calls++; assert.equal(url, USAGE_URL); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error")
    assert.deepEqual(init.headers, { Authorization: "Bearer synthetic-oauth", Accept: "application/json", "User-Agent": "opencode-copilot-credits/0.1.0" })
    return ok()
  } })
  assert.equal((await client.get()).used, 25)
  await client.get(); assert.equal(calls, 1)
  now += 300001; await client.get(); assert.equal(calls, 2)
  await client.get({ force: true }); assert.equal(calls, 3); client.dispose()
})
test("single-flight for concurrent force callers", async () => {
  let calls = 0
  let release!: (r: Response) => void
  const client = new CreditsClient({ account: async () => ({ account: synthetic }), fetch: async () => { calls++; return new Promise(resolve => { release = resolve }) } })
  const a = client.get(), b = client.get({ force: true })
  await tick(); assert.equal(calls, 1); release(ok())
  assert.deepEqual(await a, await b); client.dispose()
})
test("safe errors and same-account stale retains last-success fetched time", async () => {
  let response: () => Response = ok
  const client = new CreditsClient({ account: async () => ({ account: synthetic }), fetch: async () => response() })
  const success = await client.get()
  for (const [status, error] of [[401, "unauthenticated"], [403, "forbidden"], [404, "not_found"], [500, "upstream"], [503, "upstream"]] as const) {
    response = () => new Response("synthetic upstream secret", { status })
    const s = await client.get({ force: true })
    assert.equal(s.error, error); assert.equal(s.status, "stale"); assert.equal(s.used, 25); assert.equal(s.fetchedAt, success.fetchedAt)
    assert.doesNotMatch(JSON.stringify(s), /secret|synthetic-oauth/)
  }
  client.dispose()
})
test("missing body/invalid JSON/missing quota are unknown without prior success", async () => {
  for (const response of [new Response(null), new Response("not json"), Response.json({})]) {
    const c = new CreditsClient({ account: async () => ({ account: synthetic }), fetch: async () => response })
    const s = await c.get(); assert.equal(s.error, "invalid_data"); assert.equal(s.used, null); c.dispose()
  }
})
test("429/403/Retry-After rate backoff wins over force including account switch", async () => {
  for (const [status, headers] of [[429, { "retry-after": "600" }], [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "700" }], [503, { "retry-after": "Thu, 01 Jan 1970 00:11:40 GMT" }]] as const) {
    let now = 100000, calls = 0
    let account = synthetic
    const c = new CreditsClient({ account: async () => ({ account }), now: () => now, fetch: async () => { calls++; return calls === 1 ? new Response("secret", { status, headers }) : ok() } })
    const s = await c.get(); assert.equal(s.error, "rate_limited"); assert.equal(s.retryAt, "1970-01-01T00:11:40.000Z")
    await c.get({ force: true }); assert.equal(calls, 1)
    account = { ...synthetic, key: "b@github.com" }; await c.get()
    account = synthetic; await c.get({ force: true }); assert.equal(calls, 2)
    now = 700001; await c.get({ force: true }); assert.equal(calls, 3); c.dispose()
  }
})
test("bounded timeout, network/redirect rejection and disposal abort", async () => {
  let signal: AbortSignal | undefined
  const c = new CreditsClient({ account: async () => ({ account: synthetic }), timeoutMs: 10, fetch: async (_, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}) } })
  assert.equal((await c.get()).error, "timeout"); assert.equal(signal?.aborted, true); c.dispose()
  const d = new CreditsClient({ account: async () => ({ account: synthetic }), fetch: async () => { throw new Error("synthetic token and headers") } })
  assert.equal((await d.get()).error, "network"); d.dispose()
  const e = new CreditsClient({ account: async () => ({ account: synthetic }), fetch: async (_, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}) } })
  const pending = e.get(); await tick(); e.dispose()
  assert.equal((await pending).error, "disposed"); assert.equal(signal?.aborted, true); assert.equal((await e.get()).error, "disposed")
})
test("account switch while request is in flight cannot return old data", async () => {
  let state: AccountState = { account: synthetic }
  let release!: (r: Response) => void
  let calls = 0
  const c = new CreditsClient({ account: async () => state, fetch: async () => { calls++; if (calls === 1) return new Promise(resolve => { release = resolve }); return Response.json({ ...body, quota_snapshots: { premium_interactions: { entitlement: 20, remaining: 10 } } }) } })
  const a = c.get(); await tick()
  state = { account: { ...synthetic, key: "b@github.com", label: "Synthetic B" } }
  const b = await c.get(); release(ok())
  assert.equal(b.used, 10); assert.equal(b.account, "Synthetic B"); assert.equal((await a).error, "account_changed")
  assert.equal((await c.get()).account, "Synthetic B")
  state = { error: "disconnected" }; assert.equal((await c.get()).used, null); c.dispose()
})
test("switch detected on post-fetch re-resolution without event", async () => {
  let state: AccountState = { account: synthetic }
  const c = new CreditsClient({ account: async () => state, fetch: async () => { state = { account: { ...synthetic, key: "b" } }; return ok() } })
  assert.equal((await c.get()).error, "account_changed"); c.dispose()
})
test("aborting one RPC waiter doesn't cancel other shared callers", async () => {
  let release!: (r: Response) => void
  const c = new CreditsClient({ account: async () => ({ account: synthetic }), fetch: async () => new Promise(resolve => { release = resolve }) })
  const controller = new AbortController()
  const a = c.get({}, controller.signal), b = c.get(); await tick(); controller.abort()
  assert.equal((await a).error, "disposed"); release(ok()); assert.equal((await b).used, 25); c.dispose()
})
test("guard failures and account-source exceptions never issue a request", async () => {
  let calls = 0
  for (const error of ["disconnected", "unsupported"] as const) {
    const c = new CreditsClient({ account: async () => ({ error }), fetch: async () => { calls++; return ok() } })
    assert.equal((await c.get()).status, error); c.dispose()
  }
  const c = new CreditsClient({ account: async () => { throw new Error("synthetic credential metadata") } })
  assert.equal((await c.get()).error, "unavailable"); assert.equal(calls, 0); c.dispose()
})
test("stale rate-limited snapshots retain timestamp and Retry-After across forced refresh", async () => {
  let now = 100000, calls = 0
  const c = new CreditsClient({ account: async () => ({ account: synthetic }), now: () => now, fetch: async () => {
    calls++; return calls === 1 ? ok() : new Response(null, { status: 429, headers: { "retry-after": "300" } })
  } })
  const first = await c.get(); now += 10000
  const stale = await c.get({ force: true })
  assert.equal(stale.status, "stale"); assert.equal(stale.fetchedAt, first.fetchedAt); assert.equal(stale.used, 25)
  assert.equal(stale.retryAt, "1970-01-01T00:06:50.000Z")
  await c.get({ force: true }); assert.equal(calls, 2); c.dispose()
})
test("body size limit and malformed body preserve safe last success", async () => {
  let calls = 0
  const c = new CreditsClient({ account: async () => ({ account: synthetic }), fetch: async () => ++calls === 1 ? ok() : new Response("x".repeat(1048577)) })
  await c.get(); const s = await c.get({ force: true })
  assert.equal(s.status, "stale"); assert.equal(s.error, "invalid_data"); assert.equal(s.used, 25); c.dispose()
})
