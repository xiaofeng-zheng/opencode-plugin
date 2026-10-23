import { type Snapshot } from "./dto.js";
export declare function record(value: unknown): Record<string, unknown>;
export declare function numeric(value: unknown): number | null;
/** Pure whitelist mapper. No plan/date guessing and no summing unrelated buckets. */
export declare function parseQuota(value: unknown, now: number, account?: string | null): Snapshot;
