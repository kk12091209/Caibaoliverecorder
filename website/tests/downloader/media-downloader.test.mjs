import test from 'node:test';
import assert from 'node:assert/strict';
import { permittedAddress, approvedUrl } from '../../server/downloader/infrastructure/network.mjs';
import { shareUrl, routerItem, douyinResult, rankBilibiliVideo, PlatformResolver } from '../../server/downloader/platforms/resolver.mjs';
import { fileStem } from '../../server/downloader/jobs/manager.mjs';

test('upstream address checks retain private, loopback and all mapped IPv6 blocks',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.1','169.254.169.254','172.16.1.1','0.0.0.0'])assert.equal(permittedAddress(ip,4),false,ip);
  for(const ip of ['::1','::ffff:127.0.0.1','::ffff:10.1.2.3','::ffff:8.8.8.8','fc00::1','fe80::1'])assert.equal(permittedAddress(ip,6),false,ip);
  assert.equal(permittedAddress('8.8.8.8',4),true);
  assert.equal(permittedAddress('198.18.0.114',4),true);
  assert.equal(permittedAddress('2606:4700:4700::1111',6),true);
});
test('only platform hosts without credentials, IP literals or custom ports are accepted',()=>{
  for(const u of ['http://127.0.0.1/','https://evil.example/','https://douyin.com.evil.example/','https://www.douyin.com:444/','https://user:secret@www.douyin.com/'])assert.throws(()=>approvedUrl(u));
  assert.equal(shareUrl('分享 https\\://v.douyin.com/\\_abc/ 。').pathname,'/_abc/');
  assert.equal(shareUrl('https://www.bilibili.com/video/BV12mpG6MEDL/?p=2，').searchParams.get('p'),'2');
  assert.equal(shareUrl('https://www.bilibili.com/video/BV12mpG6MEDL/?p=2%EF%BC%8C').searchParams.get('p'),'2');
  assert.equal(shareUrl('https://b23.tv/FQ9fWMm这个是分享链接').pathname,'/FQ9fWMm');
  assert.throws(()=>shareUrl('https://v26-web.douyinvod.com/media'));
  assert.equal(approvedUrl('https://v3-dy-o.zjcdn.com/media').hostname,'v3-dy-o.zjcdn.com');
  assert.throws(()=>approvedUrl('https://other.zjcdn.com/media'));
  assert.throws(()=>approvedUrl('https://v3-dy-o.zjcdn.com.evil.example/media'));
});
test('hydrated items must match the requested work and not a recommendation',()=>{
  const html='<script>window._ROUTER_DATA='+JSON.stringify({loaderData:{page:{videoInfoRes:{item_list:[{aweme_id:'2',video:{}},{aweme_id:'1',video:{}}]}}}})+'</script>';
  assert.equal(routerItem(html,'1').aweme_id,'1');assert.equal(routerItem(html,'3'),null);
});
test('a 100-image post retains every original image in source order',()=>{
  const images=Array.from({length:100},(_,i)=>({width:3000,height:4000,url_list:[`https://p11-sign.douyinpic.com/image${i}.jpeg`]}));
  const value=douyinResult({aweme_id:'123',desc:'原图',author:{nickname:'作者'},images});
  assert.equal(value.kind,'images');assert.equal(value.assets.length,100);assert.equal(value.assets[99].index,100);assert.equal(value.assets[99].urls[0],images[99].url_list[0]);
});
test('watermarked-only image sources are rejected and video playback requests remove watermark endpoints',()=>{
  assert.throws(()=>douyinResult({aweme_id:'123',images:[{url_list:['https://p11-sign.douyinpic.com/watermark/1.jpg']}]}));
  const value=douyinResult({aweme_id:'123',video:{width:1080,height:1920,duration:13000,play_addr:{url_list:['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc&logo_name=mark']}}});
  const u=new URL(value.assets[0].urls[0]);assert.equal(u.pathname,'/aweme/v1/play/');assert.equal(u.searchParams.has('logo_name'),false);assert.equal(u.searchParams.get('ratio'),'1080p');
});
test('download filenames cannot introduce paths or control characters',()=>{assert.equal(fileStem('../a/b\\c\n?.jpg'),'.._a_b_c__.jpg');assert.equal(fileStem(''), '作品');});
test('Bilibili selects highest actual resolution before format IDs and prefers a compatible codec at equal quality',()=>{
  const sources=[{id:125,width:1920,height:1080,codecs:'hev1',baseUrl:'https://a.bilivideo.com/hdr'},{id:120,width:3840,height:2160,codecs:'hev1',baseUrl:'https://a.bilivideo.com/4k'},{id:120,width:3840,height:2160,codecs:'avc1',baseUrl:'https://a.bilivideo.com/4k-avc'}];
  assert.deepEqual(rankBilibiliVideo(sources).map(v=>v.baseUrl),['https://a.bilivideo.com/4k-avc','https://a.bilivideo.com/4k','https://a.bilivideo.com/hdr']);
});

const biliVideo=(id,width,height)=>({id,width,height,codecs:'avc1',baseUrl:`https://a.bilivideo.com/${id}.m4s`});
const biliResult={id:'BV1dELb62EBy',url:'https://www.bilibili.com/video/BV1dELb62EBy/'};
test('Bilibili guest playback discovers 1080P without credentials and uses the selected stream quality',async()=>{
  const previous=process.env.BILIBILI_COOKIE;
  process.env.BILIBILI_COOKIE='test-only-must-not-be-forwarded';
  try{
    const resolver=new PlatformResolver({requestJson:async(url,options)=>{
      assert.equal(Object.keys(options.headers).some(k=>/cookie|authorization/i.test(k)),false);
      const guest=new URL(url).searchParams.get('try_look')==='1';
      return {code:0,data:{quality:64,support_formats:[{quality:120,new_description:'4K 超高清'},{quality:80,new_description:'1080P 高清'},{quality:32,new_description:'480P 标清'}],dash:{video:[...(guest?[biliVideo(80,1918,1080)]:[]),biliVideo(32,852,480)],audio:[{baseUrl:'https://a.bilivideo.com/audio.m4s',bandwidth:192000}]}}};
    }});
    const source=await resolver.bilibiliStreams(biliResult,{cid:38502924420});
    assert.equal(source.height,1080);assert.equal(source.width,1918);
    assert.equal(source.quality,'1080P 高清');
    assert.deepEqual(source.video,['https://a.bilivideo.com/80.m4s']);
    assert.deepEqual(source.audio,['https://a.bilivideo.com/audio.m4s']);
  }finally{if(previous===undefined)delete process.env.BILIBILI_COOKIE;else process.env.BILIBILI_COOKIE=previous;}
});
for(const [id,width,height,label] of [[64,1280,720,'720P 高清'],[32,852,480,'480P 标清'],[16,640,360,'360P 流畅']]){
  test(`Bilibili chooses available ${height}P without skipping intermediate tiers or claiming advertised 1080P`,async()=>{
    const available=[biliVideo(16,640,360),biliVideo(32,852,480),biliVideo(64,1280,720)].filter(v=>v.height<=height);
    const resolver=new PlatformResolver({requestJson:async()=>({code:0,data:{quality:80,support_formats:[{quality:80,new_description:'1080P 高清'},{quality:id,new_description:label}],dash:{video:available,audio:[{baseUrl:'https://a.bilivideo.com/audio.m4s'}]}}})});
    const source=await resolver.bilibiliStreams(biliResult,{cid:38502924420});
    assert.equal(source.quality,label);assert.equal(source.height,height);assert.equal(source.width,width);
    assert.deepEqual(source.video,[`https://a.bilivideo.com/${id}.m4s`]);
  });
}
