import { type Snapshot } from "./dto.js";
import type { AccountSource } from "./account.js";
export declare const USAGE_URL = "https://api.github.com/copilot_internal/user";
export interface ClientOptions {
    account: AccountSource;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    ttlMs?: number;
    timeoutMs?: number;
}
/** No disk, credential logging, endpoint override, or inference calls. */
export declare class CreditsClient {
    private readonly options;
    private readonly fetcher;
    private readonly now;
    private readonly ttl;
    private readonly timeout;
    private readonly entries;
    private readonly controllers;
    private dead;
    private epoch;
    private current;
    private sourceQueue;
    constructor(options: ClientOptions);
    invalidate(): void;
    dispose(): void;
    private observe;
    get(input?: {
        force?: boolean | undefined;
    }, signal?: AbortSignal): Promise<Snapshot>;
    private wait;
    private failure;
    private request;
    private fetchQuota;
}
