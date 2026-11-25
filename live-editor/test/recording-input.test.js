import assert from 'node:assert/strict';
import test from 'node:test';
import {openRecordingInput} from '../server/recording-input.js';
import {FLV_HEADER} from '../server/ingest.js';
import {flvTag} from './helpers/source-stream-fixture.js';

const base = 'https://cdn.example/';
const good = Buffer.concat([FLV_HEADER, flvTag(9,0,24,{header:true}), flvTag(9,0,24,{key:true})]);
const candidates = ['one','two','three','four'].map(name => ({protocol:'flv', url:base+name}));
const adapter = request => ({request,userAgent:'test',referer:base,streamUrl:value=>value,streamRedirect:()=>''});

test('probe rotates through failed candidates and keeps every byte of the chosen route', async () => {
  const attempted = [];
  const recorder = adapter(async url => {
    attempted.push(url);
    if (url.endsWith('four')) return new Response(good);
    if (url.endsWith('one')) return new Response('this is not an FLV');
    return new Response(null, {status:503});
  });
  const signal = new AbortController().signal;
  await assert.rejects(openRecordingInput({streams:candidates},recorder,signal),{code:'RECORDING_INPUT_UNAVAILABLE'});
  assert.deepEqual(attempted,candidates.slice(0,3).map(item=>item.url));
  const input = await openRecordingInput({streams:candidates},recorder,signal,1);
  try {
    assert.equal(input.candidate,candidates[3]);
    const frames = [];
    for await (const batch of input.frames) frames.push(...batch);
    assert.deepEqual(Buffer.concat(frames),good);
  } finally { await input.close(); }
});

test('a user stop interrupts a pending first frame and skips all backup routes', async () => {
  const stop = new AbortController();
  const accepting = Promise.withResolvers();
  let calls = 0, cancellations = 0;
  const recorder = adapter(async () => {
    calls++;
    return new Response(new ReadableStream({
      pull(){accepting.resolve();}, cancel(){cancellations++;},
    }));
  });
  const opening = openRecordingInput({streams:candidates},recorder,stop.signal);
  await accepting.promise; stop.abort();
  await assert.rejects(opening,{name:'AbortError'});
  assert.equal(calls,1);assert.equal(cancellations,1);
});
