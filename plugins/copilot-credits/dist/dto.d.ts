import { z } from "zod";
export declare const ErrorCode: z.ZodEnum<{
    disconnected: "disconnected";
    unsupported: "unsupported";
    unavailable: "unavailable";
    unauthenticated: "unauthenticated";
    forbidden: "forbidden";
    not_found: "not_found";
    rate_limited: "rate_limited";
    upstream: "upstream";
    timeout: "timeout";
    network: "network";
    invalid_data: "invalid_data";
    account_changed: "account_changed";
    disposed: "disposed";
}>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export declare const SnapshotSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    source: z.ZodLiteral<"github-copilot-internal">;
    status: z.ZodEnum<{
        disconnected: "disconnected";
        unsupported: "unsupported";
        unavailable: "unavailable";
        ok: "ok";
        unknown: "unknown";
        stale: "stale";
    }>;
    error: z.ZodNullable<z.ZodEnum<{
        disconnected: "disconnected";
        unsupported: "unsupported";
        unavailable: "unavailable";
        unauthenticated: "unauthenticated";
        forbidden: "forbidden";
        not_found: "not_found";
        rate_limited: "rate_limited";
        upstream: "upstream";
        timeout: "timeout";
        network: "network";
        invalid_data: "invalid_data";
        account_changed: "account_changed";
        disposed: "disposed";
    }>>;
    account: z.ZodNullable<z.ZodString>;
    unit: z.ZodEnum<{
        unknown: "unknown";
        ai_credits: "ai_credits";
        premium_requests: "premium_requests";
        chat_requests: "chat_requests";
    }>;
    scope: z.ZodEnum<{
        unknown: "unknown";
        finite: "finite";
        pooled_or_unlimited: "pooled_or_unlimited";
    }>;
    bucket: z.ZodEnum<{
        unknown: "unknown";
        premium_interactions: "premium_interactions";
        chat: "chat";
    }>;
    used: z.ZodNullable<z.ZodNumber>;
    allowance: z.ZodNullable<z.ZodNumber>;
    remaining: z.ZodNullable<z.ZodNumber>;
    usedPercent: z.ZodNullable<z.ZodNumber>;
    approximate: z.ZodBoolean;
    legacyRemaining: z.ZodBoolean;
    absoluteCreditsUsed: z.ZodNullable<z.ZodNumber>;
    additionalUsed: z.ZodNullable<z.ZodNumber>;
    additionalAllowance: z.ZodNullable<z.ZodNumber>;
    additionalAllowed: z.ZodNullable<z.ZodBoolean>;
    poolHasQuota: z.ZodNullable<z.ZodBoolean>;
    resetAt: z.ZodNullable<z.ZodString>;
    fetchedAt: z.ZodNullable<z.ZodString>;
    retryAt: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export declare const safeLabel: (label: string) => string;
export declare function empty(error?: ErrorCode | null, account?: string | null): Snapshot;
