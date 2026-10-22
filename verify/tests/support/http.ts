// HTTP the way a user's browser or app does it: real sockets, real headers, and the failures users cause
// (closing the tab mid-request, retrying, double-clicking). For tests that drive a server end to end.
import http from 'node:http';
import type net from 'node:net';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json<T = any>(): T;
}

export interface RequestOptions {
  method?: string;
  path: string;
  /** An array sends the header once per value, as a client that adds a header twice does. */
  headers?: Record<string, string | string[]>;
  /** A string or Buffer is sent as is; anything else as JSON. */
  body?: unknown;
  /** Abort to drop the connection, like a closed tab or a lost signal. The promise then rejects. */
  signal?: AbortSignal;
}

export function request(port: number, o: RequestOptions): Promise<Reply> {
  const raw = o.body === undefined ? undefined : typeof o.body === 'string' || Buffer.isBuffer(o.body) ? o.body : JSON.stringify(o.body);
  const headers = { ...(raw !== undefined && typeof o.body !== 'string' && !Buffer.isBuffer(o.body) ? { 'content-type': 'application/json' } : {}), ...o.headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers, agent: false, signal: o.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

/** Server side: answers with a JSON body. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(body));
}

/** Runs `handler` on a random local port until `close()`. */
export async function serve(handler: http.RequestListener): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
