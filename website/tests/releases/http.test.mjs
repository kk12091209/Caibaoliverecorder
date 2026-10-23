import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, networkErrorCode } from '../../scripts/http.mjs';

const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNRESET' }) });

test('connection failure retries with a fresh timeout and then succeeds', async () => {
  const signals = [], delays = [];
  const response = await fetchWithRetry('https://example.invalid', {}, {
    fetchImpl: async (_, options) => { signals.push(options.signal); if (signals.length < 3) throw reset(); return new Response('ok'); },
    sleepImpl: async ms => delays.push(ms),
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(new Set(signals).size, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('permission and certificate errors are not retried, transient failures are bounded', async () => {
  let calls = 0;
  const denied = await fetchWithRetry('https://example.invalid', {}, { fetchImpl: async () => { calls++; return new Response(null, { status: 403 }); } });
  assert.equal(denied.status, 403); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchWithRetry('https://example.invalid', {}, { fetchImpl: async () => { calls++; throw Object.assign(new Error(), { code: 'CERT_HAS_EXPIRED' }); } }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchWithRetry('https://example.invalid', {}, { fetchImpl: async () => { calls++; throw reset(); }, sleepImpl: async () => {} }));
  assert.equal(calls, 3);
});

test('temporary HTTP errors respect a bounded Retry-After and cancel the response body', async () => {
  let calls = 0, cancelled = false; const delays = [];
  const response = await fetchWithRetry('https://example.invalid', {}, {
    fetchImpl: async () => ++calls === 1 ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429, headers: { 'Retry-After': '3600' } }) : new Response(null, { status: 200 }),
    sleepImpl: async ms => delays.push(ms),
  });
  assert.equal(response.status, 200); assert.equal(cancelled, true); assert.deepEqual(delays, [30000]);
});

test('diagnostic code never returns arbitrary messages or request details', () => {
  assert.equal(networkErrorCode(reset()), 'ECONNRESET');
  assert.equal(networkErrorCode(new Error('public check', { cause: reset() })), 'ECONNRESET');
  assert.equal(networkErrorCode({ code: 'https://example.invalid/?token=secret' }), undefined);
});
