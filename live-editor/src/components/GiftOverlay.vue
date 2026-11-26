<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { DEFAULT_GIFT_STYLE } from '../../shared/gifts.js';
import { giftFrame, giftMetrics, giftOpacity, giftTimeline } from '../../shared/gift-layout.js';
import GiftIcon from './GiftIcon.vue';

const props=defineProps({
  events:{type:Array,default:()=>[]}, video:Object, style:Object, loading:Boolean,
  cameraEvents:{type:Array,default:()=>[]}, recordingStyle:Object, sources:Array,
  base:{type:Number,default:0}, time:{type:Number,default:0},
  frameWidth:{type:Number,default:1920}, frameHeight:{type:Number,default:1080},
});
const emit=defineEmits(['visible']);
const surface=ref(null),size=ref({width:0,height:0}), videoSize=ref(null),videoTime=ref(0);
const width=computed(()=>videoSize.value?.width||props.frameWidth);
const height=computed(()=>videoSize.value?.height||props.frameHeight);
const style=computed(()=>props.style||DEFAULT_GIFT_STYLE);
const metrics=computed(()=>giftMetrics(width.value,height.value,style.value));
const scale=computed(()=>Math.min(size.value.width/width.value,size.value.height/height.value));
const clock=computed(()=>props.video?props.base+videoTime.value:props.time);
const track=computed(()=>giftTimeline(props.events,width.value,height.value,style.value,{
  cameraEvents:props.cameraEvents,recordingStyle:props.recordingStyle,
  cameraSizeAt:event=>props.sources?.find(s=>s.id===event.source)?.metadata,
}));
const cards=computed(()=>props.loading||scale.value<=0?[]:giftFrame(track.value,clock.value));
watch(cards,items=>emit('visible',new Set(items.map(item=>item.entry.id))));
const stage=computed(()=>({
  width:width.value+'px',height:height.value+'px',
  top:(size.value.height-scale.value*height.value)/2+'px',
  left:(size.value.width-scale.value*width.value)/2+'px',
  transform:`scale(${scale.value})`,fontSize:metrics.value.size+'px',
  '--gift-pad':metrics.value.pad+'px','--gift-gap':metrics.value.gap+'px',
  '--gift-icon-size':metrics.value.icon+'px',
  '--gift-radius':metrics.value.radius+'px',
  '--gift-head':metrics.value.head+'px','--gift-line':metrics.value.line+'px',
}));
const box=item=>({
  left:item.x+'px',top:item.y+'px',width:item.w+'px',height:item.h+'px',
  opacity:giftOpacity(item,clock.value),
  '--card-bg':item.background,'--card-head':item.header,'--card-ink':item.ink,'--head-ink':item.headerInk,
});
let observer, frame, player;
const videoEvents=['timeupdate','loadedmetadata','resize','seeking','seeked','play','pause','ended','emptied'];
function update(){
  if (!player) { videoSize.value=null;return; }
  videoTime.value=player.currentTime;
  if (player.videoWidth && player.videoHeight &&
      (player.videoWidth!==videoSize.value?.width||player.videoHeight!==videoSize.value?.height)) {
    videoSize.value={width:player.videoWidth,height:player.videoHeight};
  }
  if (!frame && !player.paused && props.events.length) frame=requestAnimationFrame(()=>{
    frame=undefined;update();
  });
}
function bind(next){
  cancelAnimationFrame(frame);frame=undefined;
  for(const name of videoEvents)player?.removeEventListener(name,update);
  player=next;videoSize.value=null;
  for(const name of videoEvents)player?.addEventListener(name,update);
  update();
}
watch(()=>props.video,bind);
watch(()=>props.events,update);
onMounted(()=>{
  bind(props.video);
  observer=new ResizeObserver(([entry])=>{size.value=entry.contentRect;});
  if(surface.value)observer.observe(surface.value);
});
onBeforeUnmount(()=>{observer?.disconnect();bind(null);});
</script>

<template>
  <div ref="surface" class="gift-surface" aria-hidden="true">
    <div :style="stage" class="gift-stage">
      <div v-for="item in cards" :key="item.entry.id" class="gift-item" :style="box(item)"
           :class="{'gift-sc':item.entry.type==='sc','gift-guard':item.entry.type==='guard'}">
        <template v-if="item.entry.type==='sc'">
          <div class="gift-sc-head"><span>{{item.title}}</span><span>{{item.price}}</span></div>
          <div class="gift-sc-body"><div v-for="(line,index) in item.lines" :key="index">{{line}}</div></div>
        </template>
        <template v-else>
          <GiftIcon class="gift-row-icon" :gift="item.entry" video/>
          <span>{{item.label}}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gift-surface{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5}
.gift-stage{position:absolute;transform-origin:0 0;font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;font-weight:700}
.gift-item{position:absolute;display:flex;align-items:center;overflow:hidden;box-sizing:border-box;white-space:nowrap;
  padding:0 var(--gift-pad);gap:var(--gift-gap);color:#fff;text-shadow:-1px -1px 1px #141014,1px -1px 1px #141014,-1px 1px 1px #141014,1px 1px 1px #141014}
.gift-guard{color:#a6dafa}
.gift-row-icon{width:var(--gift-icon-size);height:var(--gift-icon-size)}
.gift-sc{display:block;background:var(--card-bg);color:var(--card-ink);border-radius:var(--gift-radius);padding:0;text-shadow:none}
.gift-sc-head{display:flex;justify-content:space-between;align-items:center;box-sizing:border-box;gap:var(--gift-gap);
  padding:0 var(--gift-pad);height:var(--gift-head);background:var(--card-head);color:var(--head-ink);font-size:.88em}
.gift-sc-head span:first-child{overflow:hidden;text-overflow:ellipsis}
.gift-sc-body{padding:var(--gift-pad);line-height:var(--gift-line)}
</style>
