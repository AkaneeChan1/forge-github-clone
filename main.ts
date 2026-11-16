// The entry <-> env lifecycle. The harness owns this contract, so the shape is fixed even though the
// code below is ours:
//
//   1. MAKEFUN_ENV_URL is the env's origin (http://store:8080 in a trial container). Unset means there
//      is nobody to register with, so the process exits 1 at once.
//   2. listen(0): the kernel picks a free port. Never 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. 200 is the normal answer. 409 means another entry
//      registered first; that is not ours to fix, so we keep waiting like any other entry. 400 and 405
//      are contract errors and end the process.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed poll is
//      retried with exponential backoff and jitter; the process never exits before the env says done.
//   5. Close the server, then exit 0.
//
// Only app.ts is imported: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

/** The server app.ts builds; taken from the factory so no Node type import is needed. */
type AppServer = ReturnType<typeof createApp>;

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const BACKOFF_INITIAL_MS = 250;
const BACKOFF_MAX_MS = 2_000;
/** How long a closing server may keep live connections before they are cut. */
const CLOSE_GRACE_MS = 2_000;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');

/** A failure the contract does not allow us to retry: the env rejected the request itself. */
class ContractError extends Error {}

const log = (message: string): void => {
  process.stdout.write(`[entry] ${message}\n`);
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The wait after `attempt` failed requests: exponential from BACKOFF_INITIAL_MS, capped at
 * BACKOFF_MAX_MS, with equal jitter so two entries retrying in lockstep drift apart instead of
 * hammering the env on the same tick.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** Math.min(attempt, 8));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** A reply whose body was parsed as JSON, or null when the body was empty or not JSON. */
interface JsonReply<T> {
  readonly status: number;
  readonly body: T | null;
}

/**
 * One JSON request with a hard timeout. A network error or a timeout rejects; any HTTP status,
 * including an error status, resolves, because the caller decides what a status means. A body that
 * is not JSON is reported as null rather than thrown: a bad body is not a broken connection.
 */
async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<JsonReply<T>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: T | null = null;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

/**
 * POST the bound port until the env accepts it. 200 and 409 both mean "stop registering"; 400 and 405
 * are contract errors and throw; anything else, including a network error or a timeout, is retried,
 * since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetchJson<unknown>(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port }),
        },
        REQUEST_TIMEOUT_MS,
      );
      if (reply.status === 200) {
        log(`registered port ${port} with the env`);
        return;
      }
      if (reply.status === 409) {
        log('register answered 409: another entry registered first; waiting for done anyway');
        return;
      }
      if (reply.status === 400 || reply.status === 405) {
        throw new ContractError(`register answered HTTP ${reply.status}: the env rejected the contract`);
      }
      log(`register answered HTTP ${reply.status}; retrying`);
    } catch (err) {
      if (err instanceof ContractError) throw err;
      log(`register failed (${describe(err)}); retrying`);
    }
    const delay = backoffDelay(attempt);
    log(`register retry in ${delay}ms`);
    await sleep(delay);
  }
}

/**
 * Poll GET /done until it answers {"done":true}; never return before that. A 200 with done:false is
 * the normal answer while the suite runs, so it resets the backoff and polls again promptly; only a
 * failed request or a non-200 status backs off.
 */
async function waitForDone(): Promise<void> {
  const url = `${ENV_URL}/done`;
  let failures = 0;
  for (;;) {
    let delay: number;
    try {
      const reply = await fetchJson<{ done?: unknown }>(url, { method: 'GET' }, REQUEST_TIMEOUT_MS);
      if (reply.status === 200 && reply.body?.done === true) {
        log('the env reports done');
        return;
      }
      if (reply.status === 200) {
        failures = 0;
        delay = backoffDelay(0);
      } else {
        failures += 1;
        log(`done answered HTTP ${reply.status}; retrying`);
        delay = backoffDelay(failures - 1);
      }
    } catch (err) {
      failures += 1;
      log(`done poll failed (${describe(err)}); retrying`);
      delay = backoffDelay(failures - 1);
    }
    await sleep(delay);
  }
}

/** Stop accepting connections, let live ones finish, then cut whatever is left after the grace. */
async function closeServer(server: AppServer): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, CLOSE_GRACE_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

let server: AppServer | null = null;
let shuttingDown = false;

/** The one exit path: close the server first, then leave with `code`. Safe to call twice. */
async function shutdown(code: number, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${reason}: closing the server`);
  if (server !== null) {
    try {
      await closeServer(server);
    } catch (err) {
      log(`closing the server failed (${describe(err)})`);
    }
  }
  log(`server closed; exiting ${code}`);
  process.exit(code);
}

/** Bind the port, register it, wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  server = createApp();
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server?.once('error', onError);
    server?.listen(0, () => {
      server?.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  log(`listening on port ${address.port}`);

  log(`registering with ${ENV_URL}`);
  await register(address.port);

  log('waiting for the env to say done');
  await waitForDone();
}

if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// A signal is a stop, not a crash: take the same clean path out, with a non-zero code because the
// trial did not finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(1, `received ${signal}`);
  });
}

try {
  await main();
  await shutdown(0, 'the env is done');
} catch (err) {
  process.stderr.write(`[entry] ${describe(err)}\n`);
  await shutdown(1, 'the lifecycle failed');
}
