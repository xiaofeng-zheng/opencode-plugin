import { empty, type ErrorCode, type Snapshot } from "./dto.ts"
import { parseQuota } from "./parser.ts"
import type { Account, AccountSource, AccountState } from "./account.ts"

export const USAGE_URL = "https://api.github.com/copilot_internal/user"
export interface ClientOptions {
  account: AccountSource
  fetch?: typeof globalThis.fetch
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}
type Entry = { snapshot?: Snapshot; success?: Snapshot; expires: number; backoff: number; pending?: Promise<Snapshot> }

/** No disk, credential logging, endpoint override, or inference calls. */
export class CreditsClient {
  private readonly fetcher: typeof globalThis.fetch
  private readonly now: () => number
  private readonly ttl: number
  private readonly timeout: number
  private readonly entries = new Map<string, Entry>()
  private readonly controllers = new Set<AbortController>()
  private dead = false
  private epoch = 0
  private current = ""
  private sourceQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.ttl = options.ttlMs ?? 300_000
    this.timeout = options.timeoutMs ?? 10_000
  }
  invalidate(): void {
    this.epoch++
    this.current = ""
    for (const controller of this.controllers) controller.abort()
    // Retain account-specific backoff, but never reuse a pre-switch snapshot.
    for (const e of this.entries.values()) { delete e.snapshot; delete e.success; delete e.pending; e.expires = 0 }
  }
  dispose(): void { this.dead = true; this.invalidate(); this.entries.clear() }
  private observe(): Promise<AccountState> {
    const read = this.sourceQueue.then(async (): Promise<AccountState> => {
      if (this.dead) return { error: "disposed" }
      let state: AccountState
      try { state = await this.options.account() } catch { state = { error: "unavailable" } }
      if (this.dead) return { error: "disposed" }
      const key = state.account?.key ?? ""
      if (key !== this.current) { this.invalidate(); this.current = key }
      return state
    })
    this.sourceQueue = read.then(() => undefined, () => undefined)
    return read
  }
  async get(input: { force?: boolean | undefined } = {}, signal?: AbortSignal): Promise<Snapshot> {
    if (signal?.aborted || this.dead) return empty("disposed")
    const state = await this.observe()
    if (!state.account) return empty(state.error)
    const account = state.account, epoch = this.epoch
    let e = this.entries.get(account.key)
    if (!e) {
      e = { expires: 0, backoff: 0 }
      this.entries.set(account.key, e)
    }
    if (e.snapshot && (this.now() < e.backoff || (!input.force && this.now() < e.expires))) return structuredClone(e.snapshot)
    if (!e.pending) {
      const entry = e
      const pending = this.request(account, entry, epoch)
      entry.pending = pending
      void pending.finally(() => { if (entry.pending === pending) delete entry.pending })
    }
    return this.wait(e.pending!, signal)
  }
  private async wait(pending: Promise<Snapshot>, signal?: AbortSignal): Promise<Snapshot> {
    if (!signal) return structuredClone(await pending)
    if (signal.aborted) return empty("disposed")
    let stop: () => void = () => {}
    const cancelled = new Promise<Snapshot>(resolve => { stop = () => resolve(empty("disposed")); signal.addEventListener("abort", stop, { once: true }) })
    try { return structuredClone(await Promise.race([pending, cancelled])) }
    finally { signal.removeEventListener("abort", stop) }
  }
  private failure(e: Entry, code: ErrorCode, account: Account): Snapshot {
    const s = e.success ? { ...e.success, status: "stale" as const, error: code } : empty(code, account.label)
    s.retryAt = e.backoff > this.now() ? new Date(e.backoff).toISOString() : null
    return s
  }
  private async request(account: Account, e: Entry, epoch: number): Promise<Snapshot> {
    if (this.now() < e.backoff) return this.failure(e, "rate_limited", account)
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeout)
    let result: Snapshot
    try {
      // Race explicitly, so even an injected transport that ignores AbortSignal is bounded.
      const abort = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))
      result = await Promise.race([this.fetchQuota(account, e, controller.signal), abort])
    } catch {
      result = this.failure(e, timedOut ? "timeout" : "network", account)
    } finally { clearTimeout(timer); this.controllers.delete(controller) }
    const active = await this.observe()
    if (this.dead) return empty("disposed")
    if (epoch !== this.epoch || active.account?.key !== account.key) return empty("account_changed")
    if (result.status === "ok") e.success = result
    else if (e.success && result.status !== "stale") result = this.failure(e, result.error ?? "invalid_data", account)
    e.snapshot = result
    e.expires = this.now() + (result.status === "ok" ? this.ttl : Math.min(this.ttl, 30_000))
    return result
  }
  private async fetchQuota(account: Account, e: Entry, signal: AbortSignal): Promise<Snapshot> {
    const response = await this.fetcher(USAGE_URL, {
      method: "GET", redirect: "error", signal,
      headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json", "User-Agent": "opencode-copilot-credits/0.1.0" },
    })
    if (!response.ok) {
      const retry = response.headers.get("retry-after")
      const rate = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") || retry !== null
      if (rate) {
        const delta = retry !== null && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : NaN
        const date = retry ? Date.parse(retry) : NaN
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000
        const until = Math.max(this.now() + 60_000, Number.isFinite(delta) ? this.now() + delta : 0, Number.isFinite(date) && !Number.isFinite(delta) ? date : 0, Number.isFinite(reset) ? reset : 0)
        e.backoff = Math.min(until, 253402300799000)
      }
      await response.body?.cancel()
      const code = rate ? "rate_limited" : response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "upstream"
      return this.failure(e, code, account)
    }
    // Limit body size as well as total request time. Never retain raw upstream responses.
    const reader = response.body?.getReader()
    if (!reader) return this.failure(e, "invalid_data", account)
    let length = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > 1_048_576) { await reader.cancel(); return this.failure(e, "invalid_data", account) }
        chunks.push(part.value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      return parseQuota(JSON.parse(new TextDecoder().decode(bytes)), this.now(), account.label)
    } catch { return this.failure(e, "invalid_data", account) }
    finally { reader.releaseLock() }
  }
}
