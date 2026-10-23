import { Plugin } from "@opencode/plugin";
import { createAccountSource } from "./account.js";
import { CreditsClient } from "./client.js";
import { Credits } from "./rpc.js";
import { seconds } from "./options.js";
export async function setupServer(ctx, dependencies = {}) {
  const client = new CreditsClient({
    account: createAccountSource(ctx.integration.connection),
    ttlMs: seconds(ctx.options, "cacheTtlSeconds", 300, 30, 3600),
    timeoutMs: seconds(ctx.options, "timeoutSeconds", 10, 1, 30),
    ...dependencies
  });
  const events = new AbortController();
  try {
    const registration = await ctx.rpc.register(Credits, {
      get: (input, call) => client.get(input, call.signal)
    });
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: events.signal
        })) {
          if (event.type === "credential.switched" && event.data.integrationID === "github-copilot") client.invalidate();
        }
      } catch {
        if (!events.signal.aborted) client.invalidate();
      }
    })();
    return async () => {
      events.abort();
      client.dispose();
      await registration.dispose();
    };
  } catch {
    events.abort();
    client.dispose();
    throw new Error("Copilot credits RPC registration failed");
  }
}
export default Plugin.define({
  id: "copilot.credits.server",
  setup: ctx => setupServer(ctx)
});
