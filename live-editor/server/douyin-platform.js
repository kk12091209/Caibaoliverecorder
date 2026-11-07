import { DouyinRecorder } from './douyin-recorder.js';
import { isDouyinLink, resolveDouyinLink } from './douyin-room.js';
import { DouyinUserFollow } from './douyin-user-follow.js';
import { decimal, isDouyinMonitorLink } from './douyin-user-discovery.js';
import { roomAnchor } from './recorder-platform.js';

const roomPrefix = 'douyin:';
const userPrefix = 'douyin-user:';

export class DouyinPlatform {
  id = 'douyin';

  constructor(store, options) {
    this.store = store;
    this.core = new DouyinRecorder(store, { credentials: options.credentials, ...options.douyin });
    this.following = new DouyinUserFollow(store, { recorder: this.core, ...options.douyinFollow });
    this.roomTransfers = new Map();
    this.core.onRoomMetadata = (room, metadata) => this.adoptMonitoredRoom(room, metadata);
  }

  get resolver() { return this.core.resolver; }
  verifyCookie(options) { return this.resolver.verifyCookie(options); }
  get online() { return this.core.started && !this.core.closed; }
  get polling() { return this.core.polling; }
  get roomSnapshots() { return this.core.rooms; }
  get followingSnapshot() { return this.following.snapshot; }
  get hasFollowTargets() { return this.following.targets.size > 0; }
  get hasEnabledFollowTargets() {
    return [...this.following.targets.values()].some(target => target.enabled);
  }

  get anchors() {
    const targets = this.followingSnapshot;
    const rooms = this.roomSnapshots.filter(room => !room.followOnly &&
      !targets.some(target => target.ownWebRid === room.webRid));
    return [
      ...rooms.map(room => roomAnchor(room, room.roomId)),
      ...targets.map(target => ({ ...target, key: userPrefix + target.uid, platform: this.id, legacy: false })),
    ];
  }

  matchesLink(url, kind) {
    return kind === 'anchor' ? isDouyinMonitorLink(url) : isDouyinLink(url);
  }

  ownsAnchor(key) {
    return key.startsWith(roomPrefix) || key.startsWith(userPrefix);
  }

  async lookupRoom(id, signal) {
    const room = await this.resolver.room(id, { signal });
    return room && { ...room, roomNumber: id, url: 'https://live.douyin.com/' + id };
  }

  start() {
    this.core.start();
    this.following.start();
  }

  async adoptMonitoredRoom(room, metadata) {
    if (room.followOnly || this.following.closed || this.core.closed ||
        !decimal(metadata?.ownerId) || this.core.entries.get(room.webRid) !== room) return;
    if (this.roomTransfers.has(room.webRid)) return this.roomTransfers.get(room.webRid);

    const task = (async () => {
      const identity = { uid: metadata.ownerId, name: metadata.name, ownWebRid: room.webRid, secUid: '', profile: '' };
      const target = this.following.register(identity, { enabled: room.enabled });
      if (room.enabled && !target.enabled) {
        target.enabled = true;
        target.state = '监控中，等待开播或连麦';
        this.following.save();
      }
      // Attach the running own-room capture before removing the old room intent.
      if (target.enabled && metadata.streaming && metadata.stream) {
        target.generation++;
        target.abort?.abort();
        await this.following.check(target, { state: 'self-live', metadata });
      }
      if (this.core.entries.get(room.webRid) !== room) return;
      room.followOnly = true;
      room.enabled = false;
      room.autoRecord = false;
      this.core.save();
      await this.core.releaseFollow('', room.webRid);
    })().finally(() => this.roomTransfers.delete(room.webRid));
    this.roomTransfers.set(room.webRid, task);
    return task;
  }

  async addAnchor(input, shutdownSignal) {
    const target = await this.following.addAnchor(input.url);
    const room = this.core.entries.get(target.ownWebRid);
    if (room && !room.followOnly) {
      const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(15000)]);
      const metadata = await this.resolver.room(room.webRid, { signal });
      await this.adoptMonitoredRoom(room, metadata);
    }
    return this.anchors.find(anchor => anchor.key === userPrefix + target.uid);
  }

  async addRoom(input) {
    const room = await resolveDouyinLink(input.url);
    return this.core.add(room, input.autoRecord !== false);
  }

  async anchorAction(key, action, input) {
    if (key.startsWith(userPrefix)) {
      const uid = key.slice(userPrefix.length);
      if (action === 'remove') await this.following.remove(uid, input.confirmed);
      else await this.following.enable(uid, action === 'start');
      return;
    }

    const webRid = key.slice(roomPrefix.length);
    await this.roomTransfers.get(webRid);
    const target = [...this.following.targets.values()].find(item => item.ownWebRid === webRid);
    if (target) return this.anchorAction(userPrefix + target.uid, action, input);
    return this.action(key, action, input);
  }

  async action(key, action, input) {
    this.core.room(key);
    const webRid = key.slice(roomPrefix.length);
    if (action === 'stop' || (action === 'remove' && input.confirmed === true)) {
      await this.following.pauseRoom(webRid);
    }
    if (!this.core.entries.has(webRid) && ['stop', 'remove'].includes(action)) return;
    switch (action) {
      case 'start': await this.core.startRoom(key); break;
      case 'stop': await this.core.stopRoom(key); break;
      case 'auto': await this.core.setAuto(key, input.enabled); break;
      case 'remove': await this.core.removeRoom(key, input.confirmed); break;
    }
  }

  setChatRateLimit(value) { this.core.chat.setRateLimit(value); }
  prepareExit() { return this.following.close(); }
  stopForExit() { return this.core.stopForExit(); }
  pauseIdle() { return this.core.pauseIdle(); }
  resume() { this.core.resume(); }

  async close() {
    await this.following.close();
    await this.core.close();
  }

  async applySavedCredentials() {
    try {
      await this.core.applyCredentials();
      return 'applied';
    } catch {
      this.store.diagnostics?.record('抖音 Cookie', '已更新安全保存项；当前弹幕连接刷新失败，将在后续连接时重试。', { level: '警告' });
      return 'pending';
    }
  }
}
