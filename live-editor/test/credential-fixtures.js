import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
// Test-only protector. Production always uses the native OS-backed helper.
export function testProtection(){
  const key=randomBytes(32);
  return {label:'测试存储',fail:false,available:async()=>true,async run(operation,namespace,platform,bytes){
    if(this.fail)throw new Error('simulated secure-storage failure');
    const aad=Buffer.from(namespace+':'+platform);
    if(operation==='seal'){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);return Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);}
    const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(aad);cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]);
  }};
}
export const biliFixture='SESSDATA=synthetic-bili-secret-v1; DedeUserID=12345; bili_jct=synthetic-csrf-v1';
export const biliReplacement='SESSDATA=synthetic-bili-secret-v2; DedeUserID=12345; bili_jct=synthetic-csrf-v2';
export const douyinFixture='sessionid=synthetic-douyin-secret-v1; ttwid=synthetic-visitor-v1';
