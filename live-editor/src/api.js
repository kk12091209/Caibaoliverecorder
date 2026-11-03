import { ui } from '../shared/ui-copy.js';
// All frontend requests share the same local-service errors and abort support.
export async function api(route, data, { signal } = {}) {
  let response;
  try {
    response = await fetch('/api/' + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal,
    });
  } catch {
    throw new Error(ui.service.本地服务连接失败);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || ui.service.请求失败);
  return result;
}
