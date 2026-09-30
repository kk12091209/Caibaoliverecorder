<script setup>
import { ref, computed, onBeforeUnmount } from 'vue';
import { windowPercent } from '../timeline-signals.js';
import { formatVideoTime } from '../video-time.js';

const props=defineProps({kind:String,time:Number,from:Number,to:Number,min:{type:Number,default:0},max:Number,fps:{type:Number,default:30},disabled:Boolean});
const emit=defineEmits(['change','commit','start','end']);
const handle=ref(null),dragging=ref(false);
let drag=null;
const label=computed(()=>props.kind==='start'?'起点':'终点');
const percent=computed(()=>windowPercent(props.time,props.from,props.to));
const bounds=()=>({min:Math.max(0,props.min),max:Math.max(props.min,props.max)});
function change(time){const {min,max}=bounds();const value=Math.max(min,Math.min(max,Math.round(time*1000)/1000));emit('change',value);return value;}
function down(event){
  if(props.disabled||event.button!==0)return;
  const rect=handle.value.parentElement.getBoundingClientRect();if(!(rect.width>0&&props.to>props.from))return;
  drag={pointer:event.pointerId,x:event.clientX,time:props.time,original:props.time,scale:(props.to-props.from)/rect.width,from:props.from,to:props.to};
  dragging.value=true;handle.value.setPointerCapture(event.pointerId);handle.value.focus({preventScroll:true});emit('start');
}
function move(event){
  if(drag?.pointer!==event.pointerId)return;
  const time=drag.time+(event.clientX-drag.x)*drag.scale*(event.shiftKey?.1:1);
  drag.x=event.clientX;drag.time=change(Math.max(drag.from,Math.min(drag.to,time)));
}
function finish(event,cancel=false){
  if(!drag||event.pointerId!==drag.pointer)return;
  const current=drag;drag=null;dragging.value=false;
  if(cancel)change(current.original);else emit('commit',current.time);
  if(handle.value?.hasPointerCapture(current.pointer))handle.value.releasePointerCapture(current.pointer);
  emit('end');
}
function key(event){
  if(props.disabled)return;
  const step=event.shiftKey?.001:1/(props.fps>0?props.fps:30),{min,max}=bounds();
  let time;
  if(['ArrowLeft','ArrowDown'].includes(event.key))time=props.time-step;
  else if(['ArrowRight','ArrowUp'].includes(event.key))time=props.time+step;
  else if(event.key==='Home')time=min;
  else if(event.key==='End')time=max;
  else return;
  event.preventDefault();emit('commit',change(time));
}
onBeforeUnmount(()=>{if(drag){drag=null;emit('end');}});
</script>

<template>
  <div ref="handle" class="timeline-marker" :class="['marker-'+kind,{nearend:percent>80,dragging}]" :style="{left:percent+'%'}" role="slider" :tabindex="disabled?-1:0" :aria-label="label+'标记'" aria-orientation="horizontal" :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="time" :aria-valuetext="formatVideoTime(time,true)" :aria-disabled="disabled" :title="label+' '+formatVideoTime(time,true)+'；拖动调整，Shift 小幅拖动，方向键逐帧微调'" @pointerdown.stop.prevent="down" @pointermove.stop="move" @pointerup.stop="finish($event)" @pointercancel.stop="finish($event,true)" @lostpointercapture="finish($event,true)" @keydown.stop="key">
    <span :style="{'--label-shift':`max(0px, calc(80px - ${percent}cqw))`}">{{ kind==='start'?'I':'O' }} {{ label }}</span>
  </div>
</template>
