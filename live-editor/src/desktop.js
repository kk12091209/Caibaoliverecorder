import { ui } from '../shared/ui-copy.js';
const pending = new Map();
let counter = 0;
const bridge=window.chrome?.webview;
const macBridge=window.webkit?.messageHandlers?.caibo;
export const isDesktop = !!(bridge||macBridge);
export const isMacDesktop = !!macBridge;
function receive(event) {
  const message = event.data??event.detail, request = pending.get(message?.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
}
if(bridge)bridge.addEventListener('message',receive);
if(macBridge)window.addEventListener('caibo-native',receive);
function post(message){if(bridge)bridge.postMessage(message);else macBridge?.postMessage(message);}
const authorPage = 'https://space.bilibili.com/5162836';
function openPublicPage(url) {
  if (isDesktop) { post({ action: 'openExternal', url }); return; }
  window.open(url, '_blank', 'noopener');
}
export const openAuthorPage = () => openPublicPage(authorPage);
export const openStudioPage = () => openPublicPage('https://www.caibao.media/');
export function pickExportFolder(initial) {
  if (!isDesktop) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const id = String(++counter), timer = setTimeout(() => { pending.delete(id); reject(new Error(ui.desktop.文件夹选择已超时请重试)); }, 300000);
    pending.set(id, { resolve, reject, timer });
    post({ id, action: 'pickExportFolder', initial });
  });
}

export function applyUpdate() {
  if (!isDesktop) return Promise.reject(new Error(ui.desktop.请在桌面应用中更新));
  return new Promise((resolve, reject) => {
    const id=String(++counter),timer=setTimeout(()=>{pending.delete(id);reject(new Error(ui.desktop.更新准备超时请稍后重试));},120000);
    pending.set(id,{resolve,reject,timer});post({id,action:'applyUpdate'});
  });
}

function powerRequest(action) {
  if(!isMacDesktop)return Promise.reject(new Error(ui.desktop.请在Mac桌面应用中查看休眠状态));
  return new Promise((resolve,reject)=>{
    const id=String(++counter),timer=setTimeout(()=>{pending.delete(id);reject(new Error(ui.desktop.桌面回复读取失败));},5000);
    pending.set(id,{resolve,reject,timer});post({id,action});
  });
}
export const getPowerStatus=()=>powerRequest('powerStatus');
export const openPowerSettings=()=>powerRequest('openPowerSettings');
