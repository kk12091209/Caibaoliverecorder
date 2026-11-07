import {createHash, randomUUID} from 'node:crypto';
import {parsePlatformJson} from './linkmic-sei.js';

export const XHS_UID = /^[a-f0-9]{24}$/;
export const XHS_ROOM = /^[1-9]\d{0,19}$/;
export const MAX_XHS_FRAME = 512 * 1024;

export function xhsError(kind, message) {
  return Object.assign(new Error(message), {code: 'XHS_' + kind.toUpperCase(), kind});
}

export function xhsResponse(value, status = 200) {
  if ([403, 406, 461, 471].includes(status)) throw xhsError('restricted', '小红书访问受限，将稍后重试。');
  if (status === 429) throw xhsError('limited', '小红书请求频繁，将稍后重试。');
  if (status === 401) throw xhsError('auth', '小红书需要有效的 Cookie。');
  if (status !== 200 || value?.success !== true || value?.code !== 0) {
    if (status === 200 && [-100, -101].includes(value?.code)) throw xhsError('auth', '小红书登录已失效，请更新 Cookie。');
    throw xhsError('unknown', '小红书响应待确认。');
  }
  return value.data;
}

// A search result identifies a broadcaster only through the immutable UID.
// Missing live_info is unknown, including when the search request succeeded.
export function xhsUserStatus(value, uid, status = 200) {
  if (!XHS_UID.test(uid)) throw xhsError('unknown', '小红书主播身份无效。');
  const data = xhsResponse(value, status);
  const onebox = Array.isArray(data?.onebox_list) ? data.onebox_list : [];
  const users = Array.isArray(data?.users) ? data.users : [];
  if (onebox.length > 100 || users.length > 100) throw xhsError('unknown', '小红书用户响应过大。');
  const records = [...onebox.filter(item => item?.type === 'user').map(item => item.user_one_box), ...users];
  const matches = records.filter(user => user?.id === uid || user?.user_id === uid);
  if (!matches.length) throw xhsError('unknown', '小红书暂未返回目标主播。');
  const states = matches.map(user => {
    const live = user.live_info;
    if (!live || live.user_id && live.user_id !== uid) throw xhsError('unknown', '小红书开播身份待确认。');
    if (live.status === 3) return {uid, streaming: false, roomId: '', name: user.title || user.nickname || ''};
    const roomId = typeof live.room_id === 'string' ? live.room_id : Number.isSafeInteger(live.room_id) ? String(live.room_id) : '';
    if (live.status !== 2 || !XHS_ROOM.test(roomId)) throw xhsError('unknown', '小红书开播状态待确认。');
    return {uid, streaming: true, roomId, name: user.title || user.nickname || ''};
  });
  if (states.some(state => state.streaming !== states[0].streaming || state.roomId !== states[0].roomId)) {
    throw xhsError('unknown', '小红书返回了冲突的直播间信息。');
  }
  return states[0];
}

export function xhsLoginStatus(value, status = 200) {
  if (status === 200 && value?.success === false && [-100, -101].includes(value.code)) return false;
  const data = xhsResponse(value, status);
  if (data?.guest === true) return false;
  if (data?.guest === false && XHS_UID.test(data.user_id || '')) return true;
  throw xhsError('unknown', '小红书登录状态待确认。');
}

export function xhsFrame(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_XHS_FRAME) throw xhsError('protocol', '小红书弹幕帧过大。');
  try { return parsePlatformJson(text); }
  catch { throw xhsError('protocol', '小红书弹幕帧格式待确认。'); }
}

export function xhsComments(frame, {roomId, sourceStart, received = Date.now(), uniqueId = randomUUID, joinedRoom}) {
  const body = frame?.t === 4 ? frame.b?.d : null;
  if (body?.biz !== 'room' || !Array.isArray(body.b)) return [];
  if (body.b.length > 200) throw xhsError('protocol', '小红书弹幕批次过大。');
  const messages = [];
  for (const item of body.b) {
    if (typeof item?.d !== 'string' || item.d.length > MAX_XHS_FRAME || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.d)) continue;
    let payload, custom;
    try {
      payload = xhsFrame(Buffer.from(item.d, 'base64').toString('utf8'));
      custom = typeof payload.customData === 'string' ? xhsFrame(payload.customData) : payload.customData;
    } catch { continue; }
    const actualRoom = typeof payload.roomId === 'string' ? payload.roomId : Number.isSafeInteger(payload.roomId) ? String(payload.roomId) : '';
    if ((actualRoom ? actualRoom !== roomId : joinedRoom !== roomId) ||
        (payload.roomType !== undefined && payload.roomType !== 'LIVE') || custom?.type !== 'text' ||
        typeof custom.desc !== 'string' || !custom.desc || custom.desc.length > 10000) continue;
    const profile = custom.profile || {};
    const identity = payload.msgId || item.msgId || item.msg_id || custom.commentId;
    const id = 'xhs-' + createHash('sha256').update(roomId + '\0' +
      (typeof identity === 'string' && identity.length <= 200 ? identity : uniqueId())).digest('hex');
    const rawTime = Number(custom.current_time || payload.ts);
    const sent = rawTime < 1e11 ? rawTime * 1000 : rawTime;
    const at = Number.isFinite(sent) && sent >= sourceStart - 5000 && sent <= received + 5000 ? sent : received;
    messages.push({id, time: Math.max(0, (at - sourceStart) / 1000), text: custom.desc,
      user: String(profile.nickname || '').slice(0, 200), color: '16777215',
      ...(XHS_UID.test(profile.user_id || '') ? {senderId: profile.user_id} : {})});
  }
  return messages;
}
