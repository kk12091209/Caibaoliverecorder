import fs from 'node:fs/promises';
import { sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { UPDATE_KEY_ID, readSignedManifest } from '../server/update-trust.js';
import { packageName, releaseIdentity } from '../server/updates.js';

export function signUpdateManifest(manifest, privateKey) {
  releaseIdentity(manifest);
  if (manifest.schema !== 1) throw new Error('Invalid update schema.');
  for (const platform of ['win32-x64', 'darwin-arm64']) {
    const item = manifest.platforms?.[platform];
    if (item?.name !== packageName(manifest.version, platform) || !/^[a-f0-9]{64}$/.test(item?.sha256) || !Number.isSafeInteger(item?.size) || item.size <= 0) throw new Error('Both verified installers are required.');
  }
  const bytes = Buffer.from(JSON.stringify(manifest));
  const envelope = { schema: 1, keyId: UPDATE_KEY_ID, data: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') };
  readSignedManifest(envelope);
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || !process.env.CAIBAO_UPDATE_SIGNING_KEY_FILE) throw new Error('Provide manifest, output and CAIBAO_UPDATE_SIGNING_KEY_FILE.');
  const manifest = JSON.parse(await fs.readFile(input, 'utf8'));
  const envelope = signUpdateManifest(manifest, await fs.readFile(process.env.CAIBAO_UPDATE_SIGNING_KEY_FILE));
  await fs.writeFile(output, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  console.log(`Signed Caibao update ${manifest.version}`);
}
