// Run only after both platform installers have been uploaded and verified.
// Publish this file last, together with the release becoming public.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isPrerelease, packageName, publicationTag } from '../server/updates.js';
import { readSignedManifest } from '../server/update-trust.js';

export function createUpdateManifest(release, windows, mac, notes, preview) {
  const version=windows.version,revision=windows.buildRevision??1;
  const build=windows.buildId===undefined?{}:{buildId:windows.buildId,channel:release.prerelease?'beta':'stable'};
  const tag=publicationTag({version,revision,...build});
  if(release.prerelease!==isPrerelease(tag.slice(1)))throw new Error('GitHub prerelease flag must match the application version.');
  if(mac.version!==version||(mac.buildRevision??1)!==revision||mac.buildId!==windows.buildId||release.tag_name!==tag)throw new Error('Platform versions and build numbers must match.');
  if(!/^[a-f0-9]{40}$/.test(windows.sourceRevision)||mac.applicationSourceRevision!==windows.sourceRevision||mac.releaseRevision!==windows.sourceRevision||release.target_commitish!==windows.sourceRevision)throw new Error('Builds and release must use the same source revision.');
  for(const key of ['nodeTests','coreTests','coreLifecycle','portableZip','portable7z','installerUpgradeUninstall'])if(windows[key]!=='passed')throw new Error(`Windows check did not pass: ${key}`);
  if(mac.nodeTests?.failed!==0||(!Number.isInteger(mac.nodeTests?.passed)||mac.nodeTests.passed<1)||mac.localChecks?.dmgManifest!=='passed'||mac.localChecks?.zipManifest!=='passed')throw new Error('Mac validation did not pass.');
  if(!Array.isArray(notes)||!notes.length||notes.length>12||notes.some(note=>typeof note!=='string'||note.length>500))throw new Error('Provide concise update notes.');
  const platforms={};
  for(const platform of ['win32-x64','darwin-arm64']){
    const name=packageName(version,platform),assets=release.assets.filter(asset=>asset.name===name);
    if(assets.length!==1||assets[0].state!=='uploaded'||!/^sha256:[a-f0-9]{64}$/.test(assets[0].digest)||!Number.isSafeInteger(assets[0].size)||assets[0].size<=0||assets[0].size>512*1024*1024)throw new Error(`Installer is not ready: ${platform}`);
    const asset=assets[0];platforms[platform]={name,size:asset.size,sha256:asset.digest.slice(7)};
  }
  // Keep the legacy wire field so installed 0.1.6 updaters accept this release.
  const manifest={schema:1,version,revision,...build,sourceRevision:windows.sourceRevision,notes,platforms};
  if(preview)verifyPromotion(preview,manifest);
  return manifest;
}

export function verifyPromotion(preview, stable) {
  if(preview.channel!=='beta'||stable.channel!=='stable'||!preview.buildId||preview.buildId!==stable.buildId||
    preview.version!==stable.version||preview.revision!==stable.revision||preview.sourceRevision!==stable.sourceRevision)
    throw new Error('The stable release must use the same tested build.');
  for(const platform of ['win32-x64','darwin-arm64']){
    const before=preview.platforms?.[platform],after=stable.platforms?.[platform];
    if(!before||!after||before.name!==after.name||before.size!==after.size||before.sha256!==after.sha256)
      throw new Error(`Promotion changed the tested installer: ${platform}`);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [releaseFile,windowsFile,macFile,notesFile,output,previewFile]=process.argv.slice(2);
  if(!output)throw new Error('Usage: node create-update-manifest.mjs release.json windows-build.json macos-build.json notes.json output.json');
  const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
  const preview=previewFile?readSignedManifest(await read(previewFile)):undefined;
  const manifest=createUpdateManifest(...await Promise.all([releaseFile,windowsFile,macFile,notesFile].map(read)),preview);
  await fs.writeFile(output,JSON.stringify(manifest,null,2)+'\n');
  console.log(`Created update manifest: ${manifest.version}`);
}
