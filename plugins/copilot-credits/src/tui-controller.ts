import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid"
import { Credits } from "./rpc.ts"
import { empty, SnapshotSchema, type Snapshot } from "./dto.ts"
import { details, footer } from "./format.ts"
import { seconds } from "./options.ts"

/** Host APIs remain real; the view factory is injectable for no-renderer contract tests. */
export function setupTui(ctx: Context, view: (line: () => string) => JSX.Element, publish: (line: string) => void, line: () => string) {
  const rpc = ctx.client.rpc(Credits)
  let snapshot: Snapshot = empty()
  let generation = 0, disposed = false
  const pending = new Set<AbortController>()
  async function refresh(force = false) {
    const id = ++generation
    const controller = new AbortController()
    pending.add(controller)
    const location = ctx.location ?? ctx.data.location.default()
    publish("Copilot: loading…")
    try {
      const result = SnapshotSchema.parse(await rpc.get({ force }, { location, signal: controller.signal }))
      if (id !== generation || disposed) return
      const current = ctx.location ?? ctx.data.location.default()
      if (current.directory !== location.directory || current.workspaceID !== location.workspaceID) {
        snapshot = empty("account_changed")
      } else snapshot = result
    } catch {
      if (id !== generation || disposed) return
      // A failed RPC cannot confirm account identity; do not resurrect a client-side balance.
      snapshot = { ...empty("unavailable"), status: "unavailable" }
    } finally { pending.delete(controller) }
    if (!disposed && id === generation) publish(footer(snapshot))
  }
  const unregister: Array<() => void> = []
  let timer: ReturnType<typeof setInterval> | undefined
  const cleanup = () => {
    disposed = true; generation++
    if (timer) clearInterval(timer)
    for (const controller of pending) controller.abort()
    for (const off of unregister.reverse()) off()
  }
  try {
    unregister.push(ctx.ui.slot({ append: "home.footer.status", render: () => view(line) }))
    unregister.push(ctx.ui.slot({ append: "sidebar.content", render: () => view(line) }))
    unregister.push(ctx.data.on("credential.switched", event => {
      if (event.data.integrationID !== "github-copilot") return
      generation++; snapshot = empty("account_changed")
      for (const controller of pending) controller.abort()
      publish(footer(snapshot)); void refresh()
    }))
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "copilot.credits.show", title: "Copilot credits", palette: true, slash: { name: "copilot" },
      run: async () => {
        if (disposed) return
        await refresh(true)
        if (!disposed) await ctx.ui.dialog.alert({ title: "Copilot credits", message: details(snapshot) })
      },
    }] }))
    const interval = seconds(ctx.options, "refreshSeconds", 300, 30, 3600)
    if (ctx.options.refreshSeconds !== 0) timer = setInterval(() => void refresh(), interval)
    void refresh()
    return cleanup
  } catch { cleanup(); throw new Error("Copilot credits TUI registration failed") }
}
