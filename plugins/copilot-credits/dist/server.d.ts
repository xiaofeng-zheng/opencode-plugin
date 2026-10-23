import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { type ClientOptions } from "./client.js";
export declare function setupServer(ctx: Context, dependencies?: Partial<ClientOptions>): Promise<() => Promise<void>>;
declare const _default: Plugin.Plugin;
export default _default;
