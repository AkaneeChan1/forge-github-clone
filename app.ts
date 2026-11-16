// The HTTP surface: one server, four protocols. /healthz answers first, then REST v3, GraphQL v4, the
// MCP endpoint and git smart HTTP, and a JSON 404 for everything else.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGit } from './src/git/http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 64 * 1024 * 1024;

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read the whole request body; an oversized body is truncated at the cap rather than buffered forever. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      res.setHeader('x-github-request-id', `req-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`);

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }

      if (await handleRest(req, res, url, body)) return;
      if (await handleGraphql(req, res, url, body)) return;
      if (handleMcp(req, res, url, body)) return;
      if (handleGit(req, res, url, body)) return;

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error', detail: (err as Error).message });
        return;
      }
      res.end();
    });
  });
}
