import type { Context } from "@opencode/plugin/promise/plugin"
import { safeLabel, type ErrorCode } from "./dto.ts"
import { record } from "./parser.ts"

export type Account = { key: string; label: string; host: "github.com"; token: string }
export type AccountState = { account: Account; error?: never } | { account?: never; error: ErrorCode }
export type AccountSource = () => Promise<AccountState>
type Connections = Context["integration"]["connection"]
type Connection = Awaited<ReturnType<Connections["active"]>>
const identity = (c: Connection) => !c ? "" : c.type === "credential" ? `credential:${c.id}` : `env:${c.name}`

/** Native Copilot stores the GitHub user OAuth token in refresh, not a session access token. */
export function createAccountSource(connections: Connections): AccountSource {
  return async () => {
    const c = await connections.active("github-copilot")
    if (!c) return { error: "disconnected" }
    if (c.type !== "credential" || c.method !== "oauth") return { error: "unsupported" }
    const value = await connections.resolve(c)
    if (identity(c) !== identity(await connections.active("github-copilot"))) return { error: "account_changed" }
    if (!value) return { error: "disconnected" }
    if (value.type !== "oauth" || (value.methodID !== undefined && value.methodID !== "device")) return { error: "unsupported" }
    const meta = record(value.metadata)
    // Unknown metadata may encode a deployment we do not understand: fail closed.
    if (Object.keys(meta).some(k => !["apiEndpoint", "enterpriseUrl"].includes(k)) || meta.enterpriseUrl !== undefined) return { error: "unsupported" }
    if (meta.apiEndpoint !== undefined) {
      if (typeof meta.apiEndpoint !== "string") return { error: "unsupported" }
      try {
        const url = new URL(meta.apiEndpoint)
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
          !["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"].includes(url.hostname)) return { error: "unsupported" }
      } catch { return { error: "unsupported" } }
    }
    if (!value.refresh || /[\s\p{Cc}\p{Cf}]/u.test(value.refresh)) return { error: "unsupported" }
    return { account: { key: `${identity(c)}@github.com`, label: safeLabel(c.label), host: "github.com", token: value.refresh } }
  }
}
