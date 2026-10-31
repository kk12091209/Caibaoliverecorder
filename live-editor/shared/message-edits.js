export const MAX_EDITED_NICKNAME = 200;
export const MAX_EDITED_TEXT = 500;

// Display corrections belong to a recording's edit, never to the captured XML
// or the sender identity used by “只看此人弹幕”.
export function validateMessageEdits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('弹幕文本编辑数据无效。');
  const entries = Object.entries(value);
  if (entries.length > 10000) throw new Error('单份素材最多修改 10000 条弹幕。');
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([id, patch]) => {
    if (!id || id.length > 100 || !patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !['user', 'text'].includes(key))) throw new Error('弹幕文本编辑数据无效。');
    for (const [key, label, limit] of [['user', '昵称', MAX_EDITED_NICKNAME], ['text', '弹幕内容', MAX_EDITED_TEXT]]) {
      if (typeof patch[key] !== 'string' || !patch[key].trim() || patch[key].length > limit || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(patch[key]))
        throw new Error(`${label}不能为空，最多 ${limit} 个字符，且不能包含换行或控制字符。`);
    }
    return [id, {user: patch.user, text: patch.text}];
  }));
}

export function applyMessageEdit(message, edits) {
  const patch = message.type === 'd' && edits && Object.hasOwn(edits, message.id) ? edits[message.id] : null;
  return patch ? {...message, originalUser: message.originalUser ?? message.user, originalText: message.originalText ?? message.text,
    user: patch.user, text: patch.text, edited: true} : message;
}

export const messageEditsKey = edits => JSON.stringify(Object.entries(edits || {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, patch]) => [id, patch.user, patch.text]));
