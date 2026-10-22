export interface ProviderConfig {
    readonly command: string | readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly ttlMs: number;
    readonly refreshAheadMs: number;
    readonly timeoutMs: number;
    readonly allowedOrigins: readonly string[];
    readonly header: string;
    readonly prefix: string;
    readonly format: 'text' | 'json';
}
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function parseConfig(options: unknown, directory: string): ReadonlyMap<string, ProviderConfig>;
/** Validate the destination before even executing a credential command. */
export declare function assertAllowedOrigin(config: ProviderConfig, url: string, transport?: 'http' | 'ws'): void;
