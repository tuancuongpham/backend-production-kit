// Production HTTP server skeleton (node:http): timeouts, load shedding, liveness/readiness,
// client-disconnect cancellation, request ids, body limits, graceful shutdown.
// Frameworks (Express, Fastify, Hono on node) sit inside `handler`; the server-level
// concerns below stay the same.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Aborted when the client disconnects — pass it to DB queries, fetch, LLM calls. */
  signal: AbortSignal;
  requestId: string;
}

export interface HardenedServerOptions {
  handler: (req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext) => unknown;
  /** Concurrent requests before shedding load with 503. Size from a load test, not a guess. */
  maxInFlight?: number; // default 256
  headersTimeoutMs?: number; // default 10s — slowloris protection
  requestTimeoutMs?: number; // default 30s — whole request must arrive within this
  /** Must exceed the load balancer's idle timeout (ALB 60s, GCLB 600s), or the LB reuses dead sockets → 502s. */
  keepAliveTimeoutMs?: number; // default 65s
  readinessChecks?: Array<() => Promise<unknown>>;
  /** After readiness flips to 503, keep serving while the LB/K8s endpoints notice. */
  drainDelayMs?: number; // default 5s
  /** Max wait for in-flight requests. Keep below K8s terminationGracePeriodSeconds (default 30s). */
  shutdownGraceMs?: number; // default 20s
  onShutdown?: Array<() => Promise<unknown>>; // close DB pools, flush telemetry...
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PayloadTooLargeError extends Error {
  status = 413;
}

/** Read a request body with a hard size cap (check before buffering, not after). */
export async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new PayloadTooLargeError(`body exceeds ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new PayloadTooLargeError(`body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Every outbound call needs a deadline; combine it with the request's cancellation signal. */
export function deadline(ms: number, parent?: AbortSignal): AbortSignal {
  return parent ? AbortSignal.any([parent, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createHardenedServer(o: HardenedServerOptions) {
  const maxInFlight = o.maxInFlight ?? 256;
  const log = o.log ?? (() => {});
  let inFlight = 0;
  let draining = false;
  let onIdle: (() => void) | null = null;
  let shutdownPromise: Promise<{ forced: boolean }> | null = null;

  async function ready(): Promise<boolean> {
    if (draining) return false;
    try {
      await Promise.all((o.readinessChecks ?? []).map((check) => Promise.race([check(), sleep(1000).then(() => Promise.reject(new Error('readiness check timeout')))])));
      return true;
    } catch (e) {
      log('readiness check failed', { error: String(e) });
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    // Liveness: "is the process able to serve at all". No dependency checks, or a DB blip restarts every pod.
    if (path === '/livez') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    // Readiness: "should the LB send me traffic". Fails while draining or when dependencies are down.
    if (path === '/readyz') {
      const ok = await ready();
      return void res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ready' : 'not ready');
    }
    if (draining) return void res.writeHead(503, { connection: 'close', 'retry-after': '1' }).end('shutting down');
    if (inFlight >= maxInFlight) {
      // Shedding fast is the point: a quick 503 beats a 30s timeout for everyone.
      return void res.writeHead(503, { 'retry-after': '1' }).end('overloaded');
    }

    inFlight++;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort(new Error('client disconnected'));
    });
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);

    try {
      await o.handler(req, res, { signal: ac.signal, requestId });
    } catch (err) {
      const status = err instanceof PayloadTooLargeError ? 413 : 500;
      log('request failed', { requestId, status, error: String(err) });
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 413 ? 'payload too large' : 'internal error');
      else res.destroy();
    } finally {
      inFlight--;
      if (inFlight === 0) onIdle?.();
    }
  });

  server.headersTimeout = o.headersTimeoutMs ?? 10_000;
  server.requestTimeout = o.requestTimeoutMs ?? 30_000;
  server.keepAliveTimeout = o.keepAliveTimeoutMs ?? 65_000;

  /**
   * 1. readiness → 503 (LB stops routing)   2. wait drainDelay
   * 3. stop accepting, close idle sockets    4. wait for in-flight (≤ grace)
   * 5. force-close the rest                  6. run onShutdown hooks
   */
  function shutdown(): Promise<{ forced: boolean }> {
    shutdownPromise ??= (async () => {
      draining = true;
      log('shutdown: draining', { inFlight });
      await sleep(o.drainDelayMs ?? 5_000);
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      const idle = inFlight === 0 ? Promise.resolve() : new Promise<void>((r) => (onIdle = r));
      const finished = await Promise.race([idle.then(() => true), sleep(o.shutdownGraceMs ?? 20_000).then(() => false)]);
      server.closeAllConnections();
      await closed;
      for (const hook of o.onShutdown ?? []) {
        await hook().catch((e) => log('shutdown hook failed', { error: String(e) }));
      }
      log('shutdown: done', { forced: !finished });
      return { forced: !finished };
    })();
    return shutdownPromise;
  }

  function listen(port = 0, host?: string): Promise<number> {
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve((server.address() as { port: number }).port));
    });
  }

  return { server, listen, shutdown, stats: () => ({ inFlight, draining }) };
}

/** SIGTERM (K8s, Docker, systemd) and SIGINT (Ctrl+C) → graceful shutdown; a second signal forces exit. */
export function installSignalHandlers(shutdown: () => Promise<unknown>, exit: (code: number) => void = process.exit) {
  let received = 0;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (++received > 1) return exit(1);
      shutdown().then(() => exit(0), () => exit(1));
    });
  }
  process.on('unhandledRejection', (reason) => {
    // Log loudly; crashing on every stray rejection turns small bugs into outages, ignoring them hides bugs.
    console.error('unhandledRejection', reason);
  });
}
