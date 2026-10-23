import type { Context } from "@opencode/plugin/promise/plugin";
import { type ErrorCode } from "./dto.js";
export type Account = {
    key: string;
    label: string;
    host: "github.com";
    token: string;
};
export type AccountState = {
    account: Account;
    error?: never;
} | {
    account?: never;
    error: ErrorCode;
};
export type AccountSource = () => Promise<AccountState>;
type Connections = Context["integration"]["connection"];
/** Native Copilot stores the GitHub user OAuth token in refresh, not a session access token. */
export declare function createAccountSource(connections: Connections): AccountSource;
export {};
