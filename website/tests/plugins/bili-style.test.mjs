import test from 'node:test'
import assert from 'node:assert/strict'
import { followHarness } from '../helpers/bili-follow-harness.mjs'
const plain = value => JSON.parse(JSON.stringify(value))

test('invalid style storage is bounded and defaults off; values and curves are normalized', () => {
  const {api} = followHarness()
  for (const raw of [null, '{', 'x'.repeat(20001), {enabled:true}]) assert.equal(api.normalizeStyleSettings(raw).enabled, false)
  const p = api.normalizeStylePreset({brightness:NaN,contrast:999,saturation:-10,vibrance:200,temperature:-200,
    curves:{rgb:[{x:.5,y:2},{x:.5,y:.2},{x:NaN,y:.5},{x:-1,y:-1},{x:2,y:2}]}})
  assert.deepEqual([p.brightness,p.contrast,p.saturation,p.vibrance,p.temperature],[100,200,0,100,-100])
  assert.deepEqual(plain(p.curves.rgb),[{x:0,y:0},{x:.5,y:1},{x:1,y:1}])
  const points=api.normalizeStyleCurve(Array.from({length:1000},(_,i)=>({x:(i+1)/1001,y:i/1000})))
  assert.ok(points.length<=12);assert.equal(points[0].x,0);assert.equal(points.at(-1).x,1)
  assert.ok(points.every((p,i)=>p.y>=0&&p.y<=1&&(!i||p.x>points[i-1].x)))
  const edges=api.normalizeStyleCurve([{x:.001,y:.8},{x:.999,y:.2}])
  assert.ok(edges.every((p,i)=>!i||p.x-edges[i-1].x>=1/255-1e-8))
})

test('smooth curves pass through every control point without overshoot or discontinuities', () => {
  const {api}=followHarness(),identity=api.normalizeStyleCurve(null)
  for(let i=0;i<=255;i++)assert.ok(Math.abs(api.sampleStyleCurve(identity,i/255)-i/255)<1e-12)
  for(const curve of [
    [{x:0,y:0},{x:.2,y:.4},{x:.8,y:.6},{x:1,y:1}],
    [{x:0,y:1},{x:.25,y:0},{x:.5,y:.8},{x:1,y:.2}],
    [{x:0,y:.2},{x:.25,y:.2},{x:.5,y:.2},{x:1,y:.2}],
  ]){
    for(const p of curve)assert.ok(Math.abs(api.sampleStyleCurve(curve,p.x)-p.y)<1e-12)
    for(let i=0;i<curve.length-1;i++)for(let step=0;step<=100;step++){
      const a=curve[i],b=curve[i+1],y=api.sampleStyleCurve(curve,a.x+(b.x-a.x)*step/100)
      assert.ok(y>=Math.min(a.y,b.y)-1e-12&&y<=Math.max(a.y,b.y)+1e-12)
    }
  }
})

test('identity, brightness, contrast, temperature and independent RGB lookup tables are bounded', () => {
  const {api}=followHarness(),neutral=api.styleTables(api.normalizeStylePreset(null))
  assert.equal(neutral.length,3)
  for(const channel of neutral){assert.equal(channel.length,256);for(let i=0;i<256;i++)assert.ok(Math.abs(channel[i]-i/255)<1e-12)}
  for(const channel of api.styleTables(api.normalizeStylePreset({contrast:0})))assert.ok(channel.every(x=>x===.5))
  for(const channel of api.styleTables(api.normalizeStylePreset({brightness:50})))assert.equal(channel.at(-1),.5)
  const warm=api.styleTables(api.normalizeStylePreset({temperature:100}))
  assert.ok(warm.every(c=>c[0]===0));assert.equal(warm[0].at(-1),1);assert.equal(warm[2].at(-1),.8)
  const red=api.styleTables(api.normalizeStylePreset({curves:{r:[{x:0,y:.1},{x:1,y:.9}]}}))
  assert.equal(red[0][0],.1);assert.equal(red[0].at(-1),.9);assert.equal(red[1][0],0);assert.equal(red[1].at(-1),1)
  const extreme=api.styleTables(api.normalizeStylePreset({brightness:200,contrast:200,temperature:-100}))
  assert.ok(extreme.flat().every(v=>Number.isFinite(v)&&v>=0&&v<=1))
})

test('one persistent style per room survives reopening without storing images or changing follow state', () => {
  const h=followHarness();h.api.begin({uid:'11',name:'原有跟车'})
  const follow=[...h.saved.entries()],before=h.inspect(),counters=h.counters()
  assert.equal(h.api.writeStyleSettings({configured:true,enabled:true,preset:{contrast:125,vibrance:18},frame:'private-frame',image:'blob:no-store'},'1001'),true)
  assert.equal(h.api.writeStyleSettings({configured:true,enabled:false,preset:{contrast:85}},'2002'),true)
  assert.equal(h.api.readStyleSettings('1001').preset.contrast,125);assert.equal(h.api.readStyleSettings('1001').enabled,true)
  assert.equal(h.api.readStyleSettings('2002').preset.contrast,85);assert.equal(h.api.readStyleSettings('2002').enabled,false)
  assert.equal(h.api.readStyleSettings('9999').configured,false)
  const reopened=followHarness({saved:h.saved})
  assert.equal(JSON.parse(reopened.api.inspectStyle()).preset.contrast,125)
  assert.deepEqual(reopened.inspect().settings.targets,[{uid:'11',name:'原有跟车'}])
  for(const [key,value] of follow)assert.equal(h.saved.get(key),value)
  assert.deepEqual(h.inspect(),before);assert.deepEqual(h.counters(),counters);assert.equal(h.posts.length,0)
  for(const [key,value] of h.saved)if(key.startsWith('bcp.liveStyle.'))assert.doesNotMatch(value,/private-frame|blob:|image|csrf|cookie/)
})

test('style storage failure is reported, rather than claiming the preset was saved', () => {
  const saved={get:()=>null,set(){throw Error('storage unavailable')}}
  const {api}=followHarness({saved})
  assert.equal(api.writeStyleSettings({configured:true,enabled:true,preset:{contrast:120}}),false)
})

function filterHarness(){
  const h=followHarness({getComputedStyle:node=>({filter:node.style.getPropertyValue('filter')||node.nativeFilter||'none'})})
  const media=(filter='',priority='')=>{
    let value=filter,weight=priority;const attributes=new Map()
    return {isConnected:true,attributes,
      style:{getPropertyValue:()=>value,getPropertyPriority:()=>weight,setProperty(_name,next,p=''){value=next;weight=p},removeProperty(){value='';weight=''}},
      setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)}
  }
  return {h,media}
}

test('all media surfaces including a late independent camera get filters; removal restores native state', () => {
  const {h,media}=filterHarness(),main=media('brightness(1.1)'),camera=media()
  h.api.syncStyleTargets([main],'url("#bcp-live-style-live")')
  assert.equal(main.style.getPropertyValue('filter'),'brightness(1.1) url("#bcp-live-style-live")')
  assert.equal(main.style.getPropertyPriority('filter'),'important')
  h.api.syncStyleTargets([main,camera],'url("#bcp-live-style-live")')
  assert.equal(camera.style.getPropertyValue('filter'),'url("#bcp-live-style-live")')
  assert.equal(main.style.getPropertyValue('filter').match(/bcp-live-style/g).length,1)
  main.isConnected=false;h.api.syncStyleTargets([camera],'url("#bcp-live-style-live")')
  assert.equal(main.style.getPropertyValue('filter'),'brightness(1.1)');assert.equal(main.attributes.size,0)
  h.api.restoreStyleTargets();assert.equal(camera.style.getPropertyValue('filter'),'');assert.equal(camera.attributes.size,0)
})

test('external filter changes are preserved through reapplication and cancellation', () => {
  const {h,media}=filterHarness(),node=media('sepia(.1)','important')
  h.api.syncStyleTargets([node],'url("#bcp-live-style-live")')
  node.style.setProperty('filter','grayscale(.2)')
  h.api.syncStyleTargets([node],'url("#bcp-live-style-live")')
  assert.equal(node.style.getPropertyValue('filter'),'grayscale(.2) url("#bcp-live-style-live")')
  h.api.restoreStyleTargets();assert.equal(node.style.getPropertyValue('filter'),'grayscale(.2)');assert.equal(node.style.getPropertyPriority('filter'),'')
  h.api.syncStyleTargets([node],'url("#bcp-live-style-live")');node.style.setProperty('filter','blur(1px)')
  h.api.restoreStyleTargets();assert.equal(node.style.getPropertyValue('filter'),'blur(1px)')
})

test('media selection excludes cover, editor, danmaku and controls without double filtering a player wrapper', () => {
  const {api,document}=followHarness()
  const node=(localName,excluded=false,hasVideo=false)=>({localName,closest:()=>excluded?{}:null,querySelector:()=>hasVideo?{}:null})
  const video=node('video'),camera=node('canvas'),bwp=node('bwp-video',false,true),emptyBwp=node('bwp-video')
  const host={querySelectorAll:()=>[video,camera,bwp,emptyBwp,node('canvas',true),node('video',true)]}
  assert.deepEqual([...api.styleMediaIn(host)],[video,camera,emptyBwp])
  document.body=host;assert.equal(api.styleMediaIn(host).length,0)
})
