import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {xhsFrame, xhsComments, xhsUserStatus, xhsLoginStatus, MAX_XHS_FRAME} from '../server/xiaohongshu-protocol.js';
import {XiaohongshuWebSession} from '../server/xiaohongshu-web-session.js';
import {XiaohongshuSocketChat} from '../server/xiaohongshu-socket-chat.js';
import {XiaohongshuPlatform} from '../server/xiaohongshu-platform.js';
import {Store} from '../server/store.js';
import {appendChatXml, writeAll} from '../server/flv-recorder.js';
import {XiaohongshuResolver} from '../server/xiaohongshu-room.js';

const uid = '1234567890abcdef12345678';
const other = 'abcdef123456789012345678';
const roomId = '570530566834076942';
const nextRoom = '570530566834076943';
const cookie = 'a1=synthetic-device; web_session=synthetic-session';
const reply = data => ({code: 0, success: true, data});
const onebox = (id = uid, live = {room_id: roomId, user_id: id, status: 2}) =>
  reply({onebox_list: [{type: 'user', user_one_box: {id, title: '主播', live_info: live}}]});
const roomFrame = (text, {id = '90071992547409931234', room = roomId, type = 'text', user = uid} = {}) => ({
  t: 4, b: {d: {biz: 'room', b: [{d: Buffer.from(JSON.stringify({
    roomId: room, roomType: 'LIVE', msgId: id, ts: 100,
    customData: JSON.stringify({type, desc: text, profile: {nickname: '观众', user_id: user}}),
  })).toString('base64')}]}}
});
async function until(check) {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('operation did not settle');
}

test('onebox and usersearch require exact immutable identity and explicit live status', () => {
  assert.equal(xhsUserStatus(onebox(), uid).roomId, roomId);
  const value = onebox().data.onebox_list[0].user_one_box;
  assert.equal(xhsUserStatus(reply({users: [value]}), uid).streaming, true);
  assert.equal(xhsUserStatus(onebox(uid, {user_id: uid, status: 3}), uid).streaming, false);
  for (const value of [onebox(other), onebox(uid, null), onebox(uid, {status: 0}),
    onebox(uid, {status: 2, user_id: other, room_id: roomId}),
    onebox(uid, {status: 2, user_id: uid, room_id: Number(roomId)}),
    reply({onebox_list: [...onebox().data.onebox_list, ...onebox(uid, {status: 2, room_id: nextRoom}).data.onebox_list]}),
  ]) assert.throws(() => xhsUserStatus(value, uid));
  assert.throws(() => xhsUserStatus(onebox(), uid, 406), {kind: 'restricted'});
  assert.equal(xhsLoginStatus(reply({guest: false, user_id: uid})), true);
  assert.equal(xhsLoginStatus(reply({guest: true})), false);
  assert.equal(xhsLoginStatus({code: -101, success: false}), false);
  for (const status of [403, 406, 429]) assert.throws(() => xhsLoginStatus({code: -101, success: false}, status));
  assert.throws(() => xhsLoginStatus(reply({user_id: uid})), {kind: 'unknown'});
});

test('RWP comments preserve UTF-8 and uint64 message identity, isolate rooms and retain repeated text', () => {
  const options = {roomId, sourceStart: 99000, received: 101000};
  const first = xhsComments(xhsFrame(JSON.stringify(roomFrame('醒目文字🌸'))), options);
  assert.equal(first[0].text, '醒目文字🌸');
  assert.equal(first[0].senderId, uid);
  assert.equal(first[0].time, 1);
  assert.equal(first[0].id, xhsComments(roomFrame('醒目文字🌸'), options)[0].id);
  assert.notEqual(first[0].id, xhsComments(roomFrame('醒目文字🌸', {id: '90071992547409931235'}), options)[0].id);
  assert.deepEqual(xhsComments(roomFrame('其他房间', {room: nextRoom}), options), []);
  assert.deepEqual(xhsComments(roomFrame('非文字事件', {type: 'gift'}), options), []);
  assert.deepEqual(xhsComments({...roomFrame('私信'), b: {d: {biz: 'im', b: []}}}, options), []);
  assert.throws(() => xhsFrame('x'.repeat(MAX_XHS_FRAME + 1)));
  assert.deepEqual(xhsComments({t: 4, b: {d: {biz: 'room', b: [{d: 'invalid!?'}]}}}, options), []);
  const routed = roomFrame('已确认的频道');
  const payload = JSON.parse(Buffer.from(routed.b.d.b[0].d, 'base64'));
  delete payload.roomId;delete payload.roomType;
  routed.b.d.b[0].d = Buffer.from(JSON.stringify(payload)).toString('base64');
  assert.deepEqual(xhsComments(routed, options), []);
  assert.equal(xhsComments(routed, {...options, joinedRoom: roomId})[0].text, '已确认的频道');
  assert.deepEqual(xhsComments(roomFrame('其他房间', {room: nextRoom}), {...options, joinedRoom: roomId}), []);
});

test('a restricted profile retains pending UID intent while foreign redirects stay rejected', async () => {
  const resolver = new XiaohongshuResolver({request: async () => new Response('', {status: 406})});
  const result = await resolver.resolve('https://www.xiaohongshu.com/user/profile/' + uid);
  assert.equal(result.uid, uid);
  assert.equal(result.kind, 'profile');
  assert.equal(result.metadata, undefined);
  resolver.request = async () => new Response(null, {status: 302, headers: {location: 'http://127.0.0.1/private'}});
  await assert.rejects(resolver.resolve('https://www.xiaohongshu.com/user/profile/' + uid), /官方/);
});

class PageFixture extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.commands = [];
    this.sequence = 0;
    this.cookies = [];
    this.search = onebox();
    this.me = reply({guest: false, user_id: uid});
    this.status = 200;
  }
  async send(method, params = {}, sessionId) {
    this.commands.push({method, params, sessionId});
    if (method === 'Target.createBrowserContext') return {browserContextId: 'private-context'};
    if (method === 'Storage.setCookies') this.cookies = params.cookies;
    if (method === 'Target.createTarget') return {targetId: 'page-' + ++this.sequence};
    if (method === 'Target.attachToTarget') return {sessionId: 'session-' + this.sequence};
    if (method === 'Network.getResponseBody') return {body: JSON.stringify(this.body)};
    if (method === 'Page.navigate') {
      const url = new URL(params.url), keyword = url.searchParams.get('keyword');
      const pathname = keyword ? '/api/sns/web/v1/search/onebox' : '/api/sns/web/v2/user/me';
      this.body = keyword ? this.search : this.me;
      queueMicrotask(() => {
        this.event(sessionId, 'Network.requestWillBeSent', {requestId: 'api', request: {
          url: 'https://edith.xiaohongshu.com' + pathname, postData: JSON.stringify({keyword})}});
        this.event(sessionId, 'Network.responseReceived', {requestId: 'api', response: {status: this.status}});
        this.event(sessionId, 'Network.loadingFinished', {requestId: 'api'});
      });
    }
    return {};
  }
  event(sessionId, method, params) { this.emit('event', {sessionId, method, params}); }
  async close() { this.closed = true;this.emit('closed'); }
}

test('browser session uses an incognito context, blocks media, scopes cookies and releases response pages', async () => {
  const browser = new PageFixture();
  const session = new XiaohongshuWebSession('unused', {credentials: {get: () => cookie}, browser: async () => browser});
  try {
    assert.equal(await session.verifyCookie({cookie}), true);
    assert.equal(await session.profile(uid).then(value => value.roomId), roomId);
    assert.equal(session.pages.size, 0);
    assert.ok(browser.commands.some(command => command.method === 'Network.setBlockedURLs'));
    assert.equal(browser.cookies.find(cookie => cookie.name === 'web_session').domain, '.xiaohongshu.com');
    browser.status = 406;
    await assert.rejects(session.verifyCookie({cookie}), {kind: 'restricted'});
    assert.equal(session.pages.size, 0);
    await assert.rejects(session.profile('../other'), {kind: 'unknown'});
  } finally { await session.close(); }
  assert.equal(browser.closed, true);
});

test('room connection is confirmed by its own join acknowledgement and closes on credential reset', async () => {
  const browser = new PageFixture(), statuses = [];
  const session = new XiaohongshuWebSession('unused', {credentials: {get: () => cookie}, browser: async () => browser});
  try {
    const page = await session.watchRoom(roomId, {onStatus: value => statuses.push(value), onFrame() {}});
    const id = browser.commands.find(command => command.method === 'Page.navigate').sessionId;
    browser.event(id, 'Network.webSocketCreated', {requestId: 'socket', url: 'wss://apppush-rws.xiaohongshu.com/rwp'});
    browser.event(id, 'Network.webSocketFrameSent', {requestId: 'socket', response: {opcode: 1,
      payloadData: JSON.stringify({t: 2, m: 'join-1', b: {d: {s: 8, b: {info: {roomId, roomType: 'LIVE'}}}}})}});
    browser.event(id, 'Network.webSocketFrameReceived', {requestId: 'socket', response: {opcode: 1,
      payloadData: JSON.stringify({t: 2, m: 'other', b: {a: {c: 0}}})}});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(statuses.length, 0);
    browser.event(id, 'Network.webSocketFrameReceived', {requestId: 'socket', response: {opcode: 1,
      payloadData: JSON.stringify({t: 2, m: 'join-1', b: {a: {c: 0}}})}});
    await until(() => statuses.length);
    assert.deepEqual(statuses, ['connected']);
    await session.reset();
    assert.equal((await page.closed).kind, 'changed');
    assert.equal(session.roomCount, 0);
  } finally { await session.close(); }
});

test('RWP write retries keep their batch, apply shared sampling and preserve XHS sender IDs', async () => {
  let now = 100000, release, callbacks, fail = true;
  const session = {async watchRoom(_room, options) {
    callbacks = options;
    return {closed: new Promise(resolve => {release = resolve;options.signal.addEventListener('abort', () => resolve(Error('stop')), {once: true});}), close: async () => {}};
  }};
  const chat = new XiaohongshuSocketChat({session, now: () => now, flushMs: 60000});
  const written = [];
  chat.start('source', {roomId, sourceStart: 99000}, {status() {}, write: async batch => {
    if (fail) throw Error('disk temporarily busy');
    written.push(...batch.messages);
  }});
  try {
    await until(() => callbacks);
    callbacks.onStatus('connected');
    callbacks.onFrame(roomFrame('相同内容'));
    callbacks.onFrame(roomFrame('相同内容', {id: 'another-message'}));
    callbacks.onFrame(roomFrame('相同内容'));
    now += 2000;
    await chat.flush('source', chat.clients.get('source'));
    assert.equal(chat.snapshot('source').writeFailed, true);
    assert.equal(written.length, 0);
    fail = false;now += 2000;
    await chat.flush('source', chat.clients.get('source'));
    assert.equal(written.length, 2);
    assert.equal(written[0].senderId, uid);
    assert.equal(chat.snapshot('source').written, true);
    assert.equal(chat.snapshot('source').writeFailed, false);
    assert.ok(release);
  } finally { await chat.close(); }
  assert.equal(chat.intake.bytes, 0);
});

test('a partial XML batch is rolled back before retry and leaves earlier messages intact', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xhs-xml-write-'));
  const file = await fs.open(path.join(root, 'chat.xml'), 'ax');
  t.after(async () => {await file.close();await fs.rm(root, {recursive: true, force: true});});
  await writeAll(file, '<i>\n');
  let writes = 0, fail = true;
  const writer = {
    stat: () => file.stat(), truncate: size => file.truncate(size),
    write: async (bytes, offset, length) => {
      writes++;
      if (fail && writes === 2) throw Error('transient write failure');
      return file.write(bytes, offset, fail ? Math.min(3, length) : length);
    },
  };
  await assert.rejects(appendChatXml(writer, '<d>正文</d>\n'));
  assert.equal(await fs.readFile(path.join(root, 'chat.xml'), 'utf8'), '<i>\n');
  fail = false;
  await appendChatXml(writer, '<d>正文</d>\n');
  await writeAll(file, '</i>\n');
  assert.equal(await fs.readFile(path.join(root, 'chat.xml'), 'utf8'), '<i>\n<d>正文</d>\n</i>\n');
});

test('profile monitoring adopts verified new broadcasts and rejects late results after stop', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xhs-profile-'));
  const store = new Store(root);
  let liveRoom = roomId, release;
  const metadata = id => ({webRid: id, roomId: id, ownerId: uid, name: '主播', title: '场次', streaming: false, stream: null});
  const resolver = {
    resolve: async () => ({uid, name: '主播', kind: 'profile'}),
    room: async id => metadata(id),
    profileStatus: async () => ({uid, streaming: true, roomId: liveRoom}),
  };
  const session = {cookie: () => '', close: async () => {}};
  const adapter = new XiaohongshuPlatform(store, {xiaohongshu: {resolver, session, chat: {close: async () => {}}}});
  t.after(async () => {await adapter.close();store.close();await fs.rm(root, {recursive: true, force: true});});
  await adapter.addAnchor({url: 'profile'});
  await adapter.checkProfiles();
  assert.equal(adapter.anchors[0].ownWebRid, roomId);
  liveRoom = nextRoom;
  adapter.nextCheck.clear();
  await adapter.checkProfiles();
  assert.equal(adapter.anchors[0].ownWebRid, nextRoom);
  assert.equal(adapter.core.entries.has(roomId), false);
  resolver.profileStatus = () => new Promise(resolve => {release = resolve;});
  adapter.nextCheck.clear();
  const pending = adapter.checkProfiles();
  await until(() => release);
  await adapter.anchorAction('xiaohongshu-user:' + uid, 'stop');
  release({uid, streaming: true, roomId});
  await pending;
  assert.equal(adapter.anchors[0].enabled, false);
  assert.equal(adapter.anchors[0].ownWebRid, nextRoom);
  assert.equal(adapter.core.entries.has(roomId), false);
});
