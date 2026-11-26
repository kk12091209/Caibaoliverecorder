import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editor = fileURLToPath(new URL('../', import.meta.url));
const entry = `
  import Auth from '@renmu/bili-api/dist/base/Auth.js';
  import Platform from '@renmu/bili-api/dist/platform/index.js';
  import User from '@renmu/bili-api/dist/user/index.js';
  export { WebVideoUploader } from '@renmu/bili-api/dist/platform/upload.js';
  export { BiliResponseError } from '@renmu/bili-api/dist/base/Error.js';

  // Same interface as the upstream client for the two services we use.
  export class Client {
    auth = new Auth();
    get user() { return new User(this.auth); }
    get platform() { return new Platform(this.auth); }
    async setAuth(cookie, uid, accessToken) { this.auth.setAuth(cookie, uid, accessToken); }
  }
`;

const packageRoot = /^.*node_modules\/(?:@[^/]+\/)?[^/]+(?=\/)/;
const noticeName = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;
const source = 'https://github.com/renmu123/biliAPI/tree/01cce27f77fdd0600e80275f92b6908868f1762b';
const uploaderPath = path.join(editor, 'node_modules', '@renmu', 'bili-api', 'dist', 'platform', 'upload.js');
const uploaderHash = '6ce988c0c8d2e23f4aece361db0aa0f01a3bc8fdbf40c518478b58a821ea5b08';
let uploadPatched = false;

function replaceExpected(text, needle, replacement, count = 1) {
  if (text.split(needle).length - 1 !== count) throw new Error('The pinned Bilibili SDK transport has changed');
  return text.replaceAll(needle, replacement);
}

const secureUploadTransport = {
  name: 'secure-bilibili-upload-transport',
  setup(builder) {
    builder.onLoad({ filter: /[\\/]@renmu[\\/]bili-api[\\/]dist[\\/]platform[\\/]upload\.js$/ }, async ({ path: filename }) => {
      if (await realpath(filename) !== await realpath(uploaderPath)) throw new Error('Unexpected copy of the Bilibili SDK');
      const bytes = await readFile(filename);
      if (createHash('sha256').update(bytes).digest('hex') !== uploaderHash) {
        throw new Error('Pinned Bilibili SDK upload source differs from the reviewed version');
      }
      let contents = bytes.toString('utf8');
      contents = replaceExpected(contents, 'rejectUnauthorized: false', 'rejectUnauthorized: true', 2);
      contents = replaceExpected(contents, '                    Cookie: this?.auth?.cookie,\n', '');
      contents = replaceExpected(contents, 'import fs from "node:fs";', 'import fs from "node:fs";\nimport { Readable } from "node:stream";');
      contents = replaceExpected(contents, 'timeout: 1000000', 'timeout: 30000');
      contents = replaceExpected(contents, '        while (retryCount >= 0) {\n            try {', `        while (retryCount >= 0) {
            try {
                await this.options.bandwidth?.awaitOpen(options.controller.signal);
                if (options.controller.signal.aborted) return;`);
      contents = replaceExpected(contents, '                await this.uploadChunkApi(options, stream, streamSize);',
        '                await this.uploadChunkApi(options, stream, streamSize);\n                this.options.bandwidth?.confirm(partNumber, streamSize);');
      contents = replaceExpected(contents, '                if (e.code == "ERR_CANCELED") {', `                if (options.controller.signal.aborted) return;
                if (e.code === "CAIBO_UPLOAD_YIELDED") {
                    this.progress[partNumber] = 0;
                    continue;
                }
                if (e.code == "ERR_CANCELED") {`);
      contents = replaceExpected(contents, '            let uploaded = 0;', `            let uploaded = 0;
            const bandwidth = this.options.bandwidth;
            const socketClosed = new AbortController();
            const streamSignal = AbortSignal.any([abortSignal, socketClosed.signal]);
            const source = fileStream;
            if (bandwidth && !Buffer.isBuffer(source)) {
                fileStream = Readable.from((async function* () {
                    for await (const data of source) {
                        await bandwidth.take(data.length, streamSignal);
                        yield data;
                    }
                })(), { objectMode: false, highWaterMark: 1 });
            }`);
      contents = replaceExpected(contents, '                    uploaded += chunk.length;',
        '                    bandwidth?.sent(Number(params.partNumber), uploaded, chunk.length);\n                    uploaded += chunk.length;');
      contents = replaceExpected(contents, '                    reject(new Error(`File stream error: ${error.message}`));',
        '                    reject(error);\n                    req.destroy();');
      contents = replaceExpected(contents, '            req.on("error", error => {',
        `            req.on("timeout", () => {
                const code = bandwidth?.paused() && uploaded < streamSize ? "CAIBO_UPLOAD_YIELDED" : "ETIMEDOUT";
                const error = Object.assign(new Error("Upload request timed out"), { code });
                reject(error);
                req.destroy();
            });
            req.once("close", () => {
                socketClosed.abort();
                if (!Buffer.isBuffer(fileStream)) fileStream.destroy();
                if (!Buffer.isBuffer(source)) source.destroy();
            });
            req.on("error", error => {`);
      contents = replaceExpected(contents, '                let responseData = "";\n                res.on("data", chunk => {\n                    responseData += chunk;\n                });',
        '                res.on("data", () => {});');
      contents = replaceExpected(contents, 'reject(new Error(`Upload failed with status: ${res.statusCode}, response: ${responseData}`));',
        'reject(Object.assign(new Error("Upload response was unsuccessful"), { statusCode: res.statusCode }));');
      contents = replaceExpected(contents, 'reject(new Error(`Upload request failed: ${error.message}`));',
        'reject(new Error("Upload request failed", { cause: error }));');
      contents = replaceExpected(contents, 'this.request.post(url, "", {',
        'this.request.post(url, "", {\n            maxRedirects: 0,');
      contents = replaceExpected(contents, 'this.request.post(url, {}, {',
        'this.request.post(url, {}, {\n            maxRedirects: 0,\n            httpsAgent: new https.Agent({ rejectUnauthorized: true }),');
      for (const method of ['getUploadInfoApi', 'mergeVideoApi']) {
        const start = contents.indexOf(`    async ${method}(`);
        const end = contents.indexOf('\n    }', start);
        if (start < 0 || end < 0) throw new Error(`Missing Bilibili upload method ${method}`);
        const patched = replaceExpected(contents.slice(start, end), 'rawResponse: true,', 'rawResponse: true,\n                useCookie: false,');
        contents = contents.slice(0, start) + patched + contents.slice(end);
      }
      uploadPatched = true;
      return { contents, loader: 'js' };
    });
  },
};

async function readNotice(directory, name) {
  const files = (await readdir(directory)).filter(file => noticeName.test(file)).sort();
  if (files.length) {
    return (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).join('\n\n');
  }
  // These two npm packages put their complete MIT license in the README.
  if (name === 'agent-base' || name === 'https-proxy-agent') {
    const readme = await readFile(path.join(directory, 'README.md'), 'utf8');
    const text = readme.match(/\(The MIT License\)[\s\S]*?(?=\n#{1,6}\s|$)/)?.[0];
    if (text?.includes('THE SOFTWARE IS PROVIDED')) return text;
  }
  throw new Error(`Missing license text for ${name}`);
}

async function notices(inputs) {
  const { packages } = JSON.parse(await readFile(path.join(editor, 'package-lock.json'), 'utf8'));
  const included = new Set(Object.keys(inputs).filter(file => inputs[file].bytesInOutput > 0)
    .map(file => file.replaceAll('\\', '/').match(packageRoot)?.[0]).filter(Boolean));
  if (!included.has('node_modules/@renmu/bili-api')) throw new Error('Missing npm provenance for the Bilibili upload SDK');
  const sections = [`Bilibili upload library source (@renmu/bili-api 2.15.2): ${source}`,
    'Caibo changes the upload transport in scripts/build-bilibili-upload-sdk.mjs to verify TLS, keep account cookies off the upload CDN, prevent redirects, time out idle requests, and share a recording-aware budget across uploads.',
    'The release source contains these changes and the dependency lockfile.'];
  for (const key of [...included].sort()) {
    const locked = packages[key];
    if (!locked?.integrity || !locked?.resolved) throw new Error(`Missing npm lock entry: ${key}`);
    const dir = path.join(editor, key);
    const { name, version, license, repository } = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    if (version !== locked.version) throw new Error(`Installed ${name} does not match package-lock.json`);
    sections.push([
      `${name} ${version} (${license})`,
      `Upstream: ${repository?.url || repository || `https://www.npmjs.com/package/${name}/v/${version}`}`,
      `Package: ${locked.resolved}`,
      `Integrity: ${locked.integrity}`,
      await readNotice(dir, name),
    ].join('\n'));
  }
  return sections.join('\n\n').trimEnd() + '\n';
}

const [bundleArg, noticeArg] = process.argv.slice(2);
if (!bundleArg || !noticeArg) throw new Error('Usage: node build-bilibili-upload-sdk.mjs <bundle> <notices>');
const output = path.resolve(bundleArg);
const notice = path.resolve(noticeArg);
if (output === notice) throw new Error('Bundle and notices must be separate files');
const result = await build({
  absWorkingDir: editor,
  stdin: { contents: entry, resolveDir: editor },
  outfile: output,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'inline',
  metafile: true,
  write: false,
  plugins: [secureUploadTransport],
});
const [metadata] = Object.values(result.metafile.outputs);
if (!uploadPatched) throw new Error('The Bilibili upload transport was not patched');
if (result.outputFiles.length !== 1 || metadata.imports.some(item => !item.external || !isBuiltin(item.path))) {
  throw new Error('The upload library must be self-contained except for Node built-ins');
}
const text = await notices(metadata.inputs);
await Promise.all([mkdir(path.dirname(output), { recursive: true }), mkdir(path.dirname(notice), { recursive: true })]);
await writeFile(output, result.outputFiles[0].contents);
await writeFile(notice, text);
const sdk = createRequire(import.meta.url)(output);
for (const symbol of ['Client', 'WebVideoUploader', 'BiliResponseError']) {
  if (typeof sdk[symbol] !== 'function') throw new Error(`Invalid upload library export: ${symbol}`);
}
