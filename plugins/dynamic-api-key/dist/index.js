import { Plugin } from '@opencode/plugin';
import { assertAllowedOrigin, parseConfig } from './config.js';
import { DynamicApiKeyError } from './errors.js';
import { KeyManager } from './key-manager.js';
export const WS_LEASE_LIMIT = 1024;
function headerValue(config, lease) {
    try {
        // Validate the actual Web Header representation before either transport.
        return new Headers([[config.header, config.prefix + lease.key]]).get(config.header);
    }
    catch {
        throw new DynamicApiKeyError('header');
    }
}
/** Dependencies are injectable for focused tests; production uses the real runner and clock. */
export async function setupDynamicApiKey(ctx, dependencies = {}) {
    const configs = parseConfig(ctx.options, ctx.location.directory);
    const manager = new KeyManager(configs, dependencies);
    const registrations = [];
    let requests = new WeakMap();
    const sockets = new Map();
    let disposed = false;
    let disposal;
    const active = () => { if (disposed)
        throw new DynamicApiKeyError('disposed'); };
    const socketKey = (provider, session, kind) => JSON.stringify([provider, session, kind]);
    function remember(id, socket) {
        sockets.delete(id);
        sockets.set(id, socket);
        while (sockets.size > WS_LEASE_LIMIT)
            sockets.delete(sockets.keys().next().value);
    }
    const cleanup = () => {
        if (disposal)
            return disposal;
        // Close the gate synchronously before any asynchronous unregistering.
        disposed = true;
        sockets.clear();
        requests = new WeakMap();
        const stopped = manager.dispose();
        disposal = Promise.allSettled([
            stopped,
            ...registrations.reverse().map(async (registration) => { await registration.dispose(); }),
        ]).then(results => {
            registrations.length = 0;
            if (results.some(result => result.status === 'rejected'))
                throw new DynamicApiKeyError('cleanup');
        });
        return disposal;
    };
    try {
        registrations.push(await ctx.provider.transform(editor => {
            if (disposed)
                return;
            for (const id of configs.keys()) {
                if (editor.get(id)?.provider.activation !== 'auto')
                    continue;
                editor.update(id, provider => {
                    if (provider.activation === 'auto')
                        provider.activation = 'enabled';
                });
            }
            // No new providers, no apiKey/settings mutation, no reload. OpenCode's
            // subsequent configuration/policy transforms retain their authority.
        }));
        for (const [providerID, config] of configs) {
            registrations.push(await ctx.session.hook('http.request', async (event) => {
                active();
                assertAllowedOrigin(config, event.request.url);
                if (event.request.signal.aborted)
                    throw new DynamicApiKeyError('aborted');
                const lease = await manager.ensureFresh(providerID);
                active();
                assertAllowedOrigin(config, event.request.url);
                if (event.request.signal.aborted)
                    throw new DynamicApiKeyError('aborted');
                manager.assertCurrent(providerID, lease);
                const value = headerValue(config, lease);
                try {
                    event.request.headers.set(config.header, value);
                }
                catch {
                    throw new DynamicApiKeyError('header');
                }
                // Mutate only Headers; never reconstruct/consume the Request body.
                requests.set(event.request, { providerID, lease, value });
            }, { providerID }));
            registrations.push(await ctx.session.hook('http.response', event => {
                const used = requests.get(event.request);
                requests.delete(event.request);
                if (!disposed && event.response.status === 401 && used?.providerID === providerID
                    && event.request.headers.get(config.header) === used.value)
                    manager.invalidate(providerID, used.lease);
                // Preserve the original response, and do not replay any HTTP request.
            }, { providerID }));
            registrations.push(await ctx.session.hook('experimental.ws.handshake', async (event) => {
                active();
                const id = socketKey(providerID, event.sessionID, event.kind);
                const previous = sockets.get(id);
                sockets.delete(id); // A failed new handshake cannot borrow an older lease.
                assertAllowedOrigin(config, event.url, 'ws');
                // Native Session transport serializes exchanges. With no exchange/socket
                // ID on send, overlapping pre-send handshakes are ambiguous: reject both.
                if (previous && !previous.sent)
                    throw new DynamicApiKeyError('lease');
                const socket = { lease: undefined, sent: false };
                remember(id, socket);
                try {
                    const lease = await manager.ensureFresh(providerID);
                    active();
                    assertAllowedOrigin(config, event.url, 'ws');
                    manager.assertCurrent(providerID, lease);
                    if (sockets.get(id) !== socket)
                        throw new DynamicApiKeyError('lease');
                    const value = headerValue(config, lease);
                    event.headers = {
                        ...Object.fromEntries(Object.entries(event.headers).filter(([name]) => name.toLowerCase() !== config.header.toLowerCase())),
                        [config.header]: value,
                    };
                    socket.lease = lease;
                }
                catch (error) {
                    if (sockets.get(id) === socket)
                        sockets.delete(id);
                    if (error instanceof DynamicApiKeyError)
                        throw new DynamicApiKeyError(error.code);
                    throw new DynamicApiKeyError('lease');
                }
            }, { providerID }));
            registrations.push(await ctx.session.hook('experimental.ws.send', event => {
                active();
                const id = socketKey(providerID, event.sessionID, event.kind);
                const socket = sockets.get(id);
                if (!socket?.lease || !manager.isCurrent(providerID, socket.lease)) {
                    sockets.delete(id);
                    throw new DynamicApiKeyError('lease');
                }
                socket.sent = true;
                remember(id, socket);
                // Never refresh here: a new key cannot authenticate an already-open socket.
                // Leave the provider's frame entirely untouched.
            }, { providerID }));
        }
        return cleanup;
    }
    catch {
        await cleanup().catch(() => undefined);
        throw new DynamicApiKeyError('setup');
    }
}
export default Plugin.define({ id: 'dynamic-api-key', setup: ctx => setupDynamicApiKey(ctx) });
