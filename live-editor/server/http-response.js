import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Return true after responding so a matched route does not fall through.
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} data
 */
export function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));return true;}
/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 */
export async function body(req,maxBytes=8*1024*1024){
  if(!req.headers['content-type']?.startsWith('application/json')){const e=new Error('请求必须为 JSON。');e.status=415;throw e;}
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>maxBytes)throw new Error('请求数据过大。');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new Error('JSON 请求格式无效。');}
}
/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} file
 */
export async function sendFile(req,res,file){
  const stat=await fs.stat(file);let start=0,end=stat.size-1,status=200;
  const range=req.headers.range;
  if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return true;}start=Number(match[1]);end=match[2]?Math.min(end,Number(match[2])):end;status=206;}
  if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return true;}
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.mkv':'video/x-matroska','.flv':'video/x-flv','.xml':'application/xml; charset=utf-8','.json':'application/json','.ass':'text/plain; charset=utf-8','.ttf':'font/ttf','.otf':'font/otf'};
  const headers={'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
  if(['.html','.js','.css'].includes(path.extname(file)))headers['Cache-Control']='no-store';
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status,headers);if(req.method==='HEAD'){res.end();return true;}
  const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
}
