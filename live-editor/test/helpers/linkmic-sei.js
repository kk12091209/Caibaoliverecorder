// Construct the AVC SEI shape used by parser and real-encoder regression tests.
export function seiTag(value,type=5,time=0,lengthSize=4,suffix='') {
  const payload=Buffer.from((type===5?'LIVE_SEI_CHANNEL':'')+JSON.stringify(value)+suffix),size=[];
  for(let n=payload.length;n>=255;n-=255)size.push(255);size.push(payload.length%255);
  const raw=Buffer.concat([Buffer.from([type,...size]),payload,Buffer.from([128])]),escaped=[];
  for(let i=0;i<raw.length;i++){if(i>=2&&raw[i]<=3&&raw[i-1]===0&&raw[i-2]===0)escaped.push(3);escaped.push(raw[i]);}
  const nalu=Buffer.concat([Buffer.from([6]),Buffer.from(escaped)]),length=Buffer.alloc(lengthSize);length.writeUIntBE(nalu.length,0,lengthSize);
  const body=Buffer.concat([Buffer.from([0x27,1,0,0,0]),length,nalu]),tag=Buffer.alloc(body.length+15);
  tag[0]=9;tag.writeUIntBE(body.length,1,3);tag.writeUIntBE(time*1000,4,3);body.copy(tag,11);tag.writeUInt32BE(tag.length-4,tag.length-4);return tag;
}
