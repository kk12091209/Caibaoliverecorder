import { Recorder } from './recorder.js';
import { BilibiliRoomResolver } from './room-lookup.js';
import { roomAnchor } from './recorder-platform.js';

export class BilibiliPlatform extends Recorder {
  id = 'bilibili';

  constructor(store, options = {}) {
    super(store, options);
    this.resolver = options.bilibiliResolver || new BilibiliRoomResolver({ credentials: options.credentials });
  }

  get roomSnapshots() {
    return this.rooms.map(room => ({ ...room, platform: this.id }));
  }

  get anchors() {
    return this.roomSnapshots.map(room => roomAnchor(room, 'bilibili:' + room.roomId));
  }

  ownsAnchor(key) {
    return key.startsWith('bilibili:');
  }

  async lookupRoom(id, signal) {
    const room = await this.resolver.room(id, { signal });
    if (!room) return null;
    const roomNumber = String(room.roomId);
    return { ...room, roomNumber, url: 'https://live.bilibili.com/' + roomNumber };
  }

  addAnchor(input) {
    return this.addRoom({ ...input, autoRecord: true });
  }

  async anchorAction(key, action, input) {
    const roomId = Number(key.slice('bilibili:'.length));
    if (action === 'start') {
      await this.setAuto(roomId, true);
      await this.poll();
      return;
    }
    await this.action(roomId, action, input);
  }

  async action(key, action, input) {
    const id = Number(key);
    switch (action) {
      case 'stop': await this.stopRoom(id); break;
      case 'remove': await this.removeRoom(id, input.confirmed); break;
      case 'auto': await this.setAuto(id, input.enabled); break;
      default: await this.startRoom(id);
    }
    await this.poll();
  }

  async exitRoomSnapshots() {
    try {
      return await this.roomsForExit();
    } catch (error) {
      this.error = error.message;
      return this.rooms;
    }
  }

  verifyCookie(options) {
    return this.resolver.verifyCookie(options);
  }

  async applySavedCredentials() {
    if (this.online || this.credentialPending) {
      await this.applyCredentials();
      return;
    }
    this.credentialStatus = {
      applied: false,
      error: this.credentials?.get(this.id) ? '已安全保存，连接录制核心后应用。' : '',
    };
    this.credentialRetry = true;
    this.credentialRetryAt = this.lifecycle.now();
  }
}
