import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadUrl } from '../../src/features/catalog/lib/download-url.ts';
const base='https://download.caibao.media/caibo-recorder/0.3.6/file.exe',sha='a'.repeat(64);
test('canonical and content-keyed catalogs both produce a cache-safe browser download',()=>{
 assert.equal(downloadUrl(base,sha),`${base}?sha256=${sha}`);
 assert.equal(downloadUrl(`${base}?sha256=${sha}`,sha),`${base}?sha256=${sha}`);
 assert.notEqual(downloadUrl(base,'b'.repeat(64)),downloadUrl(base,sha));
 assert.equal(downloadUrl(base),base);
});
test('content keys cannot introduce other origins, credentials, ports, fragments or arbitrary parameters',()=>{
 for(const url of ['http://download.caibao.media/file','https://other.test/file','https://user:password@download.caibao.media/file','https://download.caibao.media:8443/file',`${base}#part`,`${base}?sha256=${'b'.repeat(64)}`,`${base}?redirect=https://other.test`,`${base}?sha256=${sha}&extra=1`])assert.throws(()=>downloadUrl(url,sha));
 assert.throws(()=>downloadUrl(`${base}?sha256=${sha}`));
});
