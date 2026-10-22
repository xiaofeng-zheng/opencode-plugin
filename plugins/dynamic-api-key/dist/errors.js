/** Only fixed, non-secret diagnostics cross the plugin boundary. Never attach a cause. */
const messages = {
    command: 'credential command failed',
    timeout: 'credential command timed out',
    aborted: 'credential command aborted',
    output: 'credential command exceeded output limit',
    format: 'invalid credential output',
    expiry: 'credential is already unusable',
    origin: 'request origin is not allowed',
    lease: 'credential lease is not current; a new model call is required',
    disposed: 'plugin has been disposed',
    provider: 'provider is not configured',
    header: 'unable to set authentication header',
    setup: 'hook registration failed',
    cleanup: 'hook cleanup failed',
};
export class DynamicApiKeyError extends Error {
    code;
    constructor(code) {
        super(`dynamic-api-key: ${messages[code]}`);
        this.code = code;
        this.name = 'DynamicApiKeyError';
    }
}
export function invalidConfig(field) {
    // Callers pass hard-coded schema paths, not untrusted property names or values.
    throw new Error(`dynamic-api-key: invalid config field ${field}`);
}
