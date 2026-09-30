import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../../server/store.js';
import { FLV_HEADER, Ingestor, retime, sourceStream, tags, timestamp } from '../../server/ingest.js';

// Transport-only fixture: structurally valid FLV tags, deliberately not a
// decodable H.264/AAC stream. No encoder or production recording is involved.
export function flvTag(type, milliseconds, bytes, { key = false, header = false } = {}) {
  const tag = Buffer.alloc(Math.max(8, bytes) + 15, type === 9 ? 0x51 : 0x2a);
  tag[0] = type; tag.writeUIntBE(tag.length - 15, 1, 3);
  tag.writeUIntBE(milliseconds & 0xffffff, 4, 3); tag[7] = milliseconds >>> 24;
  tag.fill(0, 8, 11);
  tag[11] = type === 9 ? (key || header ? 0x17 : 0x27) : 0xaf;
  tag[12] = header ? 0 : 1;
  if (type === 9) tag.fill(0, 13, 16);
  tag.writeUInt32BE(tag.length - 4, tag.length - 4);
  return tag;
}

export async function transportFixture(root, { seconds = 8, start = 17.25, videoBytes = 16384, live = false } = {}) {
  const store = new Store(root), file = path.join(root, 'originals', 'transport.flv');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(Buffer.concat([FLV_HEADER, flvTag(9, 0, 24, { header: true }), flvTag(8, 0, 8, { header: true })]));
    for (let second = 0; second < seconds; second++) {
      const packets = [];
      for (let n = 0; n < 60; n++) packets.push(flvTag(9, Math.round((second + n / 60) * 1000), videoBytes, { key: n === 0 && second % 2 === 0 }));
      for (let n = 0; n < 47; n++) packets.push(flvTag(8, Math.round((second + n / 47) * 1000), 200));
      packets.sort((a, b) => timestamp(a) - timestamp(b));
      await handle.writeFile(Buffer.concat(packets));
    }
  } finally { await handle.close(); }
  const session = store.createSession({ status: live ? 'recording' : 'finished' });
  const source = store.addSource(session.id, file, start, '2026-09-29T12:00:00Z', !live);
  const ingest = new Ingestor(store);
  for (let n = 0; n < Math.ceil(seconds / 10) + 3; n++) await ingest.tick();
  const updated = store.get('SELECT * FROM sources WHERE id=?', source.id);
  if (updated.error) throw new Error(updated.error);
  return { store, session, source: updated, file, ingest };
}

// Baseline copied from the former chunks branch. Kept outside production to
// compare exact emitted bytes and transport overhead without a runtime switch.
export async function* baselineSourceStream(store, sourceId, from, to) {
  const source = store.get('SELECT * FROM sources WHERE id=?', sourceId);
  const key = store.get('SELECT * FROM keyframes WHERE source=? AND time<=? ORDER BY time DESC LIMIT 1', sourceId, from)
    || store.get('SELECT * FROM keyframes WHERE source=? ORDER BY time LIMIT 1', sourceId);
  yield FLV_HEADER;
  const header = JSON.parse(source.header);
  for (const name of ['video', 'audio']) if (header[name]) yield retime(Buffer.from(header[name], 'base64'), 0);
  let seq = key.seq, first = true;
  while (true) {
    const chunk = store.get('SELECT * FROM chunks WHERE source=? AND seq=?', sourceId, seq++);
    if (!chunk) return;
    const data = await fs.readFile(chunk.path), part = first ? data.subarray(key.offset) : data;
    for (const { tag } of tags(part).items) {
      const global = source.start + timestamp(tag) / 1000;
      if (global > to + .1) return;
      yield retime(tag, (global - key.time) * 1000);
    }
    first = false;
  }
}

export async function collect(stream) { const blocks = []; for await (const block of stream) blocks.push(block); return { blocks, bytes: Buffer.concat(blocks) }; }
export { sourceStream };
