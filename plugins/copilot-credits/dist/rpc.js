import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { SnapshotSchema } from "./dto.js";
export const Credits = Rpc.define({
  id: "copilot.credits",
  methods: {
    get: {
      input: z.strictObject({
        force: z.boolean().optional()
      }),
      output: SnapshotSchema
    }
  },
  events: {}
});
