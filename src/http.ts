// Small HTTP helpers shared by every surface: JSON replies, request ids, error bodies.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The header every reply carries, as GitHub does. */
export function requestId(res: ServerResponse): string {
  const existing = res.getHeader('x-github-request-id');
  if (typeof existing === 'string' && existing !== '') return existing;
  const id = randomUUID();
  res.setHeader('x-github-request-id', id);
  return id;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  requestId(res);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-cache',
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  requestId(res);
  res.writeHead(status, { 'content-length': 0, ...headers });
  res.end();
}

export function sendRaw(res: ServerResponse, status: number, type: string, body: Buffer, headers: Record<string, string> = {}): void {
  requestId(res);
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
    ...headers,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest', ...extra });
}

/** Read a request body fully (bounded by the caller's limit). */
export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token a request carries, or null. */
export function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

/** Parse a JSON body; throws a tagged error so the caller can answer 400. */
export class MalformedJson extends Error {}

export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedJson('Problems parsing JSON');
  }
}
