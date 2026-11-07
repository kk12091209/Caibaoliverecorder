import { FlvRecorder } from './flv-recorder.js';
import { DouyinResolver, DOUYIN_USER_AGENT, safeStreamUrl, safeStreamRedirect } from './douyin-room.js';
import { DouyinChat } from './douyin-chat.js';
import { chatStatusMessage } from './douyin-chat-status.js';

export { xmlText, writeAll, chatXml } from './flv-recorder.js';

export class DouyinRecorder extends FlvRecorder {
  constructor(store, { credentials, ...options } = {}) {
    super(store, {
      platform: 'douyin', label: '抖音',
      resolver: new DouyinResolver({ credentials }), chat: new DouyinChat(),
      userAgent: DOUYIN_USER_AGENT, referer: 'https://live.douyin.com/',
      streamUrl: safeStreamUrl, streamRedirect: safeStreamRedirect, chatStatusMessage,
      ...options,
    });
  }
}
