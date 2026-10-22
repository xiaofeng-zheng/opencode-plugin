import { resolve } from 'node:path';
import { DynamicApiKeyError, invalidConfig } from './errors.js';
const fields = new Set(['command', 'cwd', 'env', 'ttlSeconds', 'refreshAheadSeconds', 'timeoutSeconds', 'allowedOrigins', 'header', 'prefix', 'format']);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const control = /[\p{Cc}\p{Cf}]/u;
export function isRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function seconds(value, field, zero = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0) || !Number.isFinite(value * 1000))
        invalidConfig(field);
    return value * 1000;
}
function provider(value, directory) {
    if (!isRecord(value) || Object.keys(value).some(key => !fields.has(key)))
        invalidConfig('providers.*');
    const command = value.command;
    if (typeof command === 'string') {
        if (!command.trim() || command.includes('\0'))
            invalidConfig('providers.*.command');
    }
    else if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !command[0]?.trim()) {
        invalidConfig('providers.*.command');
    }
    const cwd = value.cwd;
    if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')))
        invalidConfig('providers.*.cwd');
    const env = Object.create(null);
    if (value.env !== undefined) {
        if (!isRecord(value.env))
            invalidConfig('providers.*.env');
        for (const [name, item] of Object.entries(value.env)) {
            if (!name || /[=\0]/.test(name) || typeof item !== 'string' || item.includes('\0'))
                invalidConfig('providers.*.env');
            env[name] = item;
        }
    }
    const ttlMs = seconds(value.ttlSeconds, 'providers.*.ttlSeconds');
    const refreshAheadMs = seconds(value.refreshAheadSeconds === undefined ? 0 : value.refreshAheadSeconds, 'providers.*.refreshAheadSeconds', true);
    if (refreshAheadMs >= ttlMs)
        invalidConfig('providers.*.refreshAheadSeconds');
    const timeoutMs = seconds(value.timeoutSeconds === undefined ? 15 : value.timeoutSeconds, 'providers.*.timeoutSeconds');
    const origins = value.allowedOrigins;
    if (!Array.isArray(origins) || !origins.length)
        invalidConfig('providers.*.allowedOrigins');
    const allowedOrigins = [];
    for (const origin of origins) {
        if (typeof origin !== 'string')
            invalidConfig('providers.*.allowedOrigins');
        try {
            const parsed = new URL(origin);
            if (!['http:', 'https:'].includes(parsed.protocol) || origin !== parsed.origin || parsed.username || parsed.password)
                invalidConfig('providers.*.allowedOrigins');
        }
        catch {
            invalidConfig('providers.*.allowedOrigins');
        }
        if (!allowedOrigins.includes(origin))
            allowedOrigins.push(origin);
    }
    const header = value.header === undefined ? 'Authorization' : value.header;
    const prefix = value.prefix === undefined ? 'Bearer ' : value.prefix;
    const format = value.format === undefined ? 'text' : value.format;
    if (typeof header !== 'string' || !headerName.test(header))
        invalidConfig('providers.*.header');
    if (typeof prefix !== 'string' || control.test(prefix))
        invalidConfig('providers.*.prefix');
    if (format !== 'text' && format !== 'json')
        invalidConfig('providers.*.format');
    return Object.freeze({
        command: typeof command === 'string' ? command : Object.freeze([...command]),
        cwd: resolve(directory, cwd ?? '.'),
        env: Object.freeze(env), ttlMs, refreshAheadMs, timeoutMs,
        allowedOrigins: Object.freeze(allowedOrigins), header, prefix, format,
    });
}
export function parseConfig(options, directory) {
    if (!isRecord(options) || Object.keys(options).some(key => key !== 'providers'))
        invalidConfig('options');
    const providers = options.providers;
    if (!isRecord(providers) || Object.keys(providers).length === 0)
        invalidConfig('providers');
    const result = new Map();
    for (const [id, input] of Object.entries(providers)) {
        if (!id.trim() || control.test(id))
            invalidConfig('providers');
        result.set(id, provider(input, directory));
    }
    return result;
}
/** Validate the destination before even executing a credential command. */
export function assertAllowedOrigin(config, url, transport = 'http') {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password)
            throw new DynamicApiKeyError('origin');
        if (transport === 'ws') {
            if (parsed.protocol === 'wss:')
                parsed.protocol = 'https:';
            else if (parsed.protocol === 'ws:')
                parsed.protocol = 'http:';
            else
                throw new DynamicApiKeyError('origin');
        }
        else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            throw new DynamicApiKeyError('origin');
        if (!config.allowedOrigins.includes(parsed.origin))
            throw new DynamicApiKeyError('origin');
    }
    catch {
        throw new DynamicApiKeyError('origin');
    }
}
