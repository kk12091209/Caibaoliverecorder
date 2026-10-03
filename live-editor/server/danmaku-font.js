import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const MAX_FONT_BYTES=32*1024*1024;
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function fontMetadata(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>MAX_FONT_BYTES)throw new Error('字体大小无效，请选择 32 MB 以内的 TTF 或 OTF 文件。');
  const signature=bytes.readUInt32BE(0);
  if(signature!==0x00010000&&signature!==0x4f54544f)throw new Error('请选择有效的 TTF 或 OTF 字体文件。');
  const count=bytes.readUInt16BE(4),tables=new Map();
  if(!count||count>512||12+count*16>bytes.length)throw new Error('字体文件已损坏。');
  for(let i=0;i<count;i++){const p=12+i*16,tag=bytes.toString('ascii',p,p+4),offset=bytes.readUInt32BE(p+8),length=bytes.readUInt32BE(p+12);if(offset<12+count*16||offset+length>bytes.length||tables.has(tag))throw new Error('字体文件已损坏。');tables.set(tag,bytes.subarray(offset,offset+length));}
  if(!tables.has('cmap')||!tables.has('head')||!tables.has('maxp')||!(tables.has('glyf')||tables.has('CFF ')||tables.has('CFF2')))throw new Error('字体缺少可用的文字轮廓。');
  const names=tables.get('name');if(!names||names.length<6)throw new Error('字体缺少名称。');
  const entries=names.readUInt16BE(2),strings=names.readUInt16BE(4),matches=[];
  if(6+entries*12>names.length||strings<6+entries*12)throw new Error('字体名称表已损坏。');
  for(let i=0;i<entries;i++){
    const p=6+i*12,platform=names.readUInt16BE(p),language=names.readUInt16BE(p+4),id=names.readUInt16BE(p+6),length=names.readUInt16BE(p+8),offset=strings+names.readUInt16BE(p+10);
    if(offset+length>names.length)throw new Error('字体名称表已损坏。');
    if(id!==1||![0,1,3].includes(platform))continue;
    const value=names.subarray(offset,offset+length);let text;
    if(platform===1){if(value.some(byte=>byte>=128))continue;text=value.toString('ascii').trim();}
    else{if(length%2)continue;text=Buffer.from(value).swap16().toString('utf16le').trim();}
    // ASS fields cannot contain commas, newlines, or override syntax.
    if(text&&!/[\x00-\x1f,{}\\]/.test(text)&&text.length<=120)matches.push({text,score:(platform===3?2:0)+(language===0x409?4:0)});
  }
  matches.sort((a,b)=>b.score-a.score);if(!matches.length)throw new Error('字体名称不支持用于弹幕，请选择另一份字体。');
  const os2=tables.get('OS/2'),head=tables.get('head');const bold=(os2?.length>=8&&os2.readUInt16BE(4)>=600)||(head?.length>=46&&!!(head.readUInt16BE(44)&1));const italic=(os2?.length>=64&&!!(os2.readUInt16BE(62)&1))||(head?.length>=46&&!!(head.readUInt16BE(44)&2));
  return {id:createHash('sha256').update(bytes).digest('hex'),family:matches[0].text,bold,italic,extension:signature===0x4f54544f?'.otf':'.ttf'};
}
export class DanmakuFonts{
  constructor(store){this.store=store;this.root=path.join(store.root,'fonts');this.changing=false;}
  snapshot(){const font=this.store.setting('danmaku-font');return font&&validHash(font.id)?{id:font.id,family:font.family,bold:!!font.bold,italic:!!font.italic,url:`/api/danmaku-font/${font.id}`} : null;}
  selected(){return this.snapshot();}
  async directory(){await fs.mkdir(this.root,{recursive:true,mode:0o700});const stat=await fs.lstat(this.root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('字体目录异常。');}
  async file(font){if(!font||!validHash(font.id))throw new Error('字体记录无效。');await this.directory();for(const extension of ['.ttf','.otf']){const directory=path.join(this.root,font.id);const folder=await fs.lstat(directory);if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error('字体目录异常。');const file=path.join(directory,'danmaku'+extension);try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('字体文件类型异常。');const bytes=await fs.readFile(file);if(fontMetadata(bytes).id!==font.id)throw new Error('字体文件校验失败，请重新导入。');return file;}catch(error){if(error.code!=='ENOENT')throw error;}}throw new Error('字体文件不存在，请重新导入。');}
  async import(bytes){const font=fontMetadata(bytes);await this.directory();const directory=path.join(this.root,font.id);await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('字体目录异常。');const file=path.join(directory,'danmaku'+font.extension);try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;await this.file(font);}this.store.setting('danmaku-font',{id:font.id,family:font.family,bold:font.bold,italic:font.italic});return this.snapshot();}
  reset(){this.store.setting('danmaku-font',null);return null;}
  async stage(font,workDir){if(!font)return '';const file=await this.file(font);return path.relative(workDir,path.dirname(file)).split(path.sep).join('/');}

}
