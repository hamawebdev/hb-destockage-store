// Fake Queue MessageBatch recording ack/retry per message.
export interface FakeMessage<B> extends Message<B> {
  outcome: 'ack' | 'retry' | null;
  retryDelay: number | undefined;
}

export function fakeMessage<B>(body: B, attempts = 1, id = crypto.randomUUID()): FakeMessage<B> {
  const m: FakeMessage<B> = {
    id,
    timestamp: new Date(),
    body,
    attempts,
    outcome: null,
    retryDelay: undefined,
    ack() {
      m.outcome = 'ack';
    },
    retry(opts?: QueueRetryOptions) {
      m.outcome = 'retry';
      m.retryDelay = opts?.delaySeconds;
    },
  };
  return m;
}

export function fakeBatch<B>(messages: FakeMessage<B>[], queue = 'hb-order-notifications'): MessageBatch<B> {
  return {
    messages,
    queue,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll() {
      for (const m of messages) m.ack();
    },
    retryAll(opts?: QueueRetryOptions) {
      for (const m of messages) m.retry(opts);
    },
  };
}

/** Captures console output for no-personal-data assertions. */
export function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) {
    console[k] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
  return { lines, restore: () => Object.assign(console, orig) };
}
