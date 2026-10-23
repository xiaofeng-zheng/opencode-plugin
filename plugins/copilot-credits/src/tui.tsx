import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { setupTui } from "./tui-controller.ts"

export default Plugin.define({
  id: "copilot.credits.tui",
  setup(ctx) {
    const [line, publish] = createSignal("Copilot: loading…")
    return setupTui(ctx, value => <text fg={ctx.theme.text.base} flexShrink={1}>{value()}</text>, publish, line)
  },
})
