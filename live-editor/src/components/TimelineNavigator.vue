<script setup>
import {computed,ref,watch,onMounted,onBeforeUnmount} from 'vue';
import {formatVideoTime as format} from '../video-time.js';

const props=defineProps({duration:{type:Number,default:0},from:{type:Number,default:0},to:{type:Number,default:0},disabled:Boolean});
const emit=defineEmits(['pan','start','end']);
const track=ref(null),dragging=ref(false),trackWidth=ref(0);let drag=null,keyboardActive=false,observer;
const span=computed(()=>Math.max(0,props.to-props.from));
const maxFrom=computed(()=>Math.max(0,props.duration-span.value));
const thumbWidth=computed(()=>Math.min(trackWidth.value,Math.max(28,props.duration>0?span.value/props.duration*trackWidth.value:trackWidth.value)));
const travel=computed(()=>Math.max(0,trackWidth.value-thumbWidth.value));
const movable=computed(()=>!props.disabled&&maxFrom.value>.001&&travel.value>0);
const thumbStyle=computed(()=>({left:(maxFrom.value>0?Math.max(0,Math.min(1,props.from/maxFrom.value))*travel.value:0)+'px',width:thumbWidth.value+'px'}));
const description=computed(()=>`显示 ${format(props.from)} 至 ${format(props.to)}，共 ${format(props.duration)}`);
function pan(from){emit('pan',Math.max(0,Math.min(maxFrom.value,from)));}
function pointerDown(event){
  if(!movable.value||event.button!==0||drag)return;
  event.preventDefault();track.value.focus({preventScroll:true});
  const rect=track.value.getBoundingClientRect();if(!travel.value)return;
  const grabbed=event.target.closest('.timeline-nav-thumb');
  const scale=maxFrom.value/travel.value;
  const from=grabbed?props.from:Math.max(0,Math.min(maxFrom.value,(event.clientX-rect.left-track.value.clientLeft-thumbWidth.value/2)*scale));
  drag={pointer:event.pointerId,x:event.clientX,from,scale};dragging.value=true;
  track.value.setPointerCapture(event.pointerId);emit('start');if(!grabbed)pan(from);
}
function pointerMove(event){if(drag?.pointer===event.pointerId)pan(drag.from+(event.clientX-drag.x)*drag.scale);}
function endDrag(){if(!drag)return;const pointer=drag.pointer;drag=null;dragging.value=false;if(track.value?.hasPointerCapture(pointer))track.value.releasePointerCapture(pointer);emit('end');}
function pointerEnd(event){if(event.pointerId===drag?.pointer)endDrag();}
function endKeyboard(){if(keyboardActive){keyboardActive=false;emit('end');}}
function endInteraction(){endDrag();endKeyboard();}
function keyPan(event){
  const step=Math.max(.1,span.value*(event.shiftKey ? .5 : .1));
  const from=event.key==='ArrowLeft'?props.from-step:event.key==='ArrowRight'?props.from+step:event.key==='PageUp'?props.from-span.value:event.key==='PageDown'?props.from+span.value:event.key==='Home'?0:event.key==='End'?maxFrom.value:null;
  if(from===null)return;event.preventDefault();if(movable.value){if(!keyboardActive){keyboardActive=true;emit('start');}pan(from);}
}
watch(movable,value=>{if(!value)endInteraction();});
onMounted(()=>{
  trackWidth.value=track.value.clientWidth;
  observer=new ResizeObserver(entries=>{const width=Math.max(0,entries[0]?.contentRect.width||0);if(width!==trackWidth.value){endInteraction();trackWidth.value=width;}});
  observer.observe(track.value);window.addEventListener('blur',endInteraction);
});
onBeforeUnmount(()=>{observer?.disconnect();window.removeEventListener('blur',endInteraction);endInteraction();});
</script>

<template>
  <div class="timeline-navigator" :class="{dragging,disabled:!movable}">
    <div ref="track" class="timeline-nav-track" role="scrollbar" aria-label="时间轴横向查看" aria-orientation="horizontal" aria-controls="timeline-tracks" :tabindex="movable?0:-1" :aria-disabled="!movable" :aria-valuemin="0" :aria-valuemax="maxFrom" :aria-valuenow="from" :aria-valuetext="description" :title="movable?'拖动或点击横向查看，不改变播放位置；方向键微移，PageUp / PageDown 翻页': '放大时间轴后，可在这里横向拖动查看'" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="pointerEnd" @lostpointercapture="pointerEnd" @keydown.stop="keyPan" @keyup.stop="endKeyboard" @blur="endInteraction">
      <div class="timeline-nav-thumb" :style="thumbStyle"><span/></div>
      <span v-if="!movable&&!disabled" class="timeline-nav-hint">放大后可左右拖动</span>
    </div>
  </div>
</template>
