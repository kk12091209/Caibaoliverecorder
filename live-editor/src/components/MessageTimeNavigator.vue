<script setup>
import { ui } from '../../shared/ui-copy.js';

import {ref,computed,onMounted,onBeforeUnmount} from 'vue';
const props=defineProps({from:Number,to:Number,time:Number,disabled:Boolean});
const emit=defineEmits(['start','preview','seek','cancel']);
const rail=ref(null),draft=ref(null);
let drag;
const clamp=value=>Math.max(props.from,Math.min(props.to,value));
const value=computed(()=>clamp(draft.value??props.time??props.from));
const percent=computed(()=>props.to>props.from?(value.value-props.from)/(props.to-props.from)*100:0);
const format=t=>[Math.floor(t/3600),Math.floor(t/60)%60,Math.floor(t)%60].map(n=>String(n).padStart(2,'0')).join(':');
function move(e){if(!drag||e.pointerId!==drag.id)return;const r=rail.value.getBoundingClientRect(),usable=Math.max(1,r.height-32);draft.value=clamp(props.from+(e.clientY-r.top-16-drag.offset)/usable*(props.to-props.from));emit('preview',draft.value);}
function down(e){
  if(props.disabled||props.to<=props.from||e.button!==0)return;
  e.preventDefault();rail.value.focus({preventScroll:true});rail.value.setPointerCapture(e.pointerId);
  const r=rail.value.getBoundingClientRect(),center=r.top+16+(r.height-32)*percent.value/100;
  drag={id:e.pointerId,offset:e.target.closest('.message-time-thumb')?e.clientY-center:0};
  draft.value=value.value;emit('start');move(e);
}
function end(e,cancel=false){if(!drag||e&&e.pointerId!==drag.id)return;const id=drag.id,next=value.value;drag=null;draft.value=null;if(rail.value?.hasPointerCapture(id))rail.value.releasePointerCapture(id);if(cancel)emit('cancel');else emit('seek',next);}
function blur(){end(null,true);}
function key(e){if(props.disabled)return;const step=Math.max(1,(props.to-props.from)/100),next=({ArrowUp:value.value-step,ArrowDown:value.value+step,PageUp:value.value-step*10,PageDown:value.value+step*10,Home:props.from,End:props.to})[e.key];if(next===undefined)return;e.preventDefault();emit('start');emit('seek',clamp(next));}
onMounted(()=>window.addEventListener('blur',blur));
onBeforeUnmount(()=>{window.removeEventListener('blur',blur);blur();});
</script>
<template>
  <div ref="rail" class="message-time-navigator" role="scrollbar" tabindex="0" :aria-label="ui.messages.按时间快速定位弹幕" aria-orientation="vertical" aria-controls="message-list-scroll" :aria-valuemin="from" :aria-valuemax="to" :aria-valuenow="value" :aria-valuetext="format(value)" :aria-disabled="disabled||to<=from" :title="ui.messages.定位弹幕" @pointerdown.stop="down" @pointermove.stop="move" @pointerup.stop="end" @pointercancel="end($event,true)" @lostpointercapture="end($event,true)" @keydown.stop="key">
    <div class="message-time-track"/><div class="message-time-thumb" :style="{top:percent+'%',transform:`translateY(-${percent}%)`}"><span/></div>
    <output v-if="draft!==null" class="message-time-tip" :style="{top:percent+'%',transform:`translateY(-${percent}%)`}">{{ format(value) }}</output>
  </div>
</template>
<style scoped>
.message-time-navigator{position:relative;flex:none;width:22px;min-height:48px;cursor:pointer;touch-action:none;outline:none;border-radius:var(--radius-card);margin:4px 0 8px 4px;}
.message-time-track{position:absolute;inset:0 6px;border-radius:var(--radius-card);background:#a64d681c;}
.message-time-thumb{position:absolute;left:4px;width:14px;height:32px;border-radius:var(--radius-control);background:#bf6882;display:grid;place-items:center;box-shadow:0 1px 3px #77334b26;}
.message-time-thumb span{height:8px;width:6px;border-top:1px solid #fff9;border-bottom:1px solid #fff9;}
.message-time-navigator:hover .message-time-thumb,.message-time-navigator:focus-visible .message-time-thumb{background:#9e425f;}
.message-time-navigator:focus-visible{box-shadow:0 0 0 2px var(--rose);}
.message-time-navigator[aria-disabled=true]{opacity:.35;cursor:default;}
.message-time-tip{position:absolute;right:26px;background:#673746;color:white;border-radius:var(--radius-control);padding:4px 7px;font-size:12px;font-variant-numeric:tabular-nums;z-index:4;pointer-events:none;white-space:nowrap;}
</style>
