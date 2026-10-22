import type { ProviderConfig } from './config.js';
import { type CommandRunner } from './command.js';
export interface Lease {
    readonly key: string;
    readonly generation: number;
    readonly expiresAt: number;
}
export interface ManagerOptions {
    readonly now?: () => number;
    readonly run?: CommandRunner;
}
/** One location-scoped instance; secrets never enter provider settings or storage. */
export declare class KeyManager {
    #private;
    constructor(configs: ReadonlyMap<string, ProviderConfig>, options?: ManagerOptions);
    ensureFresh(providerID: string): Promise<Lease>;
    isCurrent(providerID: string, lease: Lease): boolean;
    assertCurrent(providerID: string, lease: Lease): void;
    invalidate(providerID: string, used: Pick<Lease, 'generation' | 'key'>): void;
    dispose(): Promise<void>;
}
