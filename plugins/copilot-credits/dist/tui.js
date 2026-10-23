import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { setupTui } from "./tui-controller.js";
export default Plugin.define({
  id: "copilot.credits.tui",
  setup(ctx) {
    const [line, publish] = createSignal("Copilot: loading…");
    return setupTui(ctx, value => (() => {
      var _el$ = _$createElement("text");
      _$setProp(_el$, "flexShrink", 1);
      _$insert(_el$, value);
      _$effect(_$p => _$setProp(_el$, "fg", ctx.theme.text.base, _$p));
      return _el$;
    })(), publish, line);
  }
});
