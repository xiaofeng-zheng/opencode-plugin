/** Real loopback OpenAI wire fixture; no provider/plugin API is mocked. */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';

export const ASSISTANT_TEXT = 'DYNAMIC_KEY_OK';
const MAX_BYTES = 2 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function safeAuth(value) {
  if (value == null) return null;
  return /^(?:Bearer |Token )?DUMMY_[A-Z0-9_]+$/.test(String(value))
    ? String(value) : '[REDACTED_UNEXPECTED_AUTH]';
}

export function encodeFrame(payload, { opcode = 1, masked = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length > MAX_BYTES) throw new Error('fixture frame too large');
  const extra = data.length < 126 ? 0 : data.length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (masked ? 0x80 : 0) | (extra === 0 ? data.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(data.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(data.length), 2);
  if (!masked) return Buffer.concat([header, data]);
  const mask = randomBytes(4);
  mask.copy(header, 2 + extra);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([header, body]);
}

/** Handles masking, TCP splits, continuation frames, close and ping/pong. */
export function frameReader(onFrame, { requireMask = false } = {}) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_BYTES + 14) throw new Error('fixture receive limit');
    while (buffer.length >= 2) {
      const first = buffer[0];
      const masked = !!(buffer[1] & 0x80);
      if ((first & 0x70) || (requireMask && !masked)) throw new Error('invalid fixture WS flags');
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_BYTES)) throw new Error('fixture frame limit');
        length = Number(big); offset = 10;
      }
      if (length > MAX_BYTES) throw new Error('fixture frame limit');
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[maskOffset + i % 4];
      buffer = buffer.subarray(offset + length);
      let opcode = first & 0x0f;
      if (opcode >= 8) {
        if (!(first & 0x80) || length > 125) throw new Error('invalid control frame');
        onFrame({ opcode, payload });
        continue;
      }
      if (opcode === 0) {
        if (!fragmentOpcode) throw new Error('unexpected continuation');
        fragments.push(payload);
      } else {
        if (fragmentOpcode) throw new Error('overlapping fragmented frame');
        fragments = [payload]; fragmentOpcode = opcode;
      }
      if (fragments.reduce((sum, x) => sum + x.length, 0) > MAX_BYTES) throw new Error('fragment limit');
      if (!(first & 0x80)) continue;
      opcode = fragmentOpcode;
      const full = Buffer.concat(fragments);
      fragments = []; fragmentOpcode = undefined;
      onFrame({ opcode, payload: full });
    }
  };
}

export function responsesEvents(id, model = 'probe') {
  const itemID = `msg_${id}`;
  const part = { type: 'output_text', text: ASSISTANT_TEXT, annotations: [], logprobs: [] };
  const item = { id: itemID, type: 'message', status: 'completed', role: 'assistant', content: [part] };
  const response = {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), model,
    status: 'completed', output: [item], error: null, incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: itemID, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: itemID, output_index: 0, content_index: 0, delta: ASSISTANT_TEXT, logprobs: [] },
    { type: 'response.output_text.done', item_id: itemID, output_index: 0, content_index: 0, text: ASSISTANT_TEXT, logprobs: [] },
    { type: 'response.content_part.done', item_id: itemID, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

export async function createMockOpenAI() {
  const requests = [];
  const upgrades = [];
  const errors = [];
  const sockets = new Set();
  const timers = new Set();
  const controls = {
    unauthorized: new Map(),
    upgradeDelay: new Map(),
    // A WS success can never be an unnoticed Responses-over-HTTP fallback.
    denyHttp: new Set(['rotating-ws', 'rotating-ws-guard']),
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    let provider = String(req.headers['x-integration-provider'] ?? 'fixture-self-test');
    const entry = {
      seq: requests.length + 1, at: Date.now(), provider, method: req.method, path: req.url,
      authorization: safeAuth(req.headers.authorization), apiKeyHeader: safeAuth(req.headers['x-api-key']),
      status: 0,
    };
    requests.push(entry);
    try {
      let length = 0; const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BYTES) throw new Error('fixture HTTP body limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      entry.model = body.model;
      entry.stream = body.stream === true;
      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(req.url) || body.model !== 'probe') {
        entry.status = 400;
        return json(res, 400, { error: { message: 'DUMMY_UNEXPECTED_ROUTE_OR_MODEL', type: 'invalid_request_error' } });
      }
      if (controls.denyHttp.has(provider)) {
        entry.status = 400;
        return json(res, 400, { error: { message: 'DUMMY_WS_HTTP_FALLBACK_FORBIDDEN', type: 'invalid_request_error' } });
      }
      if ((controls.unauthorized.get(provider) ?? 0) > 0) {
        controls.unauthorized.set(provider, controls.unauthorized.get(provider) - 1);
        entry.status = 401;
        return json(res, 401, { error: { message: 'DUMMY_EXPECTED_401', type: 'invalid_api_key', code: 'invalid_api_key' } });
      }
      entry.status = 200;
      const id = `resp_dummy_${entry.seq}`;
      if (req.url === '/v1/responses') {
        const events = responsesEvents(id);
        if (!body.stream) return json(res, 200, events.at(-1).response);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        return res.end();
      }
      const common = { id: `chatcmpl_dummy_${entry.seq}`, created: Math.floor(Date.now() / 1000), model: 'probe' };
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if (!body.stream) return json(res, 200, { ...common, object: 'chat.completion', choices: [
        { index: 0, message: { role: 'assistant', content: ASSISTANT_TEXT }, finish_reason: 'stop' },
      ], usage });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (value) => res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', ...value })}\n\n`);
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: ASSISTANT_TEXT }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
      res.end('data: [DONE]\n\n');
    } catch {
      errors.push('DUMMY_INVALID_HTTP_REQUEST');
      entry.status = 400;
      if (!res.headersSent) json(res, 400, { error: { message: 'DUMMY_INVALID_HTTP_REQUEST' } });
      else res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    const provider = String(req.headers['x-integration-provider'] ?? 'fixture-self-test');
    const entry = {
      connectionID: upgrades.length + 1, provider, requestedAt: Date.now(), path: req.url,
      authorization: safeAuth(req.headers.authorization), frames: [], acceptedAt: null, closedAt: null,
    };
    upgrades.push(entry);
    socket.on('close', () => { entry.closedAt = Date.now(); });
    if (req.url !== '/v1/responses' || !req.headers['sec-websocket-key']) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = () => {
      if (socket.destroyed) return;
      const hash = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`);
      entry.acceptedAt = Date.now();
      const read = frameReader(({ opcode, payload }) => {
        if (opcode === 8) { socket.end(encodeFrame(payload, { opcode: 8 })); return; }
        if (opcode === 9) { socket.write(encodeFrame(payload, { opcode: 10 })); return; }
        if (opcode === 10) return;
        if (opcode !== 1) throw new Error('fixture requires text frames');
        const body = JSON.parse(payload.toString('utf8'));
        const frame = { at: Date.now(), type: body.type, model: body.model };
        entry.frames.push(frame);
        if (body.type !== 'response.create' || body.model !== 'probe') throw new Error('invalid Responses frame');
        const responseID = `resp_ws_${entry.connectionID}_${entry.frames.length}`;
        frame.responseID = responseID;
        for (const event of responsesEvents(responseID)) socket.write(encodeFrame(JSON.stringify(event)));
      }, { requireMask: true });
      const receive = (chunk) => {
        try { read(chunk); } catch { errors.push('DUMMY_INVALID_WS_FRAME'); socket.destroy(); }
      };
      socket.on('data', receive);
      if (head.length) receive(head);
      socket.resume();
    };
    socket.pause();
    const delay = controls.upgradeDelay.get(provider) ?? 0;
    controls.upgradeDelay.delete(provider);
    if (!delay) accept();
    else {
      const timer = setTimeout(() => { timers.delete(timer); accept(); }, delay);
      timers.add(timer);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests, upgrades, errors, controls,
    counts(provider) {
      const httpRequests = provider ? requests.filter((x) => x.provider === provider) : requests;
      const ws = provider ? upgrades.filter((x) => x.provider === provider) : upgrades;
      return { http: httpRequests.length, upgrades: ws.length, frames: ws.reduce((n, x) => n + x.frames.length, 0) };
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
