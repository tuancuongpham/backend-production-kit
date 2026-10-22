// A browser tab with an event stream open, over a real socket. What it has received so far is read exactly as the
// browser reads it (parseEventStream), so a framing bug shows up as the browser would see it. Closing the tab drops
// the connection; reconnecting is a new tab with the Last-Event-ID the browser would send.
import http from 'node:http';
import { waitFor } from './wait.ts';
import { parseEventStream, type BrowserEvent, type ParsedStream } from './sse-parser.ts';

export class EventStreamTab {
  /** The response head, once the server has sent it. */
  readonly response: Promise<http.IncomingMessage>;
  /** Resolves when the server ends the stream or the tab is closed. */
  readonly ended: Promise<void>;
  readonly #request: http.ClientRequest;
  #received = '';

  constructor(port: number, path: string, headers: Record<string, string> = {}) {
    let end!: () => void;
    this.ended = new Promise<void>((resolve) => (end = resolve));
    this.#request = http.get({ host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream', ...headers }, agent: false });
    this.response = new Promise((resolve, reject) => {
      this.#request.on('response', (res) => {
        res.setEncoding('utf8'); // a character split across two chunks is decoded whole, as a browser does
        res.on('data', (text: string) => (this.#received += text));
        res.on('error', () => {}); // closing the tab aborts the response
        res.on('close', end);
        resolve(res);
      });
      this.#request.on('error', (err) => {
        end();
        reject(err);
      });
    });
    this.response.catch(() => {});
  }

  /** Everything received so far, as the browser has dispatched it. */
  get stream(): ParsedStream {
    return parseEventStream(this.#received);
  }

  /** The events dispatched so far, once there are at least `n`. */
  async events(n: number, what = `${n} events`): Promise<BrowserEvent[]> {
    await waitFor(() => this.stream.events.length >= n, what);
    return this.stream.events;
  }

  close(): void {
    this.#request.destroy();
  }
}
