// A small Toxiproxy client for fault-injection tests. The app reaches each dependency through a proxy. A test
// adds a "toxic" (latency, a black hole, a connection reset, a bandwidth cap) or takes the proxy down, then
// checks that the app degrades the way its design says.

export type ToxicType = 'latency' | 'timeout' | 'reset_peer' | 'bandwidth' | 'slow_close' | 'slicer' | 'limit_data';

export interface Toxic {
  type: ToxicType;
  /** 'downstream' (default) slows or cuts the replies coming back from the dependency; 'upstream' what is sent to it. */
  stream?: 'upstream' | 'downstream';
  /** Share of connections affected, 0–1 (default 1). */
  toxicity?: number;
  /**
   * latency: { latency, jitter } ms · timeout: { timeout } ms, 0 = a black hole that never closes ·
   * reset_peer: { timeout } ms before the TCP reset · bandwidth: { rate } KB/s
   */
  attributes: Record<string, number>;
}

export function createToxiproxy(apiUrl: string) {
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`toxiproxy ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  /**
   * (Re)create a proxy listening on `listen` (inside the Toxiproxy container) and forwarding to `upstream`
   * as Toxiproxy sees it, e.g. ('pg', '0.0.0.0:55440', 'postgres:5432').
   */
  async function proxy(name: string, listen: string, upstream: string) {
    await call('DELETE', `/proxies/${name}`);
    await call('POST', '/proxies', { name, listen, upstream, enabled: true });
    const p = {
      name,
      /** Returns the toxic's name, for remove(). */
      async add(toxic: Toxic): Promise<string> {
        const stream = toxic.stream ?? 'downstream';
        const created = await call('POST', `/proxies/${name}/toxics`, {
          name: `${toxic.type}_${stream}`,
          type: toxic.type,
          stream,
          toxicity: toxic.toxicity ?? 1,
          attributes: toxic.attributes,
        });
        return created.name;
      },
      remove: (toxicName: string) => call('DELETE', `/proxies/${name}/toxics/${toxicName}`),
      /** Closes every open connection and refuses new ones: a crashed, restarted or partitioned dependency. */
      down: () => call('POST', `/proxies/${name}`, { enabled: false }),
      up: () => call('POST', `/proxies/${name}`, { enabled: true }),
      /** Runs `fn` with the toxic in place, and always removes it. */
      async with<T>(toxic: Toxic, fn: () => Promise<T>): Promise<T> {
        const t = await p.add(toxic);
        try {
          return await fn();
        } finally {
          await p.remove(t);
        }
      },
    };
    return p;
  }

  return {
    proxy,
    /** Re-enables every proxy and removes every toxic: call it between tests. */
    reset: () => call('POST', '/reset'),
    available: () => fetch(`${apiUrl}/version`).then((r) => r.ok, () => false),
  };
}
