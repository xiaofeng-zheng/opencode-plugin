import { type ProviderConfig } from './config.js';
export declare const OUTPUT_LIMIT: number;
export type CommandRunner = (config: ProviderConfig, signal: AbortSignal) => Promise<string>;
/** No shell for argv. A string explicitly opts into the platform shell. */
export declare const runCommand: CommandRunner;
export interface IssuedKey {
    readonly key: string;
    readonly expiresAt: number;
}
/** TTL and expiresIn start BEFORE spawn, never when a slow command completes. */
export declare function parseCommandOutput(output: string, config: ProviderConfig, startedAt: number, now: number): IssuedKey;
