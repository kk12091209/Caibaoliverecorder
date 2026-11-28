import { verify } from 'node:crypto';

export const POLICY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkdbI9u3qIKyNo4m8eKFlmCD8mve+XCU86fa8tF18Ag8=
-----END PUBLIC KEY-----
`;
export const POLICY_CHANNELS = ['stable', 'beta'];
export const POLICY_PLATFORMS = ['bilibili', 'douyin', 'xiaohongshu'];
export const POLICY_LIMIT = 65536;
export const POLICY_FILES = {
  stable: 'caibo-recording-policy.json',
  beta: 'caibo-recording-policy-beta.json',
};

export function policyUid(platform, value) {
  if (!POLICY_PLATFORMS.includes(platform)) return '';
  const uid = typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : '';
  return (platform === 'xiaohongshu' ? /^[a-f0-9]{24}$/ : /^[1-9]\d{0,19}$/).test(uid) ? uid : '';
}

export function readRecordingPolicy(envelope, channel, key = POLICY_PUBLIC_KEY) {
  const invalid = () => new Error('录制规则签名或格式无效。');
  if (envelope?.schema !== 1 || typeof envelope.data !== 'string' ||
      envelope.data.length > POLICY_LIMIT || typeof envelope.signature !== 'string' ||
      envelope.signature.length !== 88) throw invalid();
  const data = Buffer.from(envelope.data, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (data.toString('base64') !== envelope.data || signature.toString('base64') !== envelope.signature ||
      signature.length !== 64 || !verify(null, data, key, signature)) throw invalid();
  const policy = JSON.parse(data.toString('utf8'));
  if (policy.type !== 'caibo-recording-policy' || policy.schema !== 1 ||
      !POLICY_CHANNELS.includes(channel) || policy.channel !== channel ||
      !Number.isSafeInteger(policy.revision) || policy.revision < 1 ||
      !Array.isArray(policy.entries) || policy.entries.length > 500) throw invalid();
  const seen = new Set();
  for (const entry of policy.entries) {
    if (!policyUid(entry?.platform, entry?.uid) || typeof entry.uid !== 'string' ||
        Object.keys(entry).length !== 2) throw invalid();
    const id = entry.platform + ':' + entry.uid;
    if (seen.has(id)) throw invalid();
    seen.add(id);
  }
  return policy;
}
