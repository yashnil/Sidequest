import { describe, expect, it, vi } from 'vitest';
import { onRequestError, requestErrorRecord } from './instrumentation';

/** PRODUCTION PASS — a server error becomes one JSON line with a correlation id and no secrets. */
describe('onRequestError', () => {
  const request = {
    path: '/trips/1b0e7c1e-0000-4000-8000-000000000000/plan?note=my+private+note',
    method: 'POST',
    headers: { 'x-request-id': 'abc123def4567890', 'x-railway-request-id': 'rw-edge-1234', cookie: 'sidequest_session=secret-cookie', authorization: 'Bearer secret' },
  };
  const context = { routerKind: 'App Router', routePath: '/trips/[id]/plan', routeType: 'action', renderSource: 'react-server-components' };

  it('names the request id, the edge id and the route pattern', () => {
    const record = requestErrorRecord(Object.assign(new Error('boom'), { digest: 'd-1' }), request, context);
    expect(record).toMatchObject({ event: 'sidequest_request_error', requestId: 'abc123def4567890', edgeRequestId: 'rw-edge-1234', route: '/trips/[id]/plan', method: 'POST', name: 'Error', digest: 'd-1', message: 'boom' });
  });

  it('never carries cookies, headers, the concrete path or a key-shaped string', () => {
    const line = JSON.stringify(requestErrorRecord(new Error('upstream said api_key=sk-ant-abcdefghijklmnop failed'), request, context));
    for (const leak of ['secret-cookie', 'Bearer', 'my private note', '1b0e7c1e', 'sk-ant-abcdefghijklmnop']) expect(line).not.toContain(leak);
  });

  it('drops a request id that is not a sane token', () => {
    const record = requestErrorRecord('x', { ...request, headers: { 'x-request-id': 'a b\nINJECTED' } }, context);
    expect(record.requestId).toBeNull();
  });

  it('writes exactly one line and never throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => onRequestError(new Error('x'), request, context)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(spy.mock.calls[0]![0]))).not.toThrow();
    spy.mockRestore();
  });
});
