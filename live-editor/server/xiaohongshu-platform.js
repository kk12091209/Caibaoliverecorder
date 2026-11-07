import {FlvRecorder} from './flv-recorder.js';
import {XiaohongshuResolver, XHS_USER_AGENT, isXiaohongshuLink, safeXiaohongshuStream, safeXiaohongshuRedirect} from './xiaohongshu-room.js';
import {XiaohongshuChat} from './xiaohongshu-chat.js';
import {XiaohongshuWebSession} from './xiaohongshu-web-session.js';

const userPrefix = 'xiaohongshu-user:';
const roomPrefix = 'xiaohongshu:';

export class XiaohongshuPlatform {
  id = 'xiaohongshu';

  constructor(store, options = {}) {
    this.store = store;
    this.credentials = options.credentials;
    this.session = options.xiaohongshu?.session || new XiaohongshuWebSession(store.root, {credentials: options.credentials, ...options.xiaohongshu?.browser});
    this.core = new FlvRecorder(store, {
      platform: this.id,
      label: '小红书',
      resolver: new XiaohongshuResolver({session: this.session}),
      chat: new XiaohongshuChat({session: this.session}),
      userAgent: XHS_USER_AGENT,
      referer: 'https://www.xiaohongshu.com/',
      streamUrl: safeXiaohongshuStream,
      streamRedirect: safeXiaohongshuRedirect,
      ...options.xiaohongshu,
    });
    if (this.core.resolver instanceof XiaohongshuResolver && !this.core.resolver.session) this.core.resolver.session = this.session;
    this.targets = new Map();
    this.nextCheck = new Map();
    this.profileErrors = new Map();
    this.profileShutdown = new AbortController();
    this.operations = new Map();
    this.intentVersion = 0;
    this.changedIntent = new Map();
    const saved = store.setting('xiaohongshu-anchors');
    for (const target of Array.isArray(saved) ? saved : []) {
      if (/^[a-f0-9]{24}$/.test(target?.uid || '') && this.targets.size < 64 &&
          (!target.roomId || /^[1-9]\d{0,19}$/.test(target.roomId))) {
        this.targets.set(target.uid, {
          uid: target.uid,
          name: String(target.name || '小红书主播').slice(0, 100),
          roomId: target.roomId || '',
          enabled: target.enabled !== false,
        });
      }
    }
    // A crash between attaching a new broadcast and removing the previous
    // room must not restart an orphan capture on the next launch.
    const associatedRooms = new Set([...this.targets.values()].map(target => target.roomId));
    for (const id of this.core.entries.keys()) {
      if (!associatedRooms.has(id)) this.core.entries.delete(id);
    }
    for (const target of this.targets.values()) {
      if (!target.roomId) continue;
      const room = this.core.entries.get(target.roomId);
      if (room) room.enabled = target.enabled;
      else this.core.entries.set(target.roomId, this.core.entry({webRid: target.roomId, name: target.name, enabled: target.enabled}));
    }
    this.core.validateMetadata = (room, metadata) => {
      const target = [...this.targets.values()].find(target => target.roomId === room.webRid);
      if (target && target.uid !== metadata.ownerId) throw Error('小红书直播间的主播身份已变化，等待重新核验。');
    };
  }

  get resolver() { return this.core.resolver; }
  get online() { return this.core.started && !this.core.closed; }
  get polling() { return this.core.polling || this.checking; }
  get hasEnabledTargets() { return [...this.targets.values()].some(target => target.enabled); }
  get roomSnapshots() { return this.core.rooms; }
  get anchors() {
    const rooms = this.core.rooms;
    return [...this.targets.values()].map(target => {
      const room = rooms.find(room => room.webRid === target.roomId);
      return {
        ...room, ...target,
        key: userPrefix + target.uid, platform: this.id, legacy: false,
        recording: !!room?.recording, ownWebRid: target.roomId,
        state: !target.enabled ? '已停止' : room?.recording ? '本人直播中' :
          this.profileErrors.has(target.uid) ? '待确认：' + this.profileErrors.get(target.uid) :
          room?.error ? '待确认：' + room.error : '监控中，等待核验开播状态',
        history: [],
      };
    });
  }

  save() { this.store.setting('xiaohongshu-anchors', [...this.targets.values()].map(({uid,name,roomId,enabled})=>({uid,name,roomId,enabled}))); }
  matchesLink(input) { return isXiaohongshuLink(input); }
  ownsAnchor(key) { return key.startsWith(roomPrefix) || key.startsWith(userPrefix); }

  // Serialize changes to one broadcaster so an older add/start cannot finish
  // after a newer stop/remove and silently restore that recording intent.
  change(uid, operation) {
    const previous = this.operations.get(uid) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => {
      this.core.assertOpen();
      return operation();
    }).finally(() => {
      if (this.operations.get(uid) === pending) this.operations.delete(uid);
    });
    this.operations.set(uid, pending);
    return pending;
  }

  async lookupRoom(id, signal) {
    if (!/^[1-9]\d{14,19}$/.test(id)) return null;
    const metadata = await this.resolver.room(id, {signal});
    return {...metadata, roomNumber: id, url: 'https://www.xiaohongshu.com/livestream/' + id};
  }

  async addAnchor(input) {
    const version = this.intentVersion;
    const signal = AbortSignal.any([this.core.shutdown.signal, AbortSignal.timeout(15000)]);
    const resolved = await this.resolver.resolve(input.url, {signal});
    return this.change(resolved.uid, async () => {
      if ((this.changedIntent.get(resolved.uid) || 0) > version) throw Error('小红书监控操作已变化，请重新添加。');
      const previous = this.targets.get(resolved.uid);
      if (!previous && this.targets.size >= 64) throw Error('最多同时监控 64 个小红书主播。');
      const target = {...previous, uid: resolved.uid, name: resolved.name, enabled: true,
        roomId: resolved.metadata?.roomId || previous?.roomId || ''};
      if (resolved.metadata) await this.attach(target, resolved.metadata, previous?.roomId);
      else {
        this.targets.set(target.uid, target);
        this.save();
        if (target.roomId && !this.core.entries.get(target.roomId)?.enabled) await this.core.startRoom(target.roomId);
      }
      this.nextCheck.delete(target.uid);
      this.wake();
      return {...this.anchors.find(anchor => anchor.uid === target.uid),
        needsCookie: !this.session.cookie() && !this.credentials?.isExpired('xiaohongshu')};
    });
  }

  addRoom(input) { return this.addAnchor(input); }

  async anchorAction(key, action, input = {}) {
    if (key.startsWith(roomPrefix)) return this.action(key, action, input);
    if (!['start', 'stop', 'remove', 'auto'].includes(action)) throw Error('主播操作无效。');
    this.changedIntent.set(key.slice(userPrefix.length), ++this.intentVersion);
    if (this.checkTarget === key.slice(userPrefix.length)) this.checkAbort?.abort();
    return this.change(key.slice(userPrefix.length), async () => {
      const target = this.targets.get(key.slice(userPrefix.length));
      if (!target) throw Error('小红书监控主播不存在。');
      if (action === 'remove' && input.confirmed !== true) throw Error('请确认移除这个监控主播。');
      if (action !== 'auto') {
        target.enabled = action === 'start';
        this.save();
      }
      if (target.roomId) {
        switch (action) {
          case 'start': await this.core.startRoom(target.roomId); break;
          case 'stop': await this.core.stopRoom(target.roomId); break;
          case 'remove': await this.core.removeRoom(target.roomId, true); break;
          case 'auto': await this.core.setAuto(target.roomId, input.enabled); break;
        }
      }
      if (action === 'remove') {this.targets.delete(target.uid);this.nextCheck.delete(target.uid);this.profileErrors.delete(target.uid);}
      else target.enabled = target.roomId ? this.core.entries.get(target.roomId).enabled :
        action === 'start' || action === 'auto' && input.enabled === true;
      this.save();
      if (target.enabled) {this.nextCheck.delete(target.uid);this.wake();}
    });
  }

  action(key, action, input) {
    const roomId = key.slice(roomPrefix.length);
    const target = [...this.targets.values()].find(target => target.roomId === roomId);
    if (!target) throw Error('小红书监控主播不存在。');
    return this.anchorAction(userPrefix + target.uid, action, input);
  }

  async attach(target, metadata, previousRoom = target.roomId) {
    this.core.assertOpen();
    if (metadata.ownerId !== target.uid) throw Error('小红书主页与直播间的主播身份不一致。');
    target.roomId = metadata.roomId;
    this.targets.set(target.uid, target);
    this.save();
    await this.core.add({webRid: target.roomId, metadata}, true);
    const room = this.core.entries.get(target.roomId);
    if (!room.active) {
      room.metadata = metadata;
      room.streaming = metadata.streaming;
      room.name = metadata.name;
      room.title = metadata.title;
    }
    if (!room.enabled) await this.core.startRoom(target.roomId);
    else this.core.maybeRecord(room);
    if (previousRoom && previousRoom !== target.roomId && this.core.entries.has(previousRoom)) {
      await this.core.removeRoom(previousRoom, true);
    }
  }

  wake() {
    if (!this.core.started || this.core.closed || this.paused || this.checkTimer) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.checkProfiles().finally(() => this.schedule());
    }, 0);
  }

  schedule() {
    if (!this.core.started || this.core.closed || this.paused || this.checkTimer || !this.hasEnabledTargets) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.checkProfiles().finally(() => this.schedule());
    }, 5000);
  }

  checkProfiles() {
    if (this.core.closed || this.paused || !this.resolver.profileStatus) return Promise.resolve();
    if (this.checking) return this.checking;
    const target = [...this.targets.values()].find(target => target.enabled &&
      !this.core.entries.get(target.roomId)?.recording && Date.now() >= (this.nextCheck.get(target.uid) || 0));
    if (!target) return Promise.resolve();
    this.nextCheck.set(target.uid, Date.now() + 120000);
    const version = this.changedIntent.get(target.uid);
    this.checkTarget = target.uid;
    this.checkAbort = new AbortController();
    const signal = AbortSignal.any([this.profileShutdown.signal, this.checkAbort.signal, AbortSignal.timeout(25000)]);
    this.checking = (async () => {
      try {
        const status = await this.resolver.profileStatus(target.uid, {signal});
        if (signal.aborted) return;
        const metadata = status.streaming ? await this.resolver.room(status.roomId, {signal}) : null;
        await this.change(target.uid, async () => {
          if (!target.enabled || this.targets.get(target.uid) !== target ||
              this.changedIntent.get(target.uid) !== version || signal.aborted) return;
          this.profileErrors.delete(target.uid);
          if (typeof status.name === 'string' && status.name && target.name !== status.name.slice(0,100)) {target.name=status.name.slice(0,100);this.save();}
          if (metadata) await this.attach(target, metadata);
        });
      } catch (error) {
        if (!this.core.closed && !this.paused && target.enabled && this.targets.get(target.uid) === target && this.changedIntent.get(target.uid) === version) {
          this.profileErrors.set(target.uid, error.message);
        }
      }
    })().finally(() => { this.checking = null;this.checkAbort = null;this.checkTarget = null; });
    return this.checking;
  }

  verifyCookie(options) { return this.session.verifyCookie(options); }
  setChatRateLimit(value) { this.core.chat.setRateLimit?.(value); }
  async applySavedCredentials() {
    await this.session.reset();
    for (const room of this.core.entries.values()) {
      if (room.sourceId) this.core.chat.update?.(room.sourceId, {}, {reauthenticate: true});
    }
    this.nextCheck.clear();
    this.profileErrors.clear();
    this.wake();
    return 'applied';
  }

  start() { this.core.start();this.wake(); }
  async stopForExit() { this.paused = true;clearTimeout(this.checkTimer);this.checkTimer = null;this.profileShutdown.abort();await this.checking;return this.core.stopForExit(); }
  pauseIdle() { return this.core.pauseIdle(); }
  resume() { this.core.resume();this.paused = false;if(this.profileShutdown.signal.aborted)this.profileShutdown = new AbortController();this.wake(); }
  async close() {
    this.paused = true;
    clearTimeout(this.checkTimer);
    this.profileShutdown.abort();
    await this.checking;
    await this.core.close();
    await Promise.allSettled(this.operations.values());
    await this.session.close();
  }
}
