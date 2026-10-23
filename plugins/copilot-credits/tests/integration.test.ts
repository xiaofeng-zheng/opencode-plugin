import { test } from "node:test"
import assert from "node:assert/strict"
import type { Context as ServerContext } from "@opencode/plugin/promise/plugin"
import type { Context, SlotClaim, KeymapLayer } from "@opencode/plugin/tui/context"
import { createAccountSource } from "../src/account.ts"
import { setupServer } from "../src/server.ts"
import { setupTui } from "../src/tui-controller.ts"
import { Credits } from "../src/rpc.ts"
import { empty } from "../src/dto.ts"
import { parseQuota } from "../src/parser.ts"

const tick = () => new Promise(resolve => setImmediate(resolve))
const connection = { type: "credential", id: "synthetic-id", method: "oauth", label: "Synthetic\nAccount" }
const credential = { type: "oauth", methodID: "device", refresh: "synthetic-user-oauth", access: "synthetic-wrong-access", expires: 0 }
test("server account adapter uses active github-copilot then resolve and refresh token", async () => {
  const calls: string[] = []
  const source = createAccountSource({
    active: async (id: string) => { calls.push(id); return connection },
    resolve: async (c: unknown) => { assert.equal(c, connection); calls.push("resolve"); return credential },
  } as unknown as ServerContext["integration"]["connection"])
  const state = await source()
  assert.deepEqual(calls, ["github-copilot", "resolve", "github-copilot"])
  assert.equal(state.account?.token, "synthetic-user-oauth"); assert.equal(state.account?.label, "SyntheticAccount")
})
test("credential/enterprise metadata guards fail closed; supported public endpoints", async () => {
  for (const value of [
    { ...credential, type: "key" }, { ...credential, methodID: "other" }, { ...credential, refresh: "" }, { ...credential, refresh: "bad\nvalue" },
    { ...credential, metadata: { enterpriseUrl: "company.ghe.com" } },
    { ...credential, metadata: { host: "github.com" } },
    { ...credential, metadata: { apiEndpoint: "https://api.githubcopilot.com.evil.test" } },
    { ...credential, metadata: { apiEndpoint: "https://user@api.githubcopilot.com" } },
    { ...credential, metadata: { apiEndpoint: "http://api.githubcopilot.com" } },
    { ...credential, metadata: { apiEndpoint: "https://api.githubcopilot.com/path" } },
  ]) {
    const source = createAccountSource({ active: async () => connection, resolve: async () => value } as unknown as ServerContext["integration"]["connection"])
    assert.equal((await source()).error, "unsupported")
  }
  for (const host of ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"]) {
    const source = createAccountSource({ active: async () => connection, resolve: async () => ({ ...credential, metadata: { apiEndpoint: `https://${host}` } }) } as unknown as ServerContext["integration"]["connection"])
    assert.equal((await source()).account?.host, "github.com")
  }
  for (const c of [undefined, { type: "env", name: "SYNTHETIC" }, { ...connection, method: "external" }]) {
    const source = createAccountSource({ active: async () => c, resolve: async () => { throw new Error("must not resolve") } } as unknown as ServerContext["integration"]["connection"])
    assert.equal((await source()).error, c ? "unsupported" : "disconnected")
  }
})
test("account changes during resolve are rejected", async () => {
  let n = 0
  const source = createAccountSource({ active: async () => ++n === 1 ? connection : { ...connection, id: "b" }, resolve: async () => credential } as unknown as ServerContext["integration"]["connection"])
  assert.equal((await source()).error, "account_changed")
})
test("server registers real contract, safe DTO, event and RPC cleanup", async () => {
  let handler!: (input: { force?: boolean }, call: { signal: AbortSignal }) => Promise<unknown>
  let eventSignal: AbortSignal | undefined, disposed = 0
  const ctx = {
    options: {}, integration: { connection: { active: async () => undefined } },
    rpc: { register: async (contract: unknown, handlers: { get: typeof handler }) => { assert.equal(contract, Credits); handler = handlers.get; return { dispose: async () => { disposed++ } } } },
    event: { subscribe: (options: { signal: AbortSignal }) => { eventSignal = options.signal; return { async *[Symbol.asyncIterator]() {} } } },
  } as unknown as ServerContext
  const off = await setupServer(ctx)
  assert.deepEqual(await handler({ force: true }, { signal: new AbortController().signal }), empty("disconnected"))
  await off(); assert.equal(disposed, 1); assert.equal(eventSignal?.aborted, true)
})
function tuiHarness(options: Record<string, unknown> = { refreshSeconds: 0 }) {
  let text = "", response: unknown = parseQuota({ token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 25 } } }, 100000)
  let layer!: KeymapLayer, listener: ((event: { data: { integrationID: string } }) => void) | undefined
  const slots: SlotClaim[] = [], calls: Array<{ input: unknown; options: { location: { directory: string }; signal: AbortSignal } }> = []
  const dialogs: Array<{ title: string; message: string }> = []
  let removed = 0, stopped = 0
  let location: { directory: string } | undefined = { directory: "/synthetic/current" }
  let transport = async () => response
  const ctx = {
    options, get location() { return location },
    client: { rpc: (contract: unknown) => { assert.equal(contract, Credits); return { get: async (input: unknown, options: typeof calls[number]["options"]) => { calls.push({ input, options }); return transport() } } } },
    data: { location: { default: () => ({ directory: "/synthetic/default" }) }, on: (_name: string, fn: typeof listener) => { listener = fn; return () => { stopped++ } } },
    ui: { slot: (claim: SlotClaim) => { slots.push(claim); return () => { removed++ } }, dialog: { alert: async (input: typeof dialogs[number]) => { dialogs.push(input) } } },
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() } },
  } as unknown as Context
  const off = setupTui(ctx, line => line(), value => { text = value }, () => text)
  return { off, ctx, slots, calls, dialogs, layer: () => layer, text: () => text, removed: () => removed, stopped: () => stopped,
    respond: (value: unknown) => { response = value }, transport: (value: () => Promise<unknown>) => { transport = value },
    switch: () => listener?.({ data: { integrationID: "github-copilot" } }), move: () => { location = { directory: "/synthetic/new" } }, clearLocation: () => { location = undefined } }
}
test("TUI appends home status and session sidebar, never the prompt footer", async () => {
  const h = tuiHarness()
  assert.equal(h.text(), "Copilot: loading…")
  await tick()
  assert.deepEqual(h.slots.map(s => s.append), ["home.footer.status", "sidebar.content"])
  assert.equal(h.slots.some(s => s.append === "prompt.footer.status"), false)
  const [home, sidebar] = h.slots
  assert.ok(home?.append === "home.footer.status")
  assert.ok(sidebar?.append === "sidebar.content")
  assert.equal(home.render({}), h.text())
  assert.equal(sidebar.render({ sessionID: "synthetic-session" }), h.text())
  assert.match(h.text(), /75 \/ 100 AI credits used \(75%\)/)
  assert.equal(h.calls[0]?.options.location.directory, "/synthetic/current")
  const command = h.layer().commands?.[0]
  assert.equal(command?.slash?.name, "copilot")
  assert.equal(command?.title, "Copilot credits")
  await command?.run?.()
  assert.deepEqual(h.calls.at(-1)?.input, { force: true }); assert.match(h.dialogs[0]!.message, /Remaining: 25 AI credits/)
  assert.equal(h.dialogs[0]?.title, "Copilot credits")
  h.off(); assert.equal(h.removed(), 2); assert.equal(h.stopped(), 1)
})
test("TUI errors are unknown, account event clears old balance, late results ignored on unload", async () => {
  const h = tuiHarness(); await tick()
  h.transport(async () => { throw new Error("synthetic secret") })
  await h.layer().commands?.[0]?.run?.()
  assert.match(h.text(), /unknown/); assert.doesNotMatch(h.dialogs[0]!.message, /synthetic secret/)
  let release!: (value: unknown) => void
  h.transport(async () => new Promise(resolve => { release = resolve }))
  h.switch(); assert.equal(h.text(), "Copilot: loading…")
  h.off(); assert.equal(h.calls.at(-1)?.options.signal.aborted, true)
  release(empty()); await tick(); assert.equal(h.text(), "Copilot: loading…")
})
test("location change while waiting never displays old location balance", async () => {
  const h = tuiHarness(); await tick()
  let release!: (value: unknown) => void
  h.transport(async () => new Promise(resolve => { release = resolve }))
  const pending = h.layer().commands?.[0]?.run?.(); h.move(); release(empty())
  await pending; assert.match(h.text(), /unknown/); h.off()
})
test("TUI five-minute automatic refresh, default location, timer disposed", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] })
  const h = tuiHarness({}); await tick()
  assert.equal(h.calls.length, 1)
  h.clearLocation()
  context.mock.timers.tick(299999); await tick(); assert.equal(h.calls.length, 1)
  context.mock.timers.tick(1); await tick(); assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1]?.options.location.directory, "/synthetic/default")
  h.off(); context.mock.timers.tick(600000); await tick(); assert.equal(h.calls.length, 2)
})
test("server unload aborts the actual injectable client request", async () => {
  let handler!: (input: { force?: boolean }, call: { signal: AbortSignal }) => Promise<{ error: string }>
  let signal: AbortSignal | null | undefined
  const ctx = {
    options: {}, integration: { connection: {} },
    rpc: { register: async (_contract: unknown, handlers: { get: typeof handler }) => { handler = handlers.get; return { dispose: async () => {} } } },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  } as unknown as ServerContext
  const off = await setupServer(ctx, {
    account: async () => ({ account: { key: "synthetic", host: "github.com", label: "Synthetic", token: "synthetic" } }),
    fetch: async (_url, init) => { signal = init?.signal; return new Promise(() => {}) },
  })
  const pending = handler({}, { signal: new AbortController().signal }); await tick()
  await off(); assert.equal(signal?.aborted, true); assert.equal((await pending).error, "disposed")
})
