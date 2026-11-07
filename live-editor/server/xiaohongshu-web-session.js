import {createHash} from 'node:crypto';
import {launchXhsBrowser} from './xiaohongshu-browser.js';
import {parsePlatformJson} from './linkmic-sei.js';
import {xhsError, xhsFrame, xhsUserStatus, xhsLoginStatus, MAX_XHS_FRAME, XHS_UID, XHS_ROOM} from './xiaohongshu-protocol.js';

const ORIGIN = 'https://www.xiaohongshu.com';
const SEARCH_APIS = new Set(['/api/sns/web/v1/search/onebox', '/api/sns/web/v1/search/usersearch']);
const ME_API = '/api/sns/web/v2/user/me';
const PUSH_HOST = 'apppush-rws.xiaohongshu.com';

// Cookies enter an incognito context through a local pipe. The official page
// owns signing, token refresh and RWP authentication. No signing blob or user
// credentials are written into argv, logs, ordinary settings or source files.
export class XiaohongshuWebSession {
  constructor(root, {credentials, browser = launchXhsBrowser, now = Date.now, timeoutMs = 25000, maxRooms = 4} = {}) {
    Object.assign(this, {root, credentials, browser, now, timeoutMs, maxRooms});
    this.shutdown = new AbortController();
    this.pages = new Set();
    this.roomCount = 0;
    this.blockedUntil = 0;
    this.searchQueue = Promise.resolve();
  }

  cookie() { return this.credentials?.get('xiaohongshu') || ''; }

  async context(cookie = this.cookie()) {
    if (!cookie) throw xhsError('auth', '小红书弹幕与开播识别需要有效的 Cookie。');
    if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason;
    if (this.now() < this.blockedUntil) throw xhsError('restricted', '小红书访问受限，正在等待重试。');
    if (cookie !== this.cookie()) throw xhsError('changed', '小红书 Cookie 已更新。');
    const key = createHash('sha256').update(cookie).digest('hex');
    if (this.connection && !this.connection.closed && this.contextKey === key) return this.contextId;
    if (this.opening) { await this.opening; return this.context(cookie); }
    this.opening = (async () => {
      if (!this.connection || this.connection.closed) this.connection = await this.browser(this.root);
      if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason;
      await this.disposeContext();
      const result = await this.connection.send('Target.createBrowserContext', {disposeOnDetach: true});
      this.contextId = result.browserContextId;
      const cookies = cookie.split(';').map(item => {
        const at = item.indexOf('=');
        return {name: item.slice(0, at).trim(), value: item.slice(at + 1).trim(),
          domain: item.slice(0, at).trim() === 'acw_tc' ? 'edith.xiaohongshu.com' : '.xiaohongshu.com', path: '/', secure: true, sameSite: 'Lax'};
      });
      await this.connection.send('Storage.setCookies', {cookies, browserContextId: this.contextId});
      this.contextKey = key;
    })().finally(() => { this.opening = null; });
    await this.opening;
    return this.context(cookie);
  }

  async disposeContext() {
    const id = this.contextId;
    this.contextId = this.contextKey = null;
    await Promise.all([...this.pages].map(page => page.close(xhsError('changed', '小红书 Cookie 已更新，正在重新连接。'))));
    if (id && !this.connection?.closed) await this.connection.send('Target.disposeBrowserContext', {browserContextId: id}).catch(() => {});
  }

  async reset() {
    this.blockedUntil = 0;
    await this.opening?.catch(() => {});
    await this.disposeContext();
    if (!this.cookie()) {await this.connection?.close();this.connection = null;}
  }

  async page({signal, cookie, onEvent}) {
    const context = await this.context(cookie);
    signal = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    signal.throwIfAborted();
    const connection = this.connection;
    const target = await connection.send('Target.createTarget', {url: 'about:blank', browserContextId: context, background: true}, undefined, signal);
    let sessionId, closing, settle;
    const page = {
      closed: new Promise(resolve => { settle = resolve; }),
      ended: false,
      send: (method, params) => connection.send(method, params, sessionId, signal),
      close: error => closing ??= (async () => {
        page.ended = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        connection.removeListener('event', event);
        connection.removeListener('closed', disconnected);
        this.pages.delete(page);
        settle(error || xhsError('closed', '小红书网页采集已停止。'));
        if (!connection.closed) await connection.send('Target.closeTarget', {targetId: target.targetId}).catch(() => {});
      })(),
    };
    const abort = () => { void page.close(signal.reason); };
    const disconnected = () => { void page.close(xhsError('browser', '小红书网页会话已断开。')); };
    const deadline = setTimeout(() => { void page.close(xhsError('timeout', '小红书网页连接超时。')); }, this.timeoutMs);
    page.connected = () => clearTimeout(deadline);
    const event = message => {
      void Promise.resolve().then(() => {
      if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId === sessionId) {
        disconnected();
        return;
      }
      if (message.sessionId !== sessionId || page.ended) return;
      if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        const url = new URL(message.params.frame.url);
        if (url.protocol === 'chrome-error:') {void page.close(xhsError('network', '小红书网页暂时无法连接，将稍后重试。'));return;}
        if (url.hostname === 'www.xiaohongshu.com' && url.pathname.startsWith('/website-login')) {
          const restricted = url.pathname.includes('/error');
          if (restricted) this.blockedUntil = this.now() + 120000;
          void page.close(xhsError(restricted ? 'restricted' : 'auth',
            restricted ? '小红书网页访问受限，将稍后重试。' : '小红书需要有效的 Cookie，请在设置中更新。'));
          return;
        }
      }
      if (message.method === 'Network.responseReceived' && message.params.type === 'Document') {
        const status = message.params.response.status;
        if ([403,406,429,461,471].includes(status)) {
          this.blockedUntil = this.now() + 120000;
          void page.close(xhsError(status === 429 ? 'limited' : 'restricted', '小红书网页访问受限，将稍后重试。'));
          return;
        }
      }
      return onEvent(message, page);
      }).catch(error => { void page.close(error); });
    };
    this.pages.add(page);
    connection.on('event', event);
    connection.on('closed', disconnected);
    signal.addEventListener('abort', abort, {once: true});
    try {
      sessionId = (await connection.send('Target.attachToTarget', {targetId: target.targetId, flatten: true}, undefined, signal)).sessionId;
      await page.send('Page.enable', {});
      await page.send('Network.enable', {maxTotalBufferSize: 2 * 1024 * 1024, maxResourceBufferSize: MAX_XHS_FRAME});
      await page.send('Network.setBlockedURLs', {urls: ['*.flv*', '*.m3u8*', '*.ts', '*.m4s*', '*.mp4*']});
      if (signal.aborted) throw signal.reason;
      return page;
    } catch (error) { await page.close(error); throw error; }
  }

  async query(url, {signal, cookie, paths, keyword, read}) {
    let value, completed = false;
    const eligible = new Set(), responses = new Map();
    const page = await this.page({signal, cookie, onEvent: async (message, page) => {
      const {method, params} = message;
      if (method === 'Network.requestWillBeSent') {
        const requestUrl = new URL(params.request.url);
        if (requestUrl.hostname !== 'edith.xiaohongshu.com' || !paths.has(requestUrl.pathname)) return;
        if (keyword) {
          let data;
          try { data = parsePlatformJson(params.request.postData || ''); } catch { return; }
          if ((data.keyword || data.search_user_request?.keyword) !== keyword) return;
        }
        if (eligible.size < 32) eligible.add(params.requestId);
      } else if (method === 'Network.responseReceived' && eligible.has(params.requestId)) {
        responses.set(params.requestId, params.response.status);
      } else if (method === 'Network.loadingFinished' && responses.has(params.requestId) && !completed) {
        const status = responses.get(params.requestId);
        responses.delete(params.requestId);
        const reply = await page.send('Network.getResponseBody', {requestId: params.requestId});
        const body = reply.base64Encoded ? Buffer.from(reply.body, 'base64').toString('utf8') : reply.body;
        if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_XHS_FRAME) throw xhsError('protocol', '小红书响应过大。');
        value = read(parsePlatformJson(body), status);
        completed = true;
        await page.close();
      }
    }});
    try {
      const navigation = await page.send('Page.navigate', {url});
      if (navigation.errorText) throw xhsError('network', '小红书网页暂时无法连接，将稍后重试。');
      const error = await page.closed;
      if (!completed) throw error;
      return value;
    } finally { await page.close(); }
  }

  profile(uid, {signal} = {}) {
    if (!XHS_UID.test(uid)) return Promise.reject(xhsError('unknown', '小红书主播身份无效。'));
    const work = this.searchQueue.catch(() => {}).then(() => this.query(
      ORIGIN + '/search_result?keyword=' + encodeURIComponent(uid) + '&source=web_explore_feed',
      {signal, paths: SEARCH_APIS, keyword: uid, read: (value, status) => xhsUserStatus(value, uid, status)}));
    this.searchQueue = work;
    return work;
  }

  verifyCookie({cookie, signal}) {
    return this.query(ORIGIN + '/explore', {cookie, signal, paths: new Set([ME_API]), read: xhsLoginStatus});
  }

  async watchRoom(roomId, {signal, onFrame, onStatus}) {
    if (!XHS_ROOM.test(roomId)) throw xhsError('unknown', '小红书直播间身份无效。');
    if (this.roomCount >= this.maxRooms) throw xhsError('capacity', '小红书弹幕会话已达并发上限，录像继续采集。');
    this.roomCount++;
    let page;
    const sockets = new Set(), joins = new Map(), joined = new Set();
    try {
      page = await this.page({signal, onEvent: (message, page) => {
        const {method, params} = message;
        if (method === 'Network.webSocketCreated') {
          const url = new URL(params.url);
          if (url.protocol === 'wss:' && url.hostname === PUSH_HOST && url.pathname === '/rwp') sockets.add(params.requestId);
        }
        if (!sockets.has(params.requestId)) return;
        if (method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') {
          void page.close(xhsError('socket', '小红书弹幕连接断开，正在重试。'));
        } else if (method === 'Network.webSocketFrameSent' && params.response.opcode === 1) {
          const frame = xhsFrame(params.response.payloadData);
          const info = frame.b?.d?.b?.info;
          if (frame.t === 2 && typeof frame.m === 'string' && frame.m.length <= 200) {
            const step = frame.b?.d?.s;
            if (step === 0 || step === 8 && info?.roomId === roomId && info.roomType === 'LIVE') {
              joins.set(frame.m, {socket: params.requestId, room: step === 8});
              while (joins.size > 64) joins.delete(joins.keys().next().value);
            }
          }
        } else if (method === 'Network.webSocketFrameReceived' && params.response.opcode === 1) {
          const frame = xhsFrame(params.response.payloadData);
          const acknowledgement = joins.get(frame.m);
          if (acknowledgement?.socket === params.requestId) {
            joins.delete(frame.m);
            if (frame.b?.a?.c !== 0) throw xhsError('auth', '小红书弹幕认证或入房未获确认，请检查 Cookie。');
            if (acknowledgement.room) {
              joined.add(params.requestId);
              page.connected();
              onStatus('connected');
            }
          }
          if (onFrame(frame, {joinedRoom: joined.has(params.requestId) ? roomId : undefined})) page.connected();
        }
      }});
      const close = page.close;
      let released = false;
      page.close = async error => {
        await close(error);
        if (!released) { released = true; this.roomCount--; }
      };
      const navigation = await page.send('Page.navigate', {url: ORIGIN + '/livestream/' + roomId});
      if (navigation.errorText) throw xhsError('network', '小红书直播网页暂时无法连接，将稍后重试。');
      return page;
    } catch (error) {
      if (page) await page.close(error);
      else this.roomCount--;
      throw error;
    }
  }

  async close() {
    this.shutdown.abort();
    await this.opening?.catch(() => {});
    await this.disposeContext();
    await this.connection?.close();
  }
}
