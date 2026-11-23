/**
 * Local fakes for the push providers: an HTTP server playing Google's token endpoint + FCM v1,
 * and an h2c (plaintext HTTP/2) server playing APNs. No real network. Keys are generated per run.
 */
import { generateKeyPairSync, verify, type KeyObject, createPublicKey } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

export function rsaKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey: createPublicKey(publicKey) };
}

export function ecKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey: createPublicKey(publicKey) };
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  valid: boolean;
}

/** Decode and verify a compact JWS (RS256 or ES256 in JOSE r||s form). */
export function verifyJwt(token: string, key: KeyObject): DecodedJwt {
  const [h, c, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const claims = JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const input = Buffer.from(`${h}.${c}`);
  const sig = Buffer.from(s!, 'base64url');
  const valid =
    header.alg === 'ES256'
      ? verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : verify('sha256', input, key, sig);
  return { header, claims, valid };
}

export interface ScriptedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface FakeFcm {
  url: string;
  tokenUri: string;
  /** Every token-endpoint request (decoded assertion). */
  tokenRequests: DecodedJwt[];
  /** Every send request. */
  sends: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }>;
  /** Queue of send responses; empty = 200 with a message name. */
  sendScript: ScriptedResponse[];
  /** Queue of token responses; empty = 200 with a fresh token. */
  tokenScript: ScriptedResponse[];
  expiresIn: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

function reply(res: ServerResponse, r: ScriptedResponse) {
  const send = () => {
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
    res.end(r.body === undefined ? '' : JSON.stringify(r.body));
  };
  if (r.delayMs) setTimeout(send, r.delayMs);
  else send();
}

export async function startFakeFcm(publicKey: KeyObject): Promise<FakeFcm> {
  let tokenCount = 0;
  let messageCount = 0;
  const fake: Omit<FakeFcm, 'url' | 'tokenUri' | 'close'> = {
    tokenRequests: [],
    sends: [],
    sendScript: [],
    tokenScript: [],
    expiresIn: 3600,
  };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === '/token') {
      const assertion = new URLSearchParams(raw).get('assertion') ?? '';
      fake.tokenRequests.push(verifyJwt(assertion, publicKey));
      const scripted = fake.tokenScript.shift();
      if (scripted) return reply(res, scripted);
      tokenCount++;
      return reply(res, { status: 200, body: { access_token: `at-${tokenCount}`, expires_in: fake.expiresIn } });
    }
    fake.sends.push({
      path: req.url ?? '',
      authorization: req.headers.authorization,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    const scripted = fake.sendScript.shift();
    if (scripted) return reply(res, scripted);
    messageCount++;
    return reply(res, { status: 200, body: { name: `projects/demo-project/messages/${messageCount}` } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return Object.assign(fake, {
    url,
    tokenUri: `${url}/token`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  });
}

export function fcmError(status: number, googleStatus: string, errorCode?: string, message = 'error', extra: unknown[] = []) {
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        status: googleStatus,
        details: [
          ...(errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : []),
          ...extra,
        ],
      },
    },
  };
}

export interface FakeApns {
  url: string;
  requests: Array<{ headers: http2.IncomingHttpHeaders; body: Record<string, unknown>; jwt: DecodedJwt }>;
  script: ScriptedResponse[];
  sessions: number;
  /** Send GOAWAY on the session after the next response. */
  goawayAfterNext: boolean;
  close(): Promise<void>;
}

export async function startFakeApns(publicKey: KeyObject): Promise<FakeApns> {
  const server = http2.createServer();
  const open = new Set<http2.ServerHttp2Session>();
  const fake: Omit<FakeApns, 'url' | 'close'> = { requests: [], script: [], sessions: 0, goawayAfterNext: false };
  server.on('session', (session) => {
    fake.sessions++;
    open.add(session);
    session.on('close', () => open.delete(session));
  });
  let n = 0;
  server.on('stream', (stream, headers) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (c: string) => (raw += c));
    stream.on('end', () => {
      const auth = String(headers.authorization ?? '').replace(/^bearer /, '');
      fake.requests.push({ headers, body: raw ? JSON.parse(raw) : {}, jwt: verifyJwt(auth, publicKey) });
      const scripted = fake.script.shift() ?? { status: 200, headers: { 'apns-id': `apns-${++n}` } };
      const respond = () => {
        if (stream.destroyed) return;
        stream.respond({ ':status': scripted.status, 'content-type': 'application/json', ...(scripted.headers ?? {}) });
        stream.end(scripted.body === undefined ? '' : JSON.stringify(scripted.body));
        if (fake.goawayAfterNext) {
          fake.goawayAfterNext = false;
          stream.session?.goaway();
          setTimeout(() => stream.session?.close(), 5);
        }
      };
      if (scripted.delayMs) setTimeout(respond, scripted.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  });
}

/** A realistic-looking APNs device token (64 hex chars). */
export function apnsToken(seed = 'a'): string {
  return seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'f');
}
