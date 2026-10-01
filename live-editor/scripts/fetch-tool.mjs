import fs from 'node:fs/promises';
import {createReadStream,createWriteStream,constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const [url,file,expected]=process.argv.slice(2);
if(new URL(url).protocol!=='https:'||!/^[a-f0-9]{64}$/.test(expected))throw Error('Expected HTTPS and a pinned SHA-256.');
async function digest(p){const hash=crypto.createHash('sha256');for await(const b of createReadStream(p))hash.update(b);return hash.digest('hex');}
try{await fs.access(file);}catch{
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+'.'+crypto.randomUUID()+'.download';
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(240000)});if(!response.ok)throw Error('Download HTTP '+response.status);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary,{flags:'wx'}));
    if(await digest(temporary)!==expected)throw Error('Publisher checksum mismatch.');
    await fs.copyFile(temporary,file,constants.COPYFILE_EXCL);
  }finally{await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
if(await digest(file)!==expected)throw Error('Tool checksum mismatch: '+file);
