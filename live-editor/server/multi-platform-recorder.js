import { BilibiliPlatform } from './bilibili-platform.js';
import { DouyinPlatform } from './douyin-platform.js';
import { XiaohongshuPlatform } from './xiaohongshu-platform.js';
import { discoverRoomNumber, numericRoomId } from './room-lookup.js';

export class MultiPlatformRecorder {
  constructor(store, options = {}) {
    this.store = store;
    this.bilibili = new BilibiliPlatform(store, options);
    this.douyin = new DouyinPlatform(store, options);
    this.xiaohongshu = new XiaohongshuPlatform(store, options);
    this.platforms = new Map([this.bilibili, this.douyin, this.xiaohongshu].map(platform => [platform.id, platform]));
  }

  get rooms() {
    return [...this.platforms.values()].flatMap(platform => platform.roomSnapshots);
  }

  get anchors() {
    return [...this.platforms.values()].flatMap(platform => platform.anchors);
  }

  get starting() { return this.bilibili.starting; }
  get pollBusy() { return this.bilibili.pollBusy || !!this.douyin.polling || !!this.xiaohongshu.polling; }
  get port() { return this.bilibili.port; }
  get connectionPending() {
    return !this.bilibili.online && (this.bilibili.rooms.length > 0 ||
      (!this.douyin.roomSnapshots.length && !this.douyin.hasFollowTargets && !this.xiaohongshu.targets.size));
  }
  get hasEnabledFollowTargets() { return this.douyin.hasEnabledFollowTargets || this.xiaohongshu.hasEnabledTargets; }

  statusSnapshot() {
    return {
      online: [...this.platforms.values()].some(platform => platform.online),
      biliOnline: this.bilibili.online,
      douyinOnline: this.douyin.online,
      xiaohongshuOnline: this.xiaohongshu.online,
      error: this.bilibili.error,
    };
  }

  start() {
    this.douyin.start();
    this.xiaohongshu.start();
    return this.bilibili.start();
  }

  platformForLink(url, kind) {
    return [...this.platforms.values()].find(platform => platform.matchesLink?.(url, kind)) ?? this.bilibili;
  }

  async lookupInput(input, kind) {
    const number = numericRoomId(input.url);
    if (!number) return { input, platform: this.platformForLink(input.url, kind) };

    const signal = AbortSignal.any([this.bilibili.shutdown.signal, AbortSignal.timeout(10000)]);
    const { candidates, unavailable } = await discoverRoomNumber(number, this.platforms.values(), { signal });
    this.bilibili.assertOpen();
    if (!candidates.length) {
      if (kind === 'anchor') {
        throw Error(unavailable.length ? '主播查询失败，请重试或使用分享链接。' : '未找到主播，请检查房间号。');
      }
      throw Error(unavailable.length ? '房间查询失败，请重试或使用直播链接。' : '未找到直播间，请检查房间号。');
    }
    if (candidates.length > 1 || unavailable.length) {
      return { selection: { needsSelection: true, candidates, unavailable } };
    }
    const candidate = candidates[0];
    return { input: { ...input, url: candidate.url }, platform: this.platforms.get(candidate.platform) };
  }

  async addAnchor(input) {
    this.bilibili.assertOpen();
    const target = await this.lookupInput(input, 'anchor');
    if (target.selection) return target.selection;
    return target.platform.addAnchor(target.input, this.bilibili.shutdown.signal);
  }

  async addRoom(input) {
    const target = await this.lookupInput(input, 'room');
    if (target.selection) return target.selection;
    return target.platform.addRoom(target.input);
  }

  platformForAnchor(key) {
    return [...this.platforms.values()].find(platform => platform.ownsAnchor(key));
  }

  async anchorAction(key, action, input = {}) {
    if (!['start', 'stop', 'remove'].includes(action)) throw Error('主播操作无效。');
    const id = String(key);
    const platform = this.platformForAnchor(id);
    if (!platform) throw Error('监控主播不存在。');
    return platform.anchorAction(id, action, input);
  }

  action(key, action, input = {}) {
    const id = String(key);
    const separator = id.indexOf(':');
    const prefix = separator < 0 ? '' : id.slice(0, separator);
    const platform = this.platforms.get(prefix) ?? this.bilibili;
    return platform.action(id, action, input);
  }

  // Legacy material projection still reads the same persisted room and follow
  // records. Its identity schema will be handled separately.
  materialOrigins(sessions) {
    if (!sessions.length) return sessions;
    const bySession = new Map();
    const placeholders = sessions.map(() => '?').join(',');
    const rows = this.store.all(
      `SELECT DISTINCT m.session,i.uid,i.name,i.host,i.kind,i.web_rid
       FROM douyin_follow_materials m JOIN douyin_follow_intervals i ON i.id=m.interval
       WHERE m.session IN (${placeholders})`,
      ...sessions.map(session => session.id),
    );
    for (const row of rows) {
      const list = bySession.get(row.session) || [];
      list.push(row);
      bySession.set(row.session, list);
    }
    return sessions.map(session => {
      const monitoring = bySession.get(session.id) || [];
      const origin = this.store.setting('xiaohongshu-session:' + session.id) || this.store.setting('douyin-session:' + session.id);
      const room = this.bilibili.rooms.find(room => Number(room.roomId) === session.room);
      const captureKinds = monitoring.length
        ? [...new Set(monitoring.map(item => item.kind === 'guest' ? 'guest' : 'self'))]
        : session.room > 0 || origin ? ['self'] : [];
      return { ...session, platform:origin?.platform||(session.room>0?'bilibili':'unknown'), monitoring, hostName: origin?.hostName || monitoring[0]?.host || room?.name || '', captureKinds };
    });
  }

  async roomsForExit() {
    const rooms = await this.bilibili.exitRoomSnapshots();
    return [...rooms, ...this.douyin.roomSnapshots, ...this.xiaohongshu.roomSnapshots];
  }

  rememberExitRooms(rooms) {
    this.bilibili.rememberExitRooms(rooms.filter(room => !room.platform || room.platform === this.bilibili.id));
  }

  async stopForExit(rooms) {
    await this.douyin.prepareExit();
    const results = await Promise.allSettled([...this.platforms.values()].map(platform =>
      platform.stopForExit(rooms.filter(room => (room.platform || this.bilibili.id) === platform.id)),
    ));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  async stopIdle() {
    if (this.hasEnabledFollowTargets || !await this.douyin.pauseIdle()) return false;
    if(!await this.xiaohongshu.pauseIdle()){this.douyin.resume();return false;}
    const stopped = await this.bilibili.stopIdle();
    if (!stopped) {this.douyin.resume();this.xiaohongshu.resume();}
    return stopped;
  }

  async close() {
    this.bilibili.close();
    await Promise.all([this.douyin.close(),this.xiaohongshu.close()]);
  }
}
