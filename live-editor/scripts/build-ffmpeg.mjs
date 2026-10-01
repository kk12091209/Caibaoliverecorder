import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{project:{type:'string'},tools:{type:'string'},work:{type:'string'},jobs:{type:'string',default:'4'},'skip-install':{type:'boolean'}}});
const project=path.resolve(values.project),tools=path.resolve(values.tools),work=path.resolve(values.work);
const prefix=path.join(project,'.tools')+path.sep;
if(!work.startsWith(prefix)||!tools.startsWith(prefix))throw Error('Build work and tools must remain under the source .tools directory.');
for(const folder of [work,tools]){
  await fs.mkdir(folder,{recursive:true});
  if(await fs.realpath(folder)!==folder)throw Error('Linked build directory is not allowed.');
}
const output=path.join(tools,'ffmpeg-slim');
try{await fs.lstat(output);throw Error('FFmpeg output already exists; use a fresh tools directory.');}catch(e){if(e.code!=='ENOENT')throw e;}
const assets=[
  {name:'msys2-base-x86_64-20260927.tar.xz',url:'https://github.com/msys2/msys2-installer/releases/download/2026-09-27/msys2-base-x86_64-20260927.tar.xz',sha256:'ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322'},
  {name:'ffmpeg-8.1.2.tar.xz',url:'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',sha256:'464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c'}
];
async function hash(file){const h=crypto.createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
for(const asset of assets){
  const file=path.join(work,asset.name);
  try{await fs.access(file);}catch{
    const response=await fetch(asset.url,{signal:AbortSignal.timeout(240000)});
    if(!response.ok)throw Error(`Download failed: ${asset.name} (${response.status})`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(file,{flags:'wx'}));
  }
  if(await hash(file)!==asset.sha256)throw Error('Checksum mismatch: '+asset.name);
}
const sevenZip=path.join(tools,'7zip','7z.exe'),msys=path.join(work,'msys64');
try{await fs.access(path.join(msys,'usr','bin','bash.exe'));}catch{
  execFileSync(sevenZip,['x',path.join(work,assets[0].name),'-o'+work,'-y','-bso0','-bsp0'],{windowsHide:true});
  execFileSync(sevenZip,['x',path.join(work,assets[0].name.replace(/\.xz$/,'')),'-o'+work,'-y','-bso0','-bsp0'],{windowsHide:true});
}
// MinGW's assembler still mishandles non-ASCII TEMP paths. A temporary drive
// alias keeps every byte in the authorized E-drive workspace; it is removed
// after the build and never changes the user/machine environment.
let drive;
const subst=path.join(process.env.SystemRoot,'System32','subst.exe');
for(const letter of 'QRSTUVWXYZ'){
  try{await fs.access(letter+':\\');continue;}catch{}
  execFileSync(subst,[letter+':',work],{windowsHide:true});drive=letter+':';break;
}
if(!drive)throw Error('No free drive letter for the isolated Unicode-safe compiler alias.');
try{
const alias=drive+path.sep;
const native=file=>file.startsWith(work+path.sep)?path.join(alias,path.relative(work,file)):file;
const aliasMsys=native(msys),bash=path.join(aliasMsys,'usr','bin','bash.exe');
const env={...process.env,MSYSTEM:'UCRT64',CHERE_INVOKING:'1',CAIBO_FFMPEG_WORK:alias,
  XDG_CACHE_HOME:path.join(alias,'cache'),FONTCONFIG_FILE:path.join(alias,'build-fonts.conf'),
  CAIBO_FFMPEG_JOBS:String(Math.max(1,Math.min(8,Number(values.jobs)||4))),CAIBO_FFMPEG_SKIP_INSTALL:values['skip-install']?'1':'0'};
await fs.mkdir(env.XDG_CACHE_HOME,{recursive:true});
await fs.writeFile(env.FONTCONFIG_FILE,'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>');
const script=path.join(work,'build-script.sh');
await fs.copyFile(fileURLToPath(new URL('build-ffmpeg.sh',import.meta.url)),script);
const posixScript=execFileSync(path.join(aliasMsys,'usr','bin','cygpath.exe'),['-u',native(script)],{encoding:'utf8',windowsHide:true}).trim();
const log=path.join(work,'ffmpeg-build.log'),fd=await fs.open(log,'w');
console.log('Building FFmpeg 8.1.2 with x264, ASS, AMF, NVENC and QSV. Log: '+log);
try{
  await new Promise((resolve,reject)=>{
    const child=spawn(bash,['--login',posixScript],{env,windowsHide:true,stdio:['ignore',fd.fd,fd.fd]});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Build exited '+code)));
  });
}catch(e){console.error((await fs.readFile(log,'utf8')).slice(-2200));throw e;}finally{await fd.close();}

// Follow PE imports so only the actual runtime DLL closure is distributed.
const bin=path.join(work,'ffmpeg-install','bin'),ucrt=path.join(msys,'ucrt64','bin');
const objdump=native(path.join(ucrt,'objdump.exe')),files=new Map(),queue=['ffmpeg.exe','ffprobe.exe'];
while(queue.length){
  const name=queue.shift();if(files.has(name.toLowerCase()))continue;
  let source;
  for(const root of [bin,ucrt]){try{await fs.access(path.join(root,name));source=path.join(root,name);break;}catch{}}
  if(!source)throw Error('Missing runtime dependency: '+name);
  files.set(name.toLowerCase(),{name,source});
  const imports=execFileSync(objdump,['-p',native(source)],{encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});
  for(const match of imports.matchAll(/DLL Name:\s*(\S+)/g)){
    const dependency=match[1];if(/^api-ms-win-|^ext-ms-win-/i.test(dependency))continue;
    let bundled=false;for(const root of [bin,ucrt]){try{await fs.access(path.join(root,dependency));bundled=true;break;}catch{}}
    if(bundled)queue.push(dependency);
    else {try{await fs.access(path.join(process.env.SystemRoot,'System32',dependency));}catch{throw Error('Unresolved PE import: '+dependency);}}
  }
}
await fs.mkdir(path.join(output,'bin'),{recursive:true});
const manifest={version:'8.1.2',variant:'caibo-shared',source:assets[1],toolchain:assets[0],files:[]};
const packages=new Set();
for(const {name,source} of [...files.values()].sort((a,b)=>a.name.localeCompare(b.name))){
  const destination=path.join(output,'bin',name);await fs.copyFile(source,destination);
  manifest.files.push({name,bytes:(await fs.stat(destination)).size,sha256:await hash(destination)});
  if(source.startsWith(ucrt+path.sep)){
    const posix='/ucrt64/bin/'+name;
    const owner=execFileSync(path.join(aliasMsys,'usr','bin','pacman.exe'),['-Qqo',posix],{encoding:'utf8',env,windowsHide:true}).trim();
    packages.add(owner);
  }
}
// Preserve every dependency's supplied license and source package identity.
const notices=[];
for(const owner of [...packages].sort()){
  const metadata=execFileSync(path.join(aliasMsys,'usr','bin','pacman.exe'),['-Qi',owner],{encoding:'utf8',env,windowsHide:true});
  notices.push(metadata);
  const entries=execFileSync(path.join(aliasMsys,'usr','bin','pacman.exe'),['-Qlq',owner],{encoding:'utf8',env,windowsHide:true}).split(/\r?\n/).filter(p=>/^\/ucrt64\/share\/licenses\//.test(p)&&!p.endsWith('/'));
  for(const posix of entries){const relative=posix.replace(/^\/ucrt64\/share\/licenses\//,'');const target=path.join(output,'licenses',relative);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(msys,posix.slice(1)),target);
  }
}
await fs.copyFile(path.join(work,'ffmpeg-8.1.2','COPYING.GPLv3'),path.join(output,'LICENSE'));
await fs.copyFile(path.join(work,'packages.lock.txt'),path.join(output,'packages.lock.txt'));
await fs.copyFile(path.join(work,'ffmpeg-build','ffbuild','config.mak'),path.join(output,'config.mak'));
await fs.writeFile(path.join(output,'dependency-notices.txt'),notices.join('\n\n'));
await fs.writeFile(path.join(output,'README.txt'),'FFmpeg 8.1.2, Caibo shared Windows x64 build.\nGPL v3.\nSource: '+assets[1].url+'\nBuild scripts: live-editor/scripts/build-ffmpeg.{ps1,mjs,sh}.\nRuntime imports, hashes, exact build configuration and MSYS2 dependency metadata are included.\nMSYS2 package sources: https://github.com/msys2/MINGW-packages\n');
await fs.writeFile(path.join(output,'component.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({output,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)}));
}finally{execFileSync(subst,[drive,'/D'],{windowsHide:true});}
