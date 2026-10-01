import { createHash, randomInt } from 'node:crypto';

// a_bogus interoperability algorithm adapted from ihmily/streamget (MIT).
// See THIRD_PARTY_NOTICES.md for the exact source and retained licence.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function mappedBase64(bytes, table) {
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '').replace(/[A-Za-z0-9+/]/g, char => table[alphabet.indexOf(char)]);
}
function rc4(bytes, key) {
  const state = Array.from({ length: 256 }, (_, n) => n); let cursor = 0;
  for (let n = 0; n < 256; n++) { cursor = (cursor + state[n] + key[n % key.length]) & 255; [state[n], state[cursor]] = [state[cursor], state[n]]; }
  let i = 0, j = 0;
  return Buffer.from(Array.from(bytes, byte => { i = (i + 1) & 255; j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]]; return byte ^ state[(state[i] + state[j]) & 255]; }));
}
const sm3 = input => createHash('sm3').update(input).digest();
const doubleSm3 = text => sm3(sm3(Buffer.from(text)));
export function signRoomQuery(query, userAgent, { now = Date.now(), random = () => randomInt(10000) } = {}) {
  const queryHash = doubleSm3(query + 'cus'), suffixHash = doubleSm3('cus');
  const uaHash = sm3(Buffer.from(mappedBase64(rc4(Buffer.from(userAgent), [0, 1, 14]),
    'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe')));
  const bytes = Array(73).fill(0), split = input => [24, 16, 8, 0].map(shift => (input >>> shift) & 255);
  bytes[18] = 44;
  split(now).forEach((byte, n) => { bytes[20 + n] = byte; });
  bytes[24] = Math.floor(now / 4294967296) & 255; bytes[25] = Math.floor(now / 1099511627776) & 255;
  bytes[31] = 1; bytes[37] = 14;
  bytes[38] = queryHash[21]; bytes[39] = queryHash[22]; bytes[40] = suffixHash[21]; bytes[41] = suffixHash[22];
  bytes[42] = uaHash[23]; bytes[43] = uaHash[24];
  split(now + 100).forEach((byte, n) => { bytes[44 + n] = byte; });
  bytes[48] = 3; bytes[49] = Math.floor((now + 100) / 4294967296) & 255; bytes[50] = Math.floor((now + 100) / 1099511627776) & 255;
  split(110624).forEach((byte, n) => { bytes[52 + n] = byte; });
  bytes[57] = 6383 & 255; bytes[58] = (6383 >>> 8) & 255;
  const environment = Buffer.from('1920|1080|1920|1040|0|30|0|0|1872|92|1920|1040|1857|92|1|24|Win32');
  bytes[65] = environment.length & 255; bytes[66] = environment.length >>> 8;
  const checksumFields = [18,20,26,30,38,40,42,21,27,31,35,39,41,43,22,28,32,36,23,29,33,37,44,45,46,47,48,49,50,24,25,52,53,54,55,57,58,59,60,65,66,70,71];
  const checksum = checksumFields.reduce((sum, index) => sum ^ bytes[index], 0);
  const order = [18,20,52,26,30,34,58,38,40,53,42,21,27,54,55,31,35,57,39,41,43,22,28,32,60,36,23,29,33,37,44,45,59,46,47,48,49,50,24,25,65,66,70,71];
  const prefix = [];
  for (const options of [[3,45],[1,0],[1,5]]) { const value = random(), low = value & 255, high = (value >>> 8) & 255;
    prefix.push((low & 170) | (options[0] & 85), (low & 85) | (options[0] & 170),
      (high & 170) | (options[1] & 85), (high & 85) | (options[1] & 170)); }
  return mappedBase64(Buffer.concat([Buffer.from(prefix), rc4(Buffer.concat([Buffer.from(order.map(index => bytes[index])), environment, Buffer.from([checksum])]), [121])]),
    'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe') + '=';
}

const signatureKeys = ['live_id','aid','version_code','webcast_sdk_version','room_id','sub_room_id','sub_channel_id',
  'did_rule','user_unique_id','device_platform','device_type','ac','identity'];
const md5=bytes=>createHash('md5').update(bytes).digest();
const emptyDigest=md5(md5(Buffer.alloc(0)));let counter=0;
// Compact interoperability algorithm adapted from jwwsjlm/douyinLive (MIT),
// internal/webcastsign/native.go, SHA256 faa39870efd791f02ee3881abb7a4bea2292c34508a294106cb3fcec06542a28.
// No browser SDK, eval, VM or external signing service is loaded.
export function signChatDigest(stub,{sequence=++counter,flag=!!randomInt(2),payloadRandom=randomInt(255),keyRandom=randomInt(255)}={}) {
  if(!/^[0-9a-f]{32}$/i.test(stub))throw new Error('弹幕签名摘要无效。');
  const digest=md5(Buffer.from(stub,'hex'));
  const payload=Buffer.from([sequence&63,0,1,14,emptyDigest[14],emptyDigest[15],digest[14],digest[15],payloadRandom,0]);
  for(let n=0;n<9;n++)payload[9]^=payload[n];
  return mappedBase64(Buffer.concat([Buffer.from([64|(flag?16:0),keyRandom]),rc4(payload,[keyRandom])]),'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe');
}
export function signChatUrl(url) {
  const query=new URL(url).searchParams;
  return signChatDigest(createHash('md5').update(signatureKeys.map(key=>`${key}=${query.get(key)||''}`).join(',')).digest('hex'));
}
