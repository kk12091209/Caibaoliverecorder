import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDouyinLink,isDouyinLink,selectDouyinFlv,safeStreamUrl,safeStreamRedirect,DouyinResolver} from '../server/douyin-room.js';
const cdn=name=>'https://pull-test.douyincdn.com/'+name+'.flv';

test('platform CDN redirects can reach public IPv4/IPv6 without accepting direct IP stream inputs',()=>{
 const origin=cdn('origin');
 for(const target of ['http://111.2.123.206/origin.flv?token=sample','https://[240e::1234]/origin.flv']){
  assert.equal(safeStreamUrl(target),'');assert.equal(safeStreamRedirect(target,origin),target);
 }
 assert.equal(safeStreamRedirect('/new.flv',origin),cdn('new'));
 assert.equal(safeStreamRedirect(cdn('backup'),origin),cdn('backup'));
 assert.equal(safeStreamRedirect('http://111.2.123.206/origin.flv','https://untrusted.test/origin.flv'),'');
 assert.equal(safeStreamRedirect('http://111.2.123.206/origin.flv','http://111.2.123.207/origin.flv'),'');
});

test('CDN redirect validation rejects local, private, special and disguised IP addresses',()=>{
 const hosts=['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.0.0.1','192.0.2.1','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','2130706433','0x7f000001','[::1]','[::]','[fc00::1]','[fe80::1]','[ff02::1]','[::ffff:127.0.0.1]','[::ffff:111.2.123.206]','[2001:db8::1]','[2002:7f00:1::1]','[3fff::1]'];
 for(const host of hosts)assert.equal(safeStreamRedirect('http://'+host+'/video.flv',cdn('origin')),'',host);
 for(const target of ['https://untrusted.test/video.flv','http://111.2.123.206:8080/video.flv','http://user:pass@111.2.123.206/video.flv','file:///C:/private','ftp://111.2.123.206/video.flv'])assert.equal(safeStreamRedirect(target,cdn('origin')),'',target);
});
test('platform detection and canonical full links preserve string IDs and discard tracking query',async()=>{
 const room=await resolveDouyinLink('来看看 https://live.douyin.com/837518741716?activity_name=x');assert.equal(room.key,'douyin:837518741716');assert.equal(room.url,'https://live.douyin.com/837518741716');
 assert.equal(isDouyinLink(room.url),true);assert.equal(isDouyinLink('https://live.bilibili.com/1016'),false);
 await assert.rejects(resolveDouyinLink('https://live.douyin.com.evil.test/1'),/链接/);await assert.rejects(resolveDouyinLink('https://user@live.douyin.com/1'),/链接/);
});
test('share redirect validation rejects arbitrary hosts before requesting them',async()=>{
 const requested=[];await assert.rejects(resolveDouyinLink('https://v.douyin.com/abc/',{request:async url=>{requested.push(String(url));return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}}),/链接/);assert.equal(requested.length,1);
 const room=await resolveDouyinLink('https://v.douyin.com/abc/',{request:async()=>new Response(null,{status:302,headers:{location:'https://live.douyin.com/12345'}})});assert.equal(room.webRid,'12345');
 await assert.rejects(resolveDouyinLink('https://v.douyin.com/abc/',{request:async()=>new Response('recommendation https://live.douyin.com/999')}),/未找到/);
});
test('official home-page room links use the explicit room parameter without following recommendations',async()=>{
 const options={request:async()=>{assert.fail('an explicit room must not fetch the recommendation page');}};
 for(const id of ['999333432170','171705310987']){
  const room=await resolveDouyinLink('https://live.douyin.com/?anchor_id=103147951639&live_web_rid='+id+'&page_type=live_main_page',options);
  assert.equal(room.key,'douyin:'+id);assert.equal(room.url,'https://live.douyin.com/'+id);
 }
 for(const value of ['', 'abc', '1&live_web_rid=2', '123456789012345678901'])await assert.rejects(resolveDouyinLink('https://live.douyin.com/?live_web_rid='+value,options),/编号无效/);
 await assert.rejects(resolveDouyinLink('https://live.douyin.com.evil.test/?live_web_rid=1',options),/链接/);
});
test('highest compatible origin is preferred, audio-only and explicitly HEVC URLs are not selected',()=>{
 const data={data:{md:{main:{flv:cdn('low'),sdk_params:'{"VCodec":"h264","vbitrate":800000}'}},origin:{main:{flv:'http://pull-test.douyincdn.com/origin.flv',sdk_params:'{"VCodec":"h264","vbitrate":20000000}'}},ao:{main:{flv:cdn('audio')}}}};
 data.data.uhd={main:{flv:cdn('hevc'),sdk_params:'{"VCodec":"h265"}'}};
 const stream={flv_pull_url:{FULL_HD1:cdn('hevc')},live_core_sdk_data:{pull_data:{stream_data:JSON.stringify(data)}}};
 assert.equal(selectDouyinFlv(stream).quality,'origin');assert.equal(selectDouyinFlv({flv_pull_url:{SD1:cdn('low'),FULL_HD1:cdn('high')}}).url,cdn('high'));
 assert.equal(safeStreamUrl('https://localhost/private'),'');assert.equal(safeStreamUrl('https://pull-test.douyincdn.com:999/private'),'');
});
test('anonymous visitor is refreshed once, unknown API status is an error rather than offline',async()=>{
 let visitors=0,status=2;const resolver=new DouyinResolver({request:async url=>{
  if(String(url)==='https://live.douyin.com/'){visitors++;return new Response('page',{headers:{'set-cookie':'ttwid=guest; Secure'}});}
  return new Response(JSON.stringify({status_code:0,data:{data:[{id_str:'7691637058724547364',status,title:'房间',owner:{nickname:'主播'},stream_url:{flv_pull_url:{FULL_HD1:cdn('full')}}}]}}));
 }});
 const rooms=await Promise.all([resolver.room('1'),resolver.room('2')]);assert.equal(visitors,1);assert.equal(rooms[0].roomId,'7691637058724547364');assert.equal(rooms[0].streaming,true);
 status=3;assert.equal((await resolver.room('1')).streaming,false);status=9;await assert.rejects(resolver.room('1'),/无效/);
});

test('an identified offline anchor remains monitorable before a webcast exists; missing room and query failures stay distinct',async()=>{
 let data={status_code:0,data:{data:[],user:{id_str:'59359805445',nickname:'未开播主播'}}};
 const resolver=new DouyinResolver({request:async url=>String(url)==='https://live.douyin.com/'?new Response('page',{headers:{'set-cookie':'ttwid=guest; Secure'}}):new Response(JSON.stringify(data))});
 const room=await resolver.room('1016');assert.equal(room.name,'未开播主播');assert.equal(room.streaming,false);assert.equal(room.stream,null);assert.equal(room.roomId,'');
 data={status_code:0,data:{data:[],user:{id_str:'0',nickname:'未知'}}};await assert.rejects(resolver.room('1016'),{code:'ROOM_NOT_FOUND'});
 data={status_code:-1,data:{data:[]}};await assert.rejects(resolver.room('1016'),error=>error.code!=='ROOM_NOT_FOUND');
});

test('Douyin living CDN origin is accepted without allowing lookalikes or local addresses',()=>{
 const url='https://pull-x3-f5.douyinliving.com/origin.flv';
 assert.equal(safeStreamUrl(url),url);
 const stream={live_core_sdk_data:{pull_data:{stream_data:{data:{origin:{main:{flv:url,sdk_params:{VCodec:'h264',vbitrate:21134336}},backup:{flv:cdn('backup'),sdk_params:{VCodec:'h264',vbitrate:21134336}}}}}}}};
 assert.equal(selectDouyinFlv(stream).url,url);
 for(const rejected of ['https://douyinliving.com.evil.test/a.flv','https://evildouyinliving.com/a.flv','https://pull.douyinliving.com:9000/a.flv','https://user@pull.douyinliving.com/a.flv','http://127.0.0.1/a.flv'])assert.equal(safeStreamUrl(rejected),'');
});

test('a compatible origin backup is preferred over lower quality main streams',()=>{
 const data={data:{origin:{main:{flv:cdn('hevc'),sdk_params:{VCodec:'h265'}},backup:{flv:cdn('origin'),sdk_params:{VCodec:'h264',vbitrate:20000000}}},uhd:{main:{flv:cdn('uhd'),sdk_params:{VCodec:'h264',vbitrate:8000000}}},ao:{backup:{flv:cdn('audio')}}}};
 const stream={flv_pull_url:{FULL_HD1:cdn('hevc')},live_core_sdk_data:{pull_data:{stream_data:data}}};
 assert.equal(selectDouyinFlv(stream).url,cdn('origin'));
 data.data.origin.main.flv='https://untrusted.test/origin.flv';assert.equal(selectDouyinFlv(stream).url,cdn('origin'));
 data.data.origin.backup.sdk_params={VCodec:'av1'};assert.equal(selectDouyinFlv(stream).url,cdn('uhd'));
 data.data.origin.main.flv=cdn('hevc');delete data.data.uhd;assert.equal(selectDouyinFlv(stream),null);
});

test('malformed SDK parameters do not hide compatible backup or subsequent quality entries',()=>{
 const data={data:{origin:{main:{flv:cdn('invalid'),sdk_params:'{'},backup:{flv:cdn('backup'),sdk_params:{VCodec:'h264'}}},uhd:{main:{flv:cdn('uhd'),sdk_params:{VCodec:'h264'}}}}};
 const stream={live_core_sdk_data:{pull_data:{stream_data:data}}};
 assert.equal(selectDouyinFlv(stream).url,cdn('backup'));
 delete data.data.origin.backup;assert.equal(selectDouyinFlv(stream).url,cdn('uhd'));
});
