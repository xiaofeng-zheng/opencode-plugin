/** Only fixed, non-secret diagnostics cross the plugin boundary. Never attach a cause. */
declare const messages: {
    readonly command: "credential command failed";
    readonly timeout: "credential command timed out";
    readonly aborted: "credential command aborted";
    readonly output: "credential command exceeded output limit";
    readonly format: "invalid credential output";
    readonly expiry: "credential is already unusable";
    readonly origin: "request origin is not allowed";
    readonly lease: "credential lease is not current; a new model call is required";
    readonly disposed: "plugin has been disposed";
    readonly provider: "provider is not configured";
    readonly header: "unable to set authentication header";
    readonly setup: "hook registration failed";
    readonly cleanup: "hook cleanup failed";
};
export declare class DynamicApiKeyError extends Error {
    readonly code: keyof typeof messages;
    constructor(code: keyof typeof messages);
}
export declare function invalidConfig(field: string): never;
export {};
