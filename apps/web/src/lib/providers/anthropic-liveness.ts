import 'server-only';
import type { Middleware } from '@anthropic-ai/sdk/core/middleware';
import { Stream, type ServerSentEvent } from '@anthropic-ai/sdk/core/streaming';

/**
 * TWO SEPARATE QUESTIONS A HUNG-LOOKING STREAM CANNOT ANSWER ON ITS OWN:
 * "IS THE CONNECTION ALIVE" AND "IS THE MODEL PRODUCING ANYTHING VISIBLE."
 *
 * A live Iceland run showed 2 SSE events by 9 seconds and then nothing for
 * ~231 seconds before Sidequest's own 240-second deadline aborted it —
 * indistinguishable, from `MessageStream`'s public event surface, from a
 * model that spent 231 seconds thinking with a perfectly healthy
 * connection. It cannot be told apart because `MessageStream` cannot see
 * the difference: proven from the installed SDK's own source
 * (`@anthropic-ai/sdk@0.115.0`, `core/streaming.mjs`), the parsed stream
 * every `stream.on(...)` listener reads is built by
 * `Stream.fromSSEResponse`'s async generator, which hits
 * `if (sse.event === 'ping') { continue; }` (line 107) and never yields a
 * ping onward — so `stream.on('streamEvent', ...)`, `MessageStream`'s own
 * public event surface, is structurally blind to the one signal that would
 * tell "connection alive, model quiet" apart from "connection gone."
 *
 * `Stream.rawEvents(response, controller)` (same file, documented at its
 * own declaration) is the one place in the SDK's public API that returns
 * `{event, data, raw}` before that filter runs — built for exactly this:
 * "before any JSON parsing or event-name filtering... Use this in
 * middleware." And the SDK's own middleware contract
 * (`core/middleware.d.ts`) is explicit that a middleware may read
 * `response.clone()` without disturbing what the client itself goes on to
 * read: "Middleware must not consume the body of the Response it returns —
 * the client still needs to read it... to inspect the body... read a clone
 * (`await response.clone().text()`)." That is the whole mechanism this file
 * uses: a per-call `Middleware` (wired in through `requestOptions.middleware`,
 * confirmed from `client.mjs`'s own `makeRequest` to be honoured per-request,
 * not only at client construction) clones the response, hands the clone to
 * `Stream.rawEvents` on a background loop, and returns the *original*,
 * untouched response for the SDK's normal `MessageStream` machinery to keep
 * consuming exactly as before. Nothing is forked, nothing is patched —
 * this is the SDK's own documented extension point, used narrowly for one
 * call.
 *
 * What this buys: a `ping` event now updates `lastTransportEventAt` even
 * though no `stream.on(...)` listener ever sees it, so a watchdog reset on
 * *any* raw SSE event — content or ping — can tell "the pipe is open, keep
 * waiting" from "nothing has crossed this connection in a long time,
 * something is actually wrong" without ever second-guessing a model that is
 * legitimately still thinking.
 */

/** A running count/first/last/longest-gap tracker for one kind of event. */
export interface IdleTracker {
  count: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
  /** The longest gap ever seen between two consecutive ticks, in ms. 0 until a second tick arrives. */
  longestIdleMs: number;
}

export function newIdleTracker(): IdleTracker {
  return { count: 0, firstAtMs: null, lastAtMs: null, longestIdleMs: 0 };
}

/** Records one event at `nowMs`, updating the running longest-gap figure. */
export function tickIdleTracker(tracker: IdleTracker, nowMs: number): void {
  if (tracker.lastAtMs !== null) {
    tracker.longestIdleMs = Math.max(tracker.longestIdleMs, nowMs - tracker.lastAtMs);
  }
  if (tracker.firstAtMs === null) tracker.firstAtMs = nowMs;
  tracker.lastAtMs = nowMs;
  tracker.count += 1;
}

/**
 * How long a real connection may plausibly stay silent between server-sent
 * pings before that silence is more likely a dead stream than a live one.
 *
 * NOT VENDOR-DOCUMENTED — checked, not assumed. Anthropic's own streaming
 * documentation (`platform.claude.com/docs/en/build-with-claude/streaming`,
 * "Ping events") states only "Event streams may also include any number of
 * `ping` events" — no interval, no minimum or maximum cadence, anywhere on
 * that page. There is nothing in the installed SDK's source or changelog
 * that states one either. So this is not "the documented cadence with
 * headroom"; it is a conservative figure chosen because no documented
 * figure exists: common SSE/HTTP infrastructure keep-alive practice keeps
 * idle-connection pings well inside a minute (many proxies and load
 * balancers default to ~60s idle-connection timeouts, which is what a
 * keep-alive exists to stay under), so 120,000ms is at least 2x even a
 * conservative single-minute assumption, while still leaving a genuine
 * 120-second margin inside the 240-second absolute deadline for this
 * watchdog to catch a truly dead stream before the deadline would anyway.
 * Configurable so a real observed cadence — once this instrumentation has
 * actually watched one — can retune it with evidence instead of a second
 * guess.
 */
export const TRANSPORT_IDLE_TIMEOUT_ENV = 'SIDEQUEST_COMPOSER_TRANSPORT_IDLE_MS';
const DEFAULT_TRANSPORT_IDLE_TIMEOUT_MS = 120_000;

export function transportIdleTimeoutMs(): number {
  const raw = process.env[TRANSPORT_IDLE_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_TRANSPORT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TRANSPORT_IDLE_TIMEOUT_MS;
  return Math.floor(value);
}

/** Diagnostic-only snapshot of what a streamed call's transport actually did. Never event content. */
export interface TransportLivenessSnapshot {
  connectedAtMs: number | null;
  firstTransportEventAtMs: number | null;
  lastTransportEventAtMs: number | null;
  transportEventCount: number;
  lastPingAtMs: number | null;
  pingCount: number;
  longestTransportIdleMs: number;
}

export function snapshotTransportLiveness(tracker: IdleTracker, pings: IdleTracker, connectedAtMs: number | null): TransportLivenessSnapshot {
  return {
    connectedAtMs,
    firstTransportEventAtMs: tracker.firstAtMs,
    lastTransportEventAtMs: tracker.lastAtMs,
    transportEventCount: tracker.count,
    lastPingAtMs: pings.lastAtMs,
    pingCount: pings.count,
    longestTransportIdleMs: tracker.longestIdleMs,
  };
}

/**
 * Builds the one middleware this call needs, and the callbacks that read it.
 *
 * `calledAtMs` is the `performance.now()` this method's caller already has —
 * threaded in rather than read again here, so every timestamp in the final
 * diagnostic is relative to the same origin.
 *
 * `onEvent(nowMs)` fires for *every* raw SSE event, ping included — the
 * hook a caller uses to reset an idle watchdog. It never receives the event
 * itself, only that one arrived and when: this file stores counts and
 * timestamps and nothing else, by construction, not by discipline.
 */
export function createTransportLivenessMiddleware(input: {
  calledAtMs: number;
  onEvent: (nowMs: number) => void;
}): { middleware: Middleware; tracker: IdleTracker; pings: IdleTracker; connectedAtMs: { value: number | null } } {
  const tracker = newIdleTracker();
  const pings = newIdleTracker();
  const connectedAtMs = { value: null as number | null };

  const middleware: Middleware = async (request, next, ctx) => {
    const response = await next(request);
    if (ctx.options?.stream && response.ok && response.body) {
      connectedAtMs.value = Math.round(performance.now() - input.calledAtMs);
      // Fire-and-forget: this loop's only job is to update the trackers and
      // call back into the idle-watchdog reset. It must never throw onward —
      // an aborted or ended stream here is exactly the case it exists to
      // observe, not an error in the sense the caller of `next` should hear
      // about.
      void observeRawEvents(response.clone(), input, tracker, pings);
    }
    return response;
  };

  return { middleware, tracker, pings, connectedAtMs };
}

async function observeRawEvents(
  clone: Response,
  input: { calledAtMs: number; onEvent: (nowMs: number) => void },
  tracker: IdleTracker,
  pings: IdleTracker,
): Promise<void> {
  try {
    for await (const sse of Stream.rawEvents(clone) as AsyncGenerator<ServerSentEvent>) {
      const now = Math.round(performance.now() - input.calledAtMs);
      tickIdleTracker(tracker, now);
      if (sse.event === 'ping') tickIdleTracker(pings, now);
      input.onEvent(now);
    }
  } catch {
    // The clone's reader ends when the underlying connection does — by the
    // stream finishing normally, or by the application's own abort tearing
    // it down. Either way there is nothing further to observe, and this
    // loop must never surface an error the main call did not already know
    // about; it is diagnostic-only.
  }
}
