# Dynamic API key reference

For installation and updates, use the [plugin README](../README.md). This document covers provider configuration, command output, and runtime safety. For packaging or private-server tests, use the [integration guide](integration.md).

The plugin targets **OpenCode v2 Session** requests. It is ESM, declares Node.js >=20 for its runtime, and pins `@opencode/plugin@2.0.32`. Upstream Host-based package checks require **Node.js >=22.15**. Its default export is `Plugin.define({ id: 'dynamic-api-key', setup })`.

After loading, the first request for each configured provider obtains a key on demand. Keys remain in memory and replace the configured authentication header before Session HTTP sends and WebSocket handshakes. Rotation does not write `providers.openai.settings.apiKey`, call `provider.reload()`, or require a service restart. Initial loading and changes to options still depend on OpenCode; this is not a process-wide credential service or dynamic configuration reloader.

## Provider configuration

OpenCode v2 uses a `plugins` array with `{ "package": ..., "options": ... }` objects, not v1 tuples. Plugin options are not provider settings. Preserve existing plugins and provider definitions when making a separate configuration change.

Use the GitHub locator from the README as `package`. Native `opencode plugin add` manages the cache and global entry; configure options on that entry without replacing unrelated settings. Provider definitions remain separate.

### Existing OpenAI provider over HTTP

[examples/openai-http.json](../examples/openai-http.json) contains this complete configuration example:

```json
{
  "plugins": [
    {
      "package": "github:xiaofeng-zheng/opencode-plugins#main::path:plugins/dynamic-api-key",
      "options": {
        "providers": {
          "openai": {
            "command": ["/absolute/path/mint", "--plain"],
            "ttlSeconds": 3300,
            "refreshAheadSeconds": 60,
            "timeoutSeconds": 15,
            "allowedOrigins": ["https://api.openai.com"]
          }
        }
      }
    }
  ],
  "providers": {
    "openai": {
      "settings": { "transport": "http" }
    }
  }
}
```

These are example values, not a production credential setup. No real or placeholder key needs to be placed in provider settings. The synchronous provider transform marks only an **existing** target provider with activation `auto` as `enabled`. It does not create a provider, override `disabled`, or change settings/models. Later OpenCode configuration and policy still apply. For a configured/enabled native API-key provider with neither credentials nor a configured API key, OpenCode's `Auth.none` permits request construction before this plugin supplies the header.

### OpenAI WebSocket

The built-in OpenAI provider in v2.0.32 and v2.1.2 can use WebSocket by default; an HTTP hook alone is not full coverage. This plugin also registers `experimental.ws.handshake` and `experimental.ws.send`. The [WebSocket example](../examples/openai-websocket.json) changes the provider setting to:

```json
{ "providers": { "openai": { "settings": { "transport": "websocket" } } } }
```

`allowedOrigins` still contains **HTTP(S) origins**: `wss://api.openai.com/...` matches `https://api.openai.com`; `ws://host:port/...` matches `http://host:port`. Enable WebSocket only for providers that implement the relevant protocol. Chat Completions-compatible providers should use HTTP.

An existing OpenAI OAuth connection still determines protocol and endpoint. Replacing the configured authentication header does not turn an OAuth connection into an API-key connection. An endpoint outside the allowlist is rejected **before** the command runs. Prefer a separate compatible-provider alias when needed; do not widen the allowlist just to suppress an error.

### Custom native Chat Completions provider

[examples/custom-provider.json](../examples/custom-provider.json) defines the `rotating-compatible` alias using `@opencode/ai/providers/openai/chat`, HTTP transport, and `http://127.0.0.1:8787/v1`. Its plugin options use JSON command output, `ttlSeconds: 240`, `refreshAheadSeconds: 20`, `timeoutSeconds: 5`, and `allowedOrigins: ["http://127.0.0.1:8787"]`.

The `probe` model, port, and demo key are **local test placeholders**. The example neither starts a mock upstream nor requests a real model. Production use requires a chosen provider ID, trusted `baseURL`, real model definitions, and a trusted credential program. The IDs in the plugin's `providers` options and OpenCode's `providers` definitions must match; one does not replace the other.

## Command and output

### Prefer an argv array

```json
{
  "command": ["/absolute/path/to/node", "/absolute/path/mint-key.mjs", "--plain"],
  "ttlSeconds": 3300,
  "allowedOrigins": ["https://api.openai.com"]
}
```

The first item is the executable; remaining arguments are passed unchanged. There is no `$VAR`, `~`, pipe, or redirection expansion. Use absolute executable paths, and never put the key itself in argv. Optional `cwd` resolves relative to `ctx.location.directory`; omitting it uses that location directory.

### Explicit shell strings

```json
{
  "command": "exec /absolute/path/mint-key --plain",
  "ttlSeconds": 3300,
  "allowedOrigins": ["https://api.openai.com"]
}
```

A string explicitly selects the platform shell: normally `/bin/sh` on POSIX, or Node's default shell / `ComSpec` on Windows. This is not an interactive login shell and need not load `.bashrc`. You are responsible for quoting and expansion. Never concatenate message content, model output, or untrusted project input into a command. Windows behavior here describes the API contract, not verified Windows runtime support.

### Text output (default)

Stdout must contain **one nonempty, header-compatible key without whitespace or control characters**. No final newline, one LF, or one CRLF is accepted. The plugin does not `trim()` the key; leading/trailing spaces, multiple blank lines, debug output, and ANSI control sequences are rejected. Web Headers use ByteString, so unrepresentable Unicode characters are also rejected safely.

### JSON output

Set `"format": "json"`. Stdout must be one JSON object with an optional expiry in one of these forms:

```json
{ "apiKey": "EXAMPLE_ONLY_NOT_A_REAL_KEY", "expiresIn": 300 }
```

```json
{ "apiKey": "EXAMPLE_ONLY_NOT_A_REAL_KEY", "expiresAt": "2030-01-01T00:00:00Z" }
```

`expiresAt` can also be a finite UNIX timestamp in **seconds**, not milliseconds. ISO dates need a complete time and timezone. `expiresIn` is a finite positive number of seconds and may be fractional. Omit both to use TTL alone; providing both or unknown fields is rejected. The key follows the same rules as text output, including no embedded newline.

Expiry is `min(command start time + ttlSeconds, command-reported expiry)`. `expiresIn` also starts at **command start**, not completion. Slow execution and termination cleanup count toward TTL. A result already expired or inside the refresh-ahead window is rejected without caching it or allowing a send. Example expiries do not establish a real credential's lifetime; the program must report trustworthy expiry information.

The [demo command](../examples/mint-demo.mjs) emits only a fixed fictional string, without network access:

```sh
node examples/mint-demo.mjs --plain
node examples/mint-demo.mjs --json
```

Run these from the plugin source directory only when intentionally exploring the example; they are not installation checks or real credential validation.

## Complete options

The top-level options object accepts only `providers`, a required nonempty record. Each provider has independent settings:

| Field | Required / default | Validation and meaning |
| --- | --- | --- |
| `command` | Required | Nonempty argv string array or shell string; no NUL; the first array item must be nonempty. |
| `ttlSeconds` | Required | Finite positive seconds; fractional values are accepted; conversion to milliseconds must also be finite. |
| `refreshAheadSeconds` | `0` | Finite, with `0 <= ahead < ttl`. |
| `timeoutSeconds` | `15` | Finite positive command timeout in seconds; fractional values are accepted. |
| `allowedOrigins` | Required | Nonempty array of exact HTTP(S) **canonical origins**, without userinfo, path, query, or fragment. |
| `cwd` | Location directory | Optional nonempty directory, resolved relative to `ctx.location.directory`. |
| `env` | `{}` | String record overlaid on the OpenCode **server process** environment, not the client's terminal environment. |
| `header` | `Authorization` | Valid HTTP token name; replacement is case-insensitive. |
| `prefix` | `Bearer ` | May be empty; no control characters; the final value must be a valid Web Header. |
| `format` | `text` | Only `text` or `json`. |

For example, `"header": "x-api-key", "prefix": ""` replaces only that header. An existing `Authorization` header remains unchanged.

Canonical examples are `https://api.openai.com` and `http://127.0.0.1:8787`. A trailing `/`, uppercase hostname, default port `:443`, wildcard, path, or credentials is rejected; provide the URL's canonical `origin`. Requests themselves may contain normal API paths and queries. The destination origin is checked before command execution. Prefer HTTPS in production; allowing HTTP explicitly trusts a plaintext network. The examples use only loopback HTTP.

Unknown configuration fields, wrong types, and invalid ranges fail setup. Errors use fixed schema paths such as `providers.*.ttlSeconds`, not the provider ID, command, environment, or input values.

## TTL, concurrency, and failure behavior

- **Refresh is on demand, not on a timer.** Startup does not execute the command. At `now >= expiresAt - refreshAheadSeconds`, the lease is unusable for new sends; the next request obtains a new key. Idle periods neither mint keys nor contact the upstream.
- Concurrent refreshes for the same provider within one location/plugin instance share one Promise. Providers are isolated from one another. Multiple locations/instances do not share a global cross-process cache.
- Starting a refresh discards the previous lease. Command failure, timeout, invalid output, or expiry blocks the request, with **no fallback** even if the old key had not reached its actual expiry. A later request can run the command again; there is no permanent circuit breaker or hidden retry.
- Every actual Session HTTP hook send calls `ensureFresh`, including OpenCode's own physical retries, rather than changing the key only during initial model resolution.
- HTTP 401 invalidates only the generation/key recorded for that request. A late 401 from an older request does not clear a newer generation. The plugin does not replay HTTP requests, alter responses, or retry automatically, avoiding duplicate side effects. OpenCode's retry policy is separate.
- The WebSocket handshake runs for each model call, removes every case variant of the configured header, and writes the current key. Identical headers permit native socket reuse; changed headers change affinity and reconnect.
- WebSocket send **validates but does not refresh**. An expired, refresh-ahead, invalidated, or rotated handshake lease blocks sending, even if the next generation happens to contain the same key. The next model call needs a new handshake; a key in memory does not reauthenticate an old socket.
- WebSocket state is conservatively keyed by provider/session/kind, with at most 1024 LRU entries. Sending from an evicted session is rejected. Native Session handling serializes socket exchanges; because hooks have no exchange/socket ID, overlapping handshakes or a preceding handshake that never sent are rejected and state is cleared. A later new call can recover. A connection failure before send can therefore cause one extra rejection rather than use an uncertain identity.
- An in-flight stream is **not forcibly interrupted** when TTL expires. These are pre-send gates, not guarantees that every physical byte clears later JS scheduling, body conversion, or socket queues before an exact millisecond deadline. Leave an appropriate refresh-ahead margin.
- Cleanup closes the send gates first, aborts a pending credential child, removes registrations, and clears key/WebSocket/request references. Late command completion cannot reactivate a disposed plugin.

## Server environment and safety

The command executes as the **OpenCode server's OS user**, with that user's permissions. It does not automatically execute on the client's machine or prompt for OpenCode model-tool permission. A service's `PATH`, working directory, and environment often differ from an interactive terminal. Use absolute executable paths and ensure the server account can read/execute the required files.

`env` is overlaid only when spawning and does not modify global `process.env`. Exporting a variable in a client terminal does not update an already running server's inherited environment. Keep rotating credentials in a controlled source read by the credential program, rather than relying on client-side exports.

- Configuring a command grants code-execution authority. Trust and review the configuration, scripts, and directory permissions. Prefer argv; review shell strings. Prevent untrusted repositories from replacing the program, and honor administrative policy.
- Stdout and stderr are each limited to **64 KiB**. Stderr is drained without retention or printing. Nonzero exit, spawn failure, timeout, abort, and invalid output produce sanitized errors without a raw Error `cause` or command output. Timeout includes a short termination/escalation cleanup period; return is not guaranteed at the exact timeout millisecond.
- POSIX execution uses a separate process group, terminated with SIGTERM then SIGKILL, including descendants in that group. An early direct-child exit does not cancel necessary escalation. Commands must not daemonize or escape using `setsid`; this is not an OS sandbox.
- Windows termination is best-effort for the child, without a Job Object-level whole-tree guarantee. Subprocess checks here are Linux-based. Upstream Host checks require Node >=22.15 and are skipped on Node 20; the runtime does not import that Host tool.
- Real keys exist in memory, command output, and request headers, not provider/model settings, storage, credential records, or user configuration. Clearing references/Buffers cannot guarantee physical erasure of every JS string. Other plugins, proxies, upstreams, and transport logs are outside this plugin's redaction control; keep authentication headers out of those logs.
- The allowlist checks only the URL seen by the hook. It is not a DNS or network sandbox. Later plugins can change URLs/headers, lower-level redirects can cross origins, and custom SDKs can bypass hooks. Audit those paths separately; do not trust endpoints that redirect or forward custom authentication headers unexpectedly.

### Coverage boundary

| Path | Scope |
| --- | --- |
| Ordinary Session HTTP: primary, title, compaction, `session.generate`, and its HTTP retries | Provider-scoped `http.request` / `http.response` hooks. |
| Native Session WebSocket and HTTP fallback | Handshake/send guards; HTTP fallback still uses the HTTP hook. |
| Sessionless `ctx.generate.text` / API `generate.text` | **Unsupported**; they bypass Session hooks. |
| Arbitrary third-party SDKs, custom fetch, or other plugin combinations | No blanket coverage claim; verify the specific transport. |
| Existing in-flight streams | No forced interruption or reauthentication. |

There is no `event.request.settings.apiKey` or `model.error` hook to use here. The HTTP hook runs after native authentication and is awaited before the handler; throwing blocks the send. **Later registered plugins can still overwrite headers**: there is no absolute last-writer priority. Invalid configuration causes setup failure, so verify actual loading when activation is authorized. This plugin cannot protect traffic if the host ignores or disables it.
