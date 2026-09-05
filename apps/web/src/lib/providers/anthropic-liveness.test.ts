import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTransportLivenessMiddleware,
  newIdleTracker,
  snapshotTransportLiveness,
  tickIdleTracker,
  transportIdleTimeoutMs,
  TRANSPORT_IDLE_TIMEOUT_ENV,
} from './anthropic-liveness';

/**
 * THE MIDDLEWARE, DRIVEN DIRECTLY — PROVING WHAT `structured()`'S OWN FAKE
 * SDK HARNESS CANNOT.
 *
 * `anthropic-transport.test.ts`'s fake `Anthropic.messages.stream`/`.parse`
 * are plain `vi.fn()`s that never touch `requestOptions.middleware` — the
 * real SDK's `client.mjs` is what invokes it, and nothing in that fake
 * harness reaches that far. So the one way to prove the middleware itself
 * tells a ping-fed connection apart from a silent one is to call it exactly
 * as `client.mjs` would: `middleware(request, next, ctx)`, with a `next`
 * that resolves to a real, minimal `Response`-shaped object carrying a real
 * `ReadableStream` body this test controls byte-for-byte.
 */

/** Minimal SSE framing — enough for `Stream.rawEvents` to parse `{event, data}` correctly. */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A `Response`-shaped fake whose body streams `frames` one at a time as
 * `pushNext()` is called, and whose `.clone()` returns an independent fake
 * reading the *same* frame sequence — mirroring what a real tee'd response
 * gives the middleware.
 */
function fakeStreamingResponse(): {
  response: Response;
  push: (frame: string) => void;
  close: () => void;
  /** Simulates what tearing down the underlying connection (a real abort) does to a tee'd reader. */
  errorOut: (reason: unknown) => void;
} {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  const fake = {
    ok: true,
    body,
    clone: () => fake,
  } as unknown as Response;
  return {
    response: fake,
    push: (frame: string) => controllerRef?.enqueue(encoder.encode(frame)),
    close: () => controllerRef?.close(),
    errorOut: (reason: unknown) => controllerRef?.error(reason),
  };
}

function fakeCtx(): Parameters<ReturnType<typeof createTransportLivenessMiddleware>['middleware']>[2] {
  return { options: { stream: true } } as never;
}

describe('idle tracker primitives', () => {
  it('records count, first, last and the longest gap between ticks', () => {
    const tracker = newIdleTracker();
    expect(tracker).toEqual({ count: 0, firstAtMs: null, lastAtMs: null, longestIdleMs: 0 });

    tickIdleTracker(tracker, 100);
    expect(tracker).toMatchObject({ count: 1, firstAtMs: 100, lastAtMs: 100, longestIdleMs: 0 });

    tickIdleTracker(tracker, 350);
    expect(tracker).toMatchObject({ count: 2, firstAtMs: 100, lastAtMs: 350, longestIdleMs: 250 });

    tickIdleTracker(tracker, 400);
    // A shorter gap than the one already recorded must not shrink it.
    expect(tracker).toMatchObject({ count: 3, lastAtMs: 400, longestIdleMs: 250 });

    tickIdleTracker(tracker, 900);
    expect(tracker.longestIdleMs).toBe(500);
  });
});

describe('the configured transport-idle threshold', () => {
  const ORIGINAL = process.env[TRANSPORT_IDLE_TIMEOUT_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[TRANSPORT_IDLE_TIMEOUT_ENV];
    else process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = ORIGINAL;
  });

  it('defaults to 120 seconds — not vendor-documented, chosen conservatively; see the constant’s own note', () => {
    delete process.env[TRANSPORT_IDLE_TIMEOUT_ENV];
    expect(transportIdleTimeoutMs()).toBe(120_000);
  });

  it('is configurable, for retuning once a real ping cadence has been observed', () => {
    process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = '45000';
    expect(transportIdleTimeoutMs()).toBe(45_000);
  });

  it('falls back to the default on a nonsensical value rather than disabling the watchdog', () => {
    process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = 'not-a-number';
    expect(transportIdleTimeoutMs()).toBe(120_000);
    process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = '-5';
    expect(transportIdleTimeoutMs()).toBe(120_000);
  });
});

describe('the transport-liveness middleware, driven with a real SSE byte stream', () => {
  it('ticks the transport tracker and calls onEvent for a ping — the event MessageStream itself cannot see', async () => {
    const onEvent = vi.fn();
    const { middleware, tracker, pings } = createTransportLivenessMiddleware({
      calledAtMs: performance.now(),
      onEvent,
    });
    const fake = fakeStreamingResponse();
    const next = vi.fn(async () => fake.response);

    const returned = await middleware({} as never, next, fakeCtx());
    // The middleware must hand back the *original*, still-unconsumed
    // response — the client still has to read it.
    expect(returned).toBe(fake.response);

    fake.push(sseFrame('ping', { type: 'ping' }));
    fake.close();
    // The background observer loop is fire-and-forget; give it a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(tracker.count).toBe(1);
    expect(pings.count).toBe(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('distinguishes pings from content events in the transport tracker', async () => {
    const onEvent = vi.fn();
    const { tracker, pings, middleware } = createTransportLivenessMiddleware({
      calledAtMs: performance.now(),
      onEvent,
    });
    const fake = fakeStreamingResponse();
    await middleware({} as never, async () => fake.response, fakeCtx());

    fake.push(sseFrame('content_block_delta', { type: 'content_block_delta' }));
    fake.push(sseFrame('ping', { type: 'ping' }));
    fake.push(sseFrame('ping', { type: 'ping' }));
    fake.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Every raw event — content or ping — ticks the transport tracker...
    expect(tracker.count).toBe(3);
    // ...but only the pings tick the ping-specific one.
    expect(pings.count).toBe(2);
    // And `onEvent` — what a caller resets an idle watchdog with — fires for all three.
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  /**
   * THE PROPERTY THIS WHOLE MECHANISM EXISTS FOR: A STREAM THAT IS PING-FED
   * BUT MODEL-QUIET LOOKS "ALIVE," NOT "IDLE."
   */
  it('model event → periodic pings → eventual model output: every ping still ticks the tracker, so a watchdog reset on it would never fire', async () => {
    const onEvent = vi.fn();
    const { tracker, pings, middleware } = createTransportLivenessMiddleware({
      calledAtMs: performance.now(),
      onEvent,
    });
    const fake = fakeStreamingResponse();
    await middleware({} as never, async () => fake.response, fakeCtx());

    fake.push(sseFrame('content_block_delta', { type: 'content_block_delta' }));
    for (let i = 0; i < 5; i += 1) fake.push(sseFrame('ping', { type: 'ping' }));
    fake.push(sseFrame('message_stop', { type: 'message_stop' }));
    fake.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(tracker.count).toBe(7);
    expect(pings.count).toBe(5);
    // A caller resetting an idle timer on every one of these seven calls
    // would never let it reach zero — which is exactly the point: pings
    // alone are enough to keep a watchdog like that satisfied indefinitely.
    expect(onEvent).toHaveBeenCalledTimes(7);
  });

  it('model event → no bytes/pings forever: the tracker never ticks and onEvent never fires, so nothing resets the watchdog', async () => {
    const onEvent = vi.fn();
    const { tracker, pings, middleware } = createTransportLivenessMiddleware({
      calledAtMs: performance.now(),
      onEvent,
    });
    const fake = fakeStreamingResponse();
    await middleware({} as never, async () => fake.response, fakeCtx());

    // Nothing pushed at all — the connection that never sends another byte.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(tracker.count).toBe(0);
    expect(pings.count).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does nothing on a non-streaming call — no clone, no observer, no crash', async () => {
    const onEvent = vi.fn();
    const { middleware, tracker } = createTransportLivenessMiddleware({
      calledAtMs: performance.now(),
      onEvent,
    });
    const fake = fakeStreamingResponse();
    const next = vi.fn(async () => fake.response);

    const returned = await middleware({} as never, next, { options: { stream: false } } as never);
    expect(returned).toBe(fake.response);
    expect(tracker.count).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('never throws onward even if the response has no body — diagnostic-only, by construction', async () => {
    const onEvent = vi.fn();
    const { middleware } = createTransportLivenessMiddleware({ calledAtMs: performance.now(), onEvent });
    const bodyless = { ok: true, body: null, clone: () => bodyless } as unknown as Response;
    await expect(middleware({} as never, async () => bodyless, fakeCtx())).resolves.toBe(bodyless);
  });

  /**
   * WHAT A REAL ABORT DOES TO THE UNDERLYING CONNECTION, SIMULATED.
   *
   * `Stream.rawEvents`/`_iterSSEMessages` do not themselves watch
   * `controller.signal` — proven from source (Part A) — so this observer's
   * loop only ever stops because the byte source it is reading actually
   * ends. Tearing down the shared connection an aborted fetch was using is
   * what does that in the real runtime: both tee'd branches read from the
   * same source, so cancelling the original naturally errors the clone's
   * reader too. `errorOut` reproduces exactly that shape of failure.
   */
  it('stops observing cleanly when the underlying connection is torn down mid-stream, as a real abort would do', async () => {
    const onEvent = vi.fn();
    const { tracker, middleware } = createTransportLivenessMiddleware({
      calledAtMs: performance.now(),
      onEvent,
    });
    const fake = fakeStreamingResponse();
    await middleware({} as never, async () => fake.response, fakeCtx());

    fake.push(sseFrame('ping', { type: 'ping' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.count).toBe(1);

    // The connection dies mid-stream — never a clean `.close()`.
    fake.errorOut(new Error('The operation was aborted.'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Nothing thrown out of the middleware call itself (already resolved
    // above), and no further ticks after the source errors — the loop ended
    // rather than hanging on a broken reader.
    const countAfterError = tracker.count;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.count).toBe(countAfterError);
  });

  it('reports a full snapshot with connection time, ping count and longest gaps', async () => {
    const start = performance.now();
    const onEvent = vi.fn();
    const { tracker, pings, connectedAtMs, middleware } = createTransportLivenessMiddleware({
      calledAtMs: start,
      onEvent,
    });
    const fake = fakeStreamingResponse();
    await middleware({} as never, async () => fake.response, fakeCtx());

    expect(connectedAtMs.value).not.toBeNull();
    fake.push(sseFrame('ping', { type: 'ping' }));
    fake.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshot = snapshotTransportLiveness(tracker, pings, connectedAtMs.value);
    expect(snapshot.connectedAtMs).toBe(connectedAtMs.value);
    expect(snapshot.transportEventCount).toBe(1);
    expect(snapshot.pingCount).toBe(1);
    expect(snapshot.lastPingAtMs).not.toBeNull();
    expect(snapshot.firstTransportEventAtMs).toBe(snapshot.lastTransportEventAtMs);
  });
});
