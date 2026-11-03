<script setup>
import { ui } from '../../shared/ui-copy.js';

import {ref,onMounted,onBeforeUnmount} from 'vue';
import {edgeVelocity,panWindow,timeAtPixel} from '../timeline-signals.js';
const props=defineProps({from:Number,to:Number,duration:Number,time:Number,disabled:Boolean});
const emit=defineEmits(['start','end','change','commit','pan']);
const surface=ref(null);let drag,frame=0;
function down(e){if(props.disabled||e.button!==0)return;e.preventDefault();surface.value.focus({preventScroll:true});surface.value.setPointerCapture(e.pointerId);drag={pointer:e.pointerId,x:e.clientX,lastX:e.clientX,original:props.time,time:props.time,pan:e.altKey,last:performance.now()};emit('start');update();frame=requestAnimationFrame(tick);}
function update(){if(!drag)return;const rect=surface.value.getBoundingClientRect();if(drag.pan){emit('pan',props.from-(drag.x-drag.lastX)*(props.to-props.from)/rect.width);drag.lastX=drag.x;return;}drag.time=timeAtPixel(drag.x-rect.left,rect.width,props.from,props.to);emit('change',drag.time);}
function move(e){if(e.pointerId===drag?.pointer){drag.x=e.clientX;update();}}
function tick(now){if(!drag)return;const rect=surface.value.getBoundingClientRect(),dt=Math.min(.05,(now-drag.last)/1000);drag.last=now;
  if(!drag.pan){const velocity=edgeVelocity(drag.x-rect.left,rect.width,props.to-props.from),next=panWindow(props.duration,{from:props.from,to:props.to},props.from+velocity*dt);if(next.from!==props.from){emit('pan',next.from);drag.time=timeAtPixel(drag.x-rect.left,rect.width,next.from,next.to);emit('change',drag.time);}}
  frame=requestAnimationFrame(tick);
}
function end(e,cancel=false){if(!drag||e&&e.pointerId!==drag.pointer)return;const old=drag;drag=null;cancelAnimationFrame(frame);if(cancel&&!old.pan)emit('change',old.original);else if(!old.pan)emit('commit',old.time);if(surface.value?.hasPointerCapture(old.pointer))surface.value.releasePointerCapture(old.pointer);emit('end');}
function blur(){end(null,true);}
function key(e){if(props.disabled)return;const next=e.key==='ArrowLeft'?props.time-1:e.key==='ArrowRight'?props.time+1:e.key==='Home'?0:e.key==='End'?props.duration:null;if(next===null)return;e.preventDefault();emit('commit',Math.max(0,Math.min(props.duration,next)));}
onMounted(()=>window.addEventListener('blur',blur));
onBeforeUnmount(()=>{window.removeEventListener('blur',blur);blur();});
</script>
<template><div ref="surface" class="timeline-scrubber" role="slider" tabindex="0" :aria-label="ui.timeline.播放位置" :aria-valuenow="time" :aria-valuemin="0" :aria-valuemax="duration" :aria-disabled="disabled" :title="ui.timeline.时间轴定位提示" @pointerdown.stop="down" @pointermove.stop="move" @pointerup.stop="end" @pointercancel.stop="end($event,true)" @lostpointercapture="end($event,true)" @keydown.stop="key"/></template>
<style scoped>.timeline-scrubber{position:absolute;inset:16px 0 0;z-index:3;touch-action:none;cursor:ew-resize;}.timeline-scrubber:focus-visible{outline:2px solid var(--rose);outline-offset:2px;}</style>
