const pending = new Map();
let counter = 0;
export const isDesktop = !!window.chrome?.webview;
if (isDesktop) window.chrome.webview.addEventListener('message', event => {
  const message = event.data, request = pending.get(message?.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
});
export function pickExportFolder(initial) {
  if (!isDesktop) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const id = String(++counter), timer = setTimeout(() => { pending.delete(id); reject(new Error('文件夹选择已超时，请重试。')); }, 300000);
    pending.set(id, { resolve, reject, timer });
    window.chrome.webview.postMessage({ id, action: 'pickExportFolder', initial });
  });
}
