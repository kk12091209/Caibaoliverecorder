<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import GiftOverlay from './GiftOverlay.vue';
import { giftMetrics, giftRegions } from '../../shared/gift-layout.js';
import lantern from '../assets/sample-gift-lantern.png';
import snack from '../assets/sample-gift-snack.png';

const props=defineProps({ style:Object, disabled:Boolean, active:{type:String,default:'gift'} });
const emit=defineEmits(['select','height']);
const width=1920,height=1080;
const canvas=ref(null),scene=ref('daily'),editing=ref(true),playing=ref(false),time=ref(.85);
const labels={gift:'普通礼物区',sc:'醒目留言区'};
const scenes=[{id:'daily',name:'日常'},{id:'full',name:'满列'},{id:'burst',name:'密集连发'}];
let animation,begin=null,drag=null;
const metrics=computed(()=>giftMetrics(width,height,props.style));
const regions=computed(()=>giftRegions(metrics.value,props.style));
const outline=key=>{
  const region=regions.value[key];
  return {left:region.x/width*100+'%',width:region.width/width*100+'%',
    top:region.top/height*100+'%',height:(region.end-region.top)/height*100+'%'};
};
function step(now){
  begin??=now;
  time.value=((now-begin)/1000+.3)%12;
  animation=requestAnimationFrame(step);
}
function toggle(){
  playing.value=!playing.value;
  if(playing.value){begin=null;animation=requestAnimationFrame(step);}
  else cancelAnimationFrame(animation);
}
function selectScene(next){
  scene.value=next;time.value=next==='daily'?.85:1.65;begin=null;
  if(playing.value)toggle();
}
onBeforeUnmount(()=>cancelAnimationFrame(animation));
function changeHeight(value){
  emit('height',{key:props.active,value:Math.max(1,Math.min(100,Math.round(value)))});
}
function startDrag(event){
  const area=canvas.value.getBoundingClientRect();
  drag={top:area.top,height:area.height,id:event.pointerId,key:props.active};
  event.currentTarget.setPointerCapture(event.pointerId);
}
function stretch(event){
  if(!drag||event.pointerId!==drag.id||drag.key!==props.active)return;
  const pos=(event.clientY-drag.top)/drag.height*height,zone=regions.value[drag.key];
  const {vertical}=metrics.value;
  const length=zone.bottom?height-vertical-pos:pos-vertical;
  changeHeight(length/(height-2*vertical)*100);
}
function keyHeight(event){
  if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();
  const value=props.style[props.active==='gift'?'giftHeight':'scHeight'];
  changeHeight(event.key==='Home'?1:event.key==='End'?100:value+
    (event.key==='ArrowUp'?-1:1)*(regions.value[props.active].bottom?-1:1));
}
const gifts=[
  {id:'snack',type:'gift',time:.08,platform:'douyin',name:'辣条',user:'南风',count:1,iconUrl:snack},
  {id:'lamp',type:'gift',time:.15,platform:'bilibili',name:'粉丝团灯牌',user:'木木',count:3,iconUrl:lantern},
  {id:'fallback',type:'gift',time:.2,platform:'bilibili',name:'打call',user:'阿池',count:2},
  {id:'guard',type:'guard',time:.35,platform:'bilibili',name:'舰长',user:'星野',count:1},
];
const messages=[
  ['山海听风',30,'这把空格键听起来真舒服。'],
  ['不困的阿喵',50,'能再敲一下回车键吗？'],
  ['一颗小橘子',100,'我想听一下两把键盘有什么区别，能敲一下刚才那把吗？'],
  ['浅蓝',500,'请问这个配色还会补货吗？'],
  ['慢慢',1000,'喜欢这次直播，辛苦啦。'],
  ['小云',2000,'来晚啦，刚才的演示能再看一遍吗？'],
];
function chat(index,time){
  const [user,totalPrice,text]=messages[index%messages.length];
  return {id:'sc-'+index,type:'sc',platform:'bilibili',time,user,totalPrice,text};
}
const events=computed(()=>{
  if(scene.value==='daily')return [gifts[0],chat(0,.36)];
  const full=Array.from({length:15},(_,i)=>chat(i,.36+i*.068));
  if(scene.value==='full')return [gifts[1],gifts[2],gifts[3],...full];
  return [...gifts,...full,...Array.from({length:14},(_,i)=>chat(i+15,2+i*.44)),
    ...Array.from({length:10},(_,i)=>({...gifts[i%2],id:'burst-'+i,time:1.6+i*.67}))];
});
</script>

<template>
  <div ref="canvas" class="gift-preview-frame">
    <slot/>
    <GiftOverlay :style="props.style" :events="events" :time="time"/>
    <template v-if="editing">
      <div v-for="area in ['gift','sc']" :key="area" class="gift-region"
           :class="{ 'selected-region':area===active, 'sc-region':area==='sc' }" :style="outline(area)">
        <span class="gift-region-name">{{labels[area]}}</span>
        <button v-if="area===active" type="button" class="gift-region-handle"
                :class="{'at-top':regions[area].bottom}" :disabled="disabled" :aria-label="'调整'+labels[area]+'高度'"
                @pointerdown="startDrag" @pointermove="stretch" @pointerup="drag=null" @pointercancel="drag=null" @keydown="keyHeight"/>
      </div>
    </template>
  </div>
  <div class="gift-preview-controls">
    <select :value="scene" aria-label="礼物演示场景" @change="selectScene($event.target.value)">
      <option v-for="option in scenes" :key="option.id" :value="option.id">{{option.name}}</option>
    </select>
    <button type="button" class="button small" @click="toggle">{{playing?'暂停演示':'播放进出效果'}}</button>
    <button type="button" class="button small" @click="editing=!editing">{{editing?'看成片':'调整区域'}}</button>
    <select v-if="editing" :value="active" aria-label="选择要调整的区域" @change="emit('select',$event.target.value)">
      <option value="gift">调整普通礼物区</option><option value="sc">调整醒目留言区</option>
    </select>
  </div>
</template>

<style scoped>
.gift-preview-frame{position:relative;width:100%;aspect-ratio:16/9;border-radius:var(--radius-card);overflow:hidden}
.gift-preview-controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}
.gift-preview-controls select{width:auto;margin:0}
.gift-region{position:absolute;z-index:6;border:1px dashed #a8f1e9;box-sizing:border-box;pointer-events:none;color:#d9fff9}
.sc-region{border-color:#ffe1a3;color:#fff0cb}
.selected-region{z-index:7;border-width:2px}
.gift-region-name{position:absolute;top:0;left:0;border-radius:0 0 6px 0;background:#172832eb;
  padding:2px 5px;font-size:clamp(9px,1.5vw,11px);white-space:nowrap}
.gift-region-handle{pointer-events:auto;touch-action:none;position:absolute;left:50%;bottom:0;transform:translate(-50%,50%);
  width:min(32px,60%);height:10px;border:2px solid #223039;border-radius:8px;background:#fdf9ff;cursor:ns-resize}
.gift-region-handle.at-top{top:0;bottom:auto;transform:translate(-50%,-50%)}
</style>
