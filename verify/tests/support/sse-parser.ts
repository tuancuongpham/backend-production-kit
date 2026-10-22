// Reads a text/event-stream body exactly as a browser's EventSource does (HTML Living Standard, "Interpreting an
// event stream"). Tests assert on what the browser would see, not on the bytes the server meant to send: a stray
// CR, which the spec treats as a line break, is visible here as an injected field.

export interface BrowserEvent {
  /** The event type the browser dispatches ('message' unless an `event:` field set it). */
  type: string;
  data: string;
  /** The last event id at dispatch, which the browser sends back as Last-Event-ID when it reconnects. */
  lastEventId: string;
}

export interface ParsedStream {
  events: BrowserEvent[];
  lastEventId: string;
  retryMs?: number;
  comments: string[];
}

export function parseEventStream(stream: string): ParsedStream {
  const events: BrowserEvent[] = [];
  const comments: string[] = [];
  let data = '';
  let type = '';
  let lastEventId = '';
  let retryMs: number | undefined;
  // Lines end with CRLF, LF or CR. The text after the last line break is an incomplete line: ignored, as a browser
  // would wait for the rest of it.
  const lines = stream.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  lines.pop();
  for (const line of lines) {
    if (line === '') {
      if (data !== '') events.push({ type: type || 'message', data: data.slice(0, -1), lastEventId });
      data = '';
      type = '';
      continue;
    }
    if (line.startsWith(':')) {
      comments.push(line.slice(1).trimStart());
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') type = value;
    else if (field === 'data') data += `${value}\n`;
    else if (field === 'id' && !value.includes('\u0000')) lastEventId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retryMs = Number(value);
  }
  return { events, lastEventId, retryMs, comments };
}
