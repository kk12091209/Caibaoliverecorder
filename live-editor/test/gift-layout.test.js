import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_GIFT_STYLE} from '../shared/gifts.js';
import {giftFrame,giftMetrics,giftRegions,giftTimeline} from '../shared/gift-layout.js';
import {giftSubtitles} from '../server/gift-render.js';

const gift=(id,time,extra={})=>({id,type:'gift',platform:'bilibili',time,user:'松果',name:'粉丝团灯牌',count:1,...extra});
const chat=(id,time,extra={})=>({id,type:'sc',platform:'bilibili',time,user:'山海听风',text:'这把空格键听起来真舒服。',totalPrice:30,...extra});
const render=(events,style={},time=2)=>giftFrame(giftTimeline(events,1920,1080,{...DEFAULT_GIFT_STYLE,...style}),time);

test('the most recent complete row is anchored in each of the four corners',()=>{
  for(const giftCorner of ['top-left','top-right','bottom-left','bottom-right']){
    const events=[.1,.2,.3,.4].map((time,i)=>gift('gift-'+i,time));
    const list=render(events,{giftCorner});
    assert.deepEqual(list.map(x=>x.entry.id),['gift-3','gift-2','gift-1']);
    assert.equal(list[0].x,giftCorner.endsWith('left')?48:1452);
    assert.equal(list[0].y>list[1].y,giftCorner.startsWith('bottom'));
    assert.equal(render(events,{giftCorner},5.36).some(item=>item.entry.id==='gift-0'),false);
  }
});

test('SC can fill a column and gives a newly visible gift one complete row without moving to the other side',()=>{
  const crowded=Array.from({length:20},(_,i)=>chat('c'+i,.1+i*.04));
  const all=[...crowded,gift('latest-gift',2.1)];
  const before=render(all);
  const after=render(all,{},2.3);
  const row=after.find(item=>item.entry.id==='latest-gift');
  assert.ok(before.length>=6,'the SC list may fill the column');
  assert.equal(before[0].y+before[0].h,1038);
  assert.equal(row.y+row.h,1038);
  assert.ok(after.filter(item=>item.entry.type==='sc').every(item=>item.x===row.x&&item.y+item.h<row.y));
  const retired=before.filter(item=>!after.some(a=>a.entry.id===item.entry.id));
  assert.ok(retired.length>0);
  const later=render(all,{},7.3);
  assert.ok(later.every(item=>!retired.some(r=>r.entry.id===item.entry.id)));
});

test('opposite anchors meet inside a column and additional gift lines yield',()=>{
  const events=[...Array.from({length:19},(_,i)=>chat('c'+i,.02+i*.05)),gift('g1',1.2),gift('g2',1.3),gift('g3',1.4)];
  const shown=render(events,{giftCorner:'top-right',scCorner:'bottom-right'});
  const g=shown.filter(i=>i.entry.type==='gift'),s=shown.filter(i=>i.entry.type==='sc');
  assert.ok(g.length>=1&&s.length>=6);
  assert.equal(g[0].y,42);
  assert.ok(Math.max(...g.map(i=>i.y+i.h))<Math.min(...s.map(i=>i.y)));
  const separate=render(events,{giftCorner:'top-left'});
  assert.equal(separate.filter(i=>i.entry.type==='gift').length,3);
  const m=giftMetrics(1080,1920,DEFAULT_GIFT_STYLE);
  const slots=giftRegions(m,DEFAULT_GIFT_STYLE);
  assert.ok(slots.gift.x>=1080*.5&&slots.gift.width<=1080*.35);
});

test('SC uses white outlined body text at every tier and keeps the existing header contrast',()=>{
  for (const totalPrice of [0,30,50,100,500,1000,2000]) {
    const [item]=render([chat('tier',1,{totalPrice})]);
    assert.equal(item.ink,'#ffffff');
    assert.equal(item.headerInk,'#141015');
    assert.equal(item.bodyOutline,1.3);
  }
  const event=chat('gold',1,{totalPrice:100,bodyColor:'#ffdc70',headColor:'#223455'});
  const track=giftTimeline([event],1920,1080,DEFAULT_GIFT_STYLE);
  const [current]=giftFrame(track,2);
  assert.equal(current.headerInk,'#ffffff');
  assert.equal(current.background,event.bodyColor);
  const subtitles=giftSubtitles(track,1920,1080,DEFAULT_GIFT_STYLE);
  const title=subtitles.split('\n').find(line=>line.endsWith(event.user));
  const price=subtitles.split('\n').find(line=>line.endsWith('¥100'));
  const body=subtitles.split('\n').find(line=>line.endsWith(event.text));
  assert.ok(title?.includes('\\bord0\\q2')&&price?.includes('\\bord0\\q2'));
  assert.ok(body?.includes('\\1c&Hffffff&\\3c&H141014&')&&body?.includes('\\bord1.3\\q2'));
  const legacy=giftTimeline([event],1920,1080,DEFAULT_GIFT_STYLE,{outlineSuperChats:false});
  const [old]=giftFrame(legacy,2);
  assert.equal(old.headerInk,current.headerInk);
  assert.equal(old.ink,'#141015');
  assert.equal(old.bodyOutline,0);
});

test('SC colors and effective duration, top guard, combo updates and seek are deterministic',()=>{
  const events=[
    gift('guard',1,{type:'guard',name:'舰长'}),gift('g',1.1,{updates:[{time:4.7,count:3}]}),
    chat('gold',1.3,{totalPrice:100,platformSeconds:2,bodyColor:'#f1c85c',
      text:'很长的留言需要按同一个列宽在播放和导出里面换行。'.repeat(4)}),
  ];
  const style={guardPosition:'top-center'};
  const early=render(events,style,2);
  assert.equal(early.find(i=>i.entry.id==='guard').y,42);
  assert.match(early.find(i=>i.entry.id==='g').label,/×1$/);
  const sc=early.find(i=>i.entry.id==='gold');assert.equal(sc.background,'#f1c85c');assert.ok(sc.lines.length>1);
  assert.ok(!render(events,style,3.4).some(i=>i.entry.id==='gold'));
  assert.match(render(events,style,7.2).find(i=>i.entry.id==='g').label,/×3$/);
  assert.deepEqual(render(events,style,2),early);
});
