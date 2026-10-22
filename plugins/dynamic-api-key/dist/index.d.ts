import { Plugin } from '@opencode/plugin';
import { type ManagerOptions } from './key-manager.js';
export declare const WS_LEASE_LIMIT = 1024;
/** Dependencies are injectable for focused tests; production uses the real runner and clock. */
export declare function setupDynamicApiKey(ctx: Plugin.Context, dependencies?: ManagerOptions): Promise<Plugin.Cleanup>;
declare const _default: Plugin.Plugin;
export default _default;
