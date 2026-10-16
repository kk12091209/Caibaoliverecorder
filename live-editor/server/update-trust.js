import { verify } from 'node:crypto';

export const UPDATE_KEY_ID = 'caibao-2026-01';
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZJ8PF5OHwO+1SzOBBrpeyfSXwK4J5/3jPj+m4r3BRVU=
-----END PUBLIC KEY-----
`;

// The private key stays on the release machine, never in the app or web server.
export function readSignedManifest(envelope, publicKey = UPDATE_PUBLIC_KEY) {
  const invalid = () => { throw new Error('菜包更新清单签名无效。'); };
  if (!envelope || envelope.schema !== 1 || envelope.keyId !== UPDATE_KEY_ID || typeof envelope.data !== 'string' || envelope.data.length > 90000 || typeof envelope.signature !== 'string') invalid();
  const bytes = Buffer.from(envelope.data, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (bytes.length > 65536 || bytes.toString('base64') !== envelope.data || signature.length !== 64 || signature.toString('base64') !== envelope.signature || !verify(null, bytes, publicKey, signature)) invalid();
  return JSON.parse(bytes.toString('utf8'));
}
