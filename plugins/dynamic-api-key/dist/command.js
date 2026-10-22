import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isRecord } from './config.js';
import { DynamicApiKeyError } from './errors.js';
export const OUTPUT_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 200;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** No shell for argv. A string explicitly opts into the platform shell. */
export const runCommand = (config, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
        reject(new DynamicApiKeyError('aborted'));
        return;
    }
    const posix = process.platform !== 'win32';
    let child;
    try {
        const options = {
            cwd: config.cwd,
            env: { ...process.env, ...config.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: posix,
            windowsHide: true,
        };
        child = typeof config.command === 'string'
            ? spawn(config.command, { ...options, shell: true })
            : spawn(config.command[0], [...config.command.slice(1)], { ...options, shell: false });
    }
    catch {
        reject(new DynamicApiKeyError('command'));
        return;
    }
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks = [];
    let failure;
    let settled = false;
    let closed = false;
    let terminating = false;
    let escalated = false;
    let timeout;
    let escalation;
    let hardStop;
    const deadline = performance.now() + config.timeoutMs;
    function erase() {
        for (const chunk of chunks)
            chunk.fill(0);
        chunks.length = 0;
    }
    function kill(sig) {
        try {
            if (posix && child.pid)
                process.kill(-child.pid, sig);
            else
                child.kill(sig); // Windows: best effort; no POSIX descendant guarantee.
        }
        catch { /* Already gone or spawn failed. Never expose the OS error. */ }
    }
    function groupExists() {
        if (!posix || !child.pid)
            return false;
        try {
            process.kill(-child.pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    function finish() {
        if (settled)
            return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(escalation);
        clearTimeout(hardStop);
        signal.removeEventListener('abort', abort);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.removeListener('close', onClose);
        child.stdout?.removeListener('data', onStdout);
        child.stderr?.removeListener('data', onStderr);
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (failure) {
            erase();
            reject(failure);
            return;
        }
        const data = Buffer.concat(chunks, stdoutBytes);
        try {
            resolve(new TextDecoder('utf-8', { fatal: true }).decode(data));
        }
        catch {
            reject(new DynamicApiKeyError('format'));
        }
        finally {
            data.fill(0);
            erase();
        }
    }
    function terminate() {
        if (terminating)
            return;
        terminating = true;
        clearTimeout(timeout);
        if (!child.pid) {
            finish();
            return;
        }
        kill('SIGTERM');
        // Do not cancel this when the direct child closes: resistant descendants
        // may still be alive in its process group with their stdio already closed.
        escalation = setTimeout(() => {
            kill('SIGKILL');
            escalated = true;
            if (closed)
                finish();
            else
                hardStop = setTimeout(finish, KILL_GRACE_MS);
        }, KILL_GRACE_MS);
    }
    function fail(code) {
        if (settled || failure)
            return;
        failure = new DynamicApiKeyError(code);
        erase();
        terminate();
    }
    function abort() { fail('aborted'); }
    function onError() { fail('command'); }
    function onExit(code, sig) {
        if (code !== 0 || sig !== null)
            fail('command');
    }
    function onClose(code, sig) {
        closed = true;
        if (code !== 0 || sig !== null)
            fail('command');
        if (failure || terminating) {
            if (escalated)
                finish();
            return;
        }
        // Also reap background descendants that closed their inherited pipes.
        if (groupExists())
            terminate();
        else
            finish();
    }
    function onStdout(chunk) {
        if (failure || settled)
            return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > OUTPUT_LIMIT) {
            fail('output');
            return;
        }
        chunks.push(Buffer.from(chunk));
    }
    function onStderr(chunk) {
        if (failure || settled)
            return;
        stderrBytes += chunk.length; // Drain, count, but never retain diagnostics.
        if (stderrBytes > OUTPUT_LIMIT)
            fail('output');
    }
    function armTimeout() {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
            fail('timeout');
            return;
        }
        timeout = setTimeout(armTimeout, Math.min(MAX_TIMER_MS, Math.max(1, remaining)));
    }
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted)
        abort();
    else
        armTimeout();
});
function key(value) {
    if (typeof value !== 'string' || !value || /[\s\p{Cc}\p{Cf}]/u.test(value))
        throw new DynamicApiKeyError('format');
    // Web Headers are ByteString. Reject values it cannot represent, safely.
    for (const char of value)
        if (char.charCodeAt(0) > 255)
            throw new DynamicApiKeyError('format');
    return value;
}
function absoluteExpiry(value) {
    if (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(value * 1000))
        return value * 1000;
    if (typeof value !== 'string')
        throw new DynamicApiKeyError('format');
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match)
        throw new DynamicApiKeyError('format');
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59)
        throw new DynamicApiKeyError('format');
    const result = Date.parse(value);
    if (!Number.isFinite(result))
        throw new DynamicApiKeyError('format');
    return result;
}
/** TTL and expiresIn start BEFORE spawn, never when a slow command completes. */
export function parseCommandOutput(output, config, startedAt, now) {
    let apiKey;
    let expiresAt = startedAt + config.ttlMs;
    if (config.format === 'text') {
        apiKey = key(output.replace(/\r?\n$/, ''));
    }
    else {
        let json;
        try {
            json = JSON.parse(output);
        }
        catch {
            throw new DynamicApiKeyError('format');
        }
        if (!isRecord(json) || Object.keys(json).some(field => !['apiKey', 'expiresAt', 'expiresIn'].includes(field)))
            throw new DynamicApiKeyError('format');
        apiKey = key(json.apiKey);
        if ('expiresAt' in json && 'expiresIn' in json)
            throw new DynamicApiKeyError('format');
        if ('expiresAt' in json)
            expiresAt = Math.min(expiresAt, absoluteExpiry(json.expiresAt));
        if ('expiresIn' in json) {
            if (typeof json.expiresIn !== 'number' || !Number.isFinite(json.expiresIn) || json.expiresIn <= 0 || !Number.isFinite(json.expiresIn * 1000))
                throw new DynamicApiKeyError('format');
            expiresAt = Math.min(expiresAt, startedAt + json.expiresIn * 1000);
        }
    }
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || now >= expiresAt - config.refreshAheadMs)
        throw new DynamicApiKeyError('expiry');
    return { key: apiKey, expiresAt };
}
