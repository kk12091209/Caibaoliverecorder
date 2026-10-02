const pending = new Map();
let counter = 0;
const bridge=window.chrome?.webview;
const macBridge=window.webkit?.messageHandlers?.caibo;
export const isDesktop = !!(bridge||macBridge);
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
export function openAuthorPage() {
  if (isDesktop) { post({ action: 'openExternal', url: authorPage }); return; }
  window.open(authorPage, '_blank', 'noopener');
}
export function pickExportFolder(initial) {
  if (!isDesktop) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const id = String(++counter), timer = setTimeout(() => { pending.delete(id); reject(new Error('文件夹选择已超时，请重试。')); }, 300000);
    pending.set(id, { resolve, reject, timer });
    post({ id, action: 'pickExportFolder', initial });
  });
}

export function openUpdateInstaller() {
  if (!isDesktop) return Promise.reject(new Error('请在桌面应用中打开安装包。'));
  return new Promise((resolve, reject) => {
    const id=String(++counter),timer=setTimeout(()=>{pending.delete(id);reject(new Error('安装包验证超时，请重试。'));},90000);
    pending.set(id,{resolve,reject,timer});post({id,action:'openUpdateInstaller'});
  });
}
