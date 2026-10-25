import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDouyinLink} from '../server/douyin-room.js';

// Reduced from a mobile reflow response observed on 2026-10-25. IDs are
// synthetic; stream URLs, visitor identifiers and profile fields are omitted.
const roomId='7700000000000000123',webRid='123456789012';
const reflow='https://webcast.amemv.com/douyin/webcast/reflow/'+roomId;
const node=(overrides={})=>['$','$L7',null,{hasError:false,id:roomId,data:{room:{idStr:roomId,owner:{webRid,ownRoom:{roomIdsStr:[roomId]}}}},...overrides}];
const script=value=>'<script >self.__rsc_f.push('+JSON.stringify([1,value])+')</script>';
const page=value=>script('5:'+JSON.stringify(value)+'\n');

test('mobile share text resolves only the requested reflow room, preserving distinct webcast and web IDs',async()=>{
 const seen=[],target=node(),record='5:'+JSON.stringify(target)+'\n';
 const request=async url=>{seen.push(String(url));return seen.length===1?new Response(null,{status:302,headers:{location:reflow+'?utm_source=copy'}}):new Response(script('0:["$","$L1",null,{"params":{"id":"'+roomId+'"}}]\n8:T2,')+script('{}')+script(record.slice(0,70))+script(record.slice(70)));};
 const result=await resolveDouyinLink('正在直播！ https://v.douyin.com/example/ 5@9.com :4pm',{request});
 assert.equal(result.key,'douyin:'+webRid);assert.equal(result.url,'https://live.douyin.com/'+webRid);assert.equal(seen.length,2);
});

test('mobile room parser rejects recommendations, conflicting identities and executable script lookalikes',async()=>{
 const wrongRoom=node({id:'7700000000000000999'}),wrongPayload=node();wrongPayload[3].data.room.idStr='7700000000000000999';
 const noOwnerRoom=node();noOwnerRoom[3].data.room.owner.ownRoom.roomIdsStr=['7700000000000000999'];
 const conflicting=node();conflicting[3].data.room.owner.webRid='987654321012';
 for(const html of [page(wrongRoom),page(wrongPayload),page(noOwnerRoom),page(node({hasError:true})),page(node())+page(conflicting),
  '<script>self.__rsc_f.push((()=>{throw Error("must not execute")})())</script>',
  'recommendation https://live.douyin.com/123456789012']){
  await assert.rejects(resolveDouyinLink(reflow,{request:async()=>new Response(html)}),/未找到/);
 }
 await assert.rejects(resolveDouyinLink('https://www.douyin.com/recommend',{request:async()=>new Response(page(node()))}),/未找到/);
});
