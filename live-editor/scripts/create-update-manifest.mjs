// Run only after both platform installers have been uploaded and verified.
// Publish this file last, together with the release becoming public.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { packageName, releaseIdentity } from '../server/updates.js';

export function createUpdateManifest(release, windows, mac, notes) {
  const version=windows.version,revision=windows.buildRevision;
  releaseIdentity({version,revision});
  if(mac.version!==version||mac.buildRevision!==revision||release.tag_name!==`v${version}`)throw new Error('Platform versions and revisions must match.');
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
  return {schema:1,version,revision,sourceRevision:windows.sourceRevision,notes,platforms};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [releaseFile,windowsFile,macFile,notesFile,output]=process.argv.slice(2);
  if(!output)throw new Error('Usage: node create-update-manifest.mjs release.json windows-build.json macos-build.json notes.json output.json');
  const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
  const manifest=createUpdateManifest(...await Promise.all([releaseFile,windowsFile,macFile,notesFile].map(read)));
  await fs.writeFile(output,JSON.stringify(manifest,null,2)+'\n');
  console.log(`Created update manifest: ${manifest.version}, revision ${manifest.revision}`);
}
