import { gunzipSync } from 'node:zlib';

export const PROTOCOL_LIMITS = Object.freeze({ frameBytes: 8 * 1024 * 1024, decodedBytes: 16 * 1024 * 1024,
  messages: 20000, fields: 100000, chatBytes: 16 * 1024, activityBytes: 128 * 1024 });

// Decode just the fields this application uses. Large user profiles, gifts,
// images and unrelated message bodies remain byte slices, never object trees.
export function* protobufFields(bytes, { maxFields = PROTOCOL_LIMITS.fields } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > PROTOCOL_LIMITS.decodedBytes) throw new Error('弹幕数据包过大。');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0, count = 0;
  const integer = () => {
    let value = 0n;
    for (let shift = 0; shift < 70; shift += 7) {
      if (offset >= data.length) throw new Error('弹幕数据包不完整。');
      const byte = data[offset++];
      if (shift === 63 && byte > 1) throw new Error('弹幕整数字段无效。');
      value |= BigInt(byte & 127) << BigInt(shift);
      if (!(byte & 128)) return value;
    }
    throw new Error('弹幕整数字段无效。');
  };
  while (offset < data.length) {
    if (++count > maxFields) throw new Error('弹幕字段过多。');
    const tag = integer(), field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (field < 1 || field > 536870911) throw new Error('弹幕字段无效。');
    if (wire === 0) yield { field, wire, value: integer() };
    else if (wire === 2) {
      const length = integer();
      if (length > BigInt(data.length - offset)) throw new Error('弹幕数据包不完整。');
      const end = offset + Number(length); yield { field, wire, value: data.subarray(offset, end) }; offset = end;
    } else if (wire === 1 || wire === 5) {
      const end = offset + (wire === 1 ? 8 : 4);
      if (end > data.length) throw new Error('弹幕数据包不完整。');
      yield { field, wire, value: data.subarray(offset, end) }; offset = end;
    } else throw new Error('弹幕字段类型无效。');
  }
}
const record = (bytes, maxFields = 256) => {
  const result = new Map();
  for (const entry of protobufFields(bytes, { maxFields })) {
    if (!result.has(entry.field)) result.set(entry.field, []);
    result.get(entry.field).push(entry);
  }
  return result;
};
const value = (fields, id, wire) => fields.get(id)?.find(entry => entry.wire === wire)?.value;
const text = (fields, id, maximum = 2048) => {
  const bytes = value(fields, id, 2); return bytes && bytes.length <= maximum ? bytes.toString('utf8') : '';
};
const number = (fields, id) => value(fields, id, 0) ?? 0n;
const stamp = integer => {
  if (integer >= 1000000000n && integer <= 9999999999n) return Number(integer * 1000n);
  return integer >= 1000000000000n && integer <= 9999999999999n ? Number(integer) : null;
};
const decimal = integer => integer > 0n ? integer.toString() : '';

export function decodePushFrame(bytes) {
  if (bytes.byteLength > PROTOCOL_LIMITS.frameBytes) throw new Error('弹幕数据包过大。');
  const frame = record(bytes, 128), payload = value(frame, 8, 2);
  if (!payload?.length) return { logId: number(frame, 2), needAck: false, messages: [], internalExt: '' };
  const encoding = text(frame, 6, 32);
  const decoded = encoding === 'gzip' || (payload[0] === 31 && payload[1] === 139)
    ? gunzipSync(payload, { maxOutputLength: PROTOCOL_LIMITS.decodedBytes }) : payload;
  const messages = []; let needAck = false, internalExt = '', serverTime = null, truncated = false, chats=0,activities=0;
  for (const entry of protobufFields(decoded)) {
    if (entry.field === 9 && entry.wire === 0) needAck = entry.value !== 0n;
    else if (entry.field === 5 && entry.wire === 2 && entry.value.length <= 65536) internalExt = entry.value.toString('utf8');
    else if (entry.field === 4 && entry.wire === 0) serverTime = stamp(entry.value);
    else if (entry.field === 1 && entry.wire === 2) {
      const fields = record(entry.value, 64), method = text(fields, 1, 128), body = value(fields, 2, 2);
      if(!body)continue;
      if(method==='WebcastChatMessage'){if(++chats>PROTOCOL_LIMITS.messages){truncated=true;continue;}}
      else if(isLotteryMethod(method)){if(++activities>256){truncated=true;continue;}}
      else if(method!=='WebcastControlMessage')continue;
      else if(++activities>256){truncated=true;continue;}
      messages.push({ method, payload: body, id: decimal(number(fields, 3)) });
    }
  }
  return { logId: number(frame, 2), needAck, internalExt, serverTime, messages, truncated };
}

export function decodeChat(message, { sourceStart, roomId } = {}) {
  if (message.method !== 'WebcastChatMessage' || message.payload.length > PROTOCOL_LIMITS.chatBytes) return null;
  const fields = record(message.payload), commonBytes = value(fields, 1, 2), userBytes = value(fields, 2, 2);
  // Douyin's own danmaku switch identifies lottery participation by chat_by.
  // This works when joining an already active lottery, before any activity
  // notification arrives. Chat tags (19) and priority (21) are unrelated.
  const chatBy = number(fields, 20);
  if (chatBy === 9n || chatBy === 10n) return null;
  if (!commonBytes || !userBytes) return null;
  const common = record(commonBytes), user = record(userBytes);
  const actualRoom = decimal(number(common, 3));
  if (roomId && actualRoom && roomId !== actualRoom) return null;
  const timestamp = stamp(number(fields, 15)) ?? stamp(number(common, 4));
  const content = text(fields, 3, 8192), id = message.id || decimal(number(common, 2));
  if (!content || !id || !Number.isFinite(sourceStart) || timestamp === null || timestamp < sourceStart-2000) return null;
  return { id, timestamp, time: Math.max(0,(timestamp - sourceStart) / 1000), user: text(user, 3, 1024) || '观众', text: content, color: '16777215' };
}

// LotteryInfo/Condition field numbers are documented in the public web SDK
// reference linked in docs/DANMAKU.md. A phrase must explicitly be a comment
// participation condition; a generic follow/gift instruction is not enough.
export const isLotteryMethod=method=>/^WebcastLottery(?:Event(?:New)?Message|Message|InfoSyncData|DrawResultEventMessage)$/.test(method);
export function decodeLottery(message, { roomId, serverTime } = {}) {
  if (!isLotteryMethod(message.method) ||
      message.payload.length > PROTOCOL_LIMITS.activityBytes) return [];
  const result = [], closed = message.method === 'WebcastLotteryDrawResultEventMessage';
  // Current LotteryEventNewMessage carries flattened times and conditions_detail
  // (21), rather than the older nested LotteryInfo/conditions (8) layout.
  let envelope; try { envelope = record(message.payload, 256); } catch { return []; }
  const commonBytes = value(envelope, 1, 2);
  if (commonBytes && ['WebcastLotteryEventNewMessage','WebcastLotteryDrawResultEventMessage'].includes(message.method)) {
    let common; try { common = record(commonBytes, 128); } catch { return []; }
    const actualRoom = decimal(number(common, 3));
    if (actualRoom !== roomId) return [];
    const id = decimal(number(envelope, 2));
    if (!id) return [];
    if (closed) return [{ id: 'fudai:' + id, room: actualRoom, closed: true }];
    const status = number(envelope, 3);
    if ([2n,3n,5n].includes(status)) return [{ id: 'fudai:' + id, room: actualRoom, closed: true }];
    if (status !== 1n) return [];
    const phrases = [];
    for (const condition of envelope.get(21) || []) if (condition.wire === 2) {
      let part; try { part = record(condition.value, 64); } catch { continue; }
      const phrase = text(part, 2, 4096);
      if (number(part, 1) === 3n && phrase.trim() && phrase.length <= 1024) phrases.push(phrase);
    }
    return [{ id: 'fudai:' + id, room: actualRoom, start: stamp(number(envelope, 4)),
      end: stamp(number(envelope, 5)), serverNow: stamp(number(envelope, 6)) ?? serverTime,
      phrases: [...new Set(phrases)], closed: false }];
  }
  function visit(bytes, depth) {
    if (depth > 3 || bytes.length > PROTOCOL_LIMITS.activityBytes) return;
    let fields; try { fields = record(bytes, 256); } catch { return; }
    const room = text(fields, 23, 32) || decimal(number(fields, 5));
    const id = text(fields, 22, 32) || decimal(number(fields, 1));
    const start = stamp(number(fields, 12)), end = stamp(number(fields, 13));
    if (room === roomId && id && start && end) {
      const phrases = [];
      for (const condition of fields.get(8) || []) if (condition.wire === 2) {
        let part; try { part = record(condition.value, 64); } catch { continue; }
        const description = text(part, 5, 2048), phrase = text(part, 3, 4096);
        const type = number(part, 2);
        if (phrase.trim() && phrase.length <= 1024 && (type === 3n ||
            type === 0n && /口令|发送.{0,12}(?:弹幕|评论)|(?:弹幕|评论).{0,12}发送/u.test(description))) phrases.push(phrase);
      }
      const serverNow = stamp(number(fields, 20)) ?? serverTime;
      result.push({ id: 'fudai:' + id, room, start, end, serverNow, phrases: [...new Set(phrases)], closed });
      return;
    }
    for (const list of fields.values()) for (const entry of list) if (entry.wire === 2 && entry.value.length > 4) visit(entry.value, depth + 1);
  }
  visit(message.payload, 0); return result;
}

function integerBytes(input) {
  let number = BigInt(input); if (number < 0n || number > 18446744073709551615n) throw new Error('弹幕整数字段无效。');
  const bytes = []; do { const low = Number(number & 127n); number >>= 7n; bytes.push(low | (number ? 128 : 0)); } while (number);
  return Buffer.from(bytes);
}
export function protobufInteger(field, input) { return Buffer.concat([integerBytes(BigInt(field) << 3n), integerBytes(input)]); }
export function protobufBytes(field, bytes) {
  bytes = Buffer.from(bytes); return Buffer.concat([integerBytes((BigInt(field) << 3n) | 2n), integerBytes(bytes.length), bytes]);
}
export const acknowledgeFrame = (logId, internalExt = '') => Buffer.concat([
  protobufInteger(2, logId), protobufBytes(7, Buffer.from('ack')), protobufBytes(8, Buffer.from(internalExt))]);
export const heartbeatFrame = () => protobufBytes(7, Buffer.from('hb'));
