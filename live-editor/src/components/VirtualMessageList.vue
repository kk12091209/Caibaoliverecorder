<script setup>
import { ui } from '../../shared/ui-copy.js';

import {ref,computed,watch,nextTick,onMounted,onBeforeUnmount} from 'vue';
const props=defineProps({rows:{type:Array,default:()=>[]},busy:Boolean,hasBefore:Boolean,hasAfter:Boolean,automatic:Boolean,bounded:Boolean});
const emit=defineEmits(['page','manual','time']);
const box=ref(null),top=ref(0),height=ref(600),revision=ref(0),sizes=new Map(),nodes=new Map();
const key=row=>`${row.type}:${row.id}`;
const offsets=computed(()=>{revision.value;const out=[0];for(const row of props.rows)out.push(out.at(-1)+(sizes.get(key(row))||88));return out;});
function indexAt(y){const a=offsets.value;let l=0,r=props.rows.length;while(l<r){const m=(l+r)>>1;if(a[m+1]<=y)l=m+1;else r=m;}return Math.min(l,Math.max(0,props.rows.length-1));}
const first=computed(()=>Math.max(0,indexAt(Math.max(0,top.value-32))-6));
const last=computed(()=>Math.min(props.rows.length,indexAt(top.value+height.value)+8));
const shown=computed(()=>props.rows.slice(first.value,last.value).map((row,n)=>({row,index:first.value+n,key:key(row)})));
let observer,raf=0,programmatic=false,programmaticTop=null,navigationVersion=0;
function capture(){const i=indexAt((box.value?.scrollTop||0)-32);return props.rows[i]?{key:key(props.rows[i]),offset:(box.value?.scrollTop||0)-32-offsets.value[i]}:null;}
async function restore(anchor){const version=navigationVersion,rows=props.rows;await nextTick();if(!anchor||!box.value||version!==navigationVersion||rows!==props.rows)return;const i=props.rows.findIndex(row=>key(row)===anchor.key);if(i>=0)setTop(32+offsets.value[i]+anchor.offset);}
function setTop(value){if(!box.value)return;navigationVersion++;programmatic=true;box.value.scrollTop=Math.max(0,value);top.value=box.value.scrollTop;programmaticTop=top.value;requestAnimationFrame(()=>{programmatic=false;});}
function scrollToTime(time,interpolate=false){
  const rows=props.rows;
  if(!rows.length||!box.value)return;
  let i=rows.findIndex(row=>row.time>=time);
  if(i<0)i=rows.length-1;
  const positions=offsets.value;
  let offset=positions[i];
  const previous=rows[i-1],next=rows[i];
  if(interpolate&&previous&&previous.time<time&&time<next.time){
    const progress=(time-previous.time)/(next.time-previous.time);
    offset=positions[i-1]+progress*(offset-positions[i-1]);
  }
  setTop(32+offset-height.value*.66);
}
function page(direction){if(!props.busy)emit('page',direction);}
function scroll(){const controlled=programmatic||programmaticTop!==null&&Math.abs((box.value?.scrollTop||0)-programmaticTop)<1,mayPage=!props.automatic&&!controlled;if(raf)return;raf=requestAnimationFrame(()=>{raf=0;top.value=box.value?.scrollTop||0;const row=props.rows[indexAt(top.value-32)];if(row&&!controlled)emit('time',row.time);if(mayPage){if(top.value<180&&props.hasBefore)page('before');else if(top.value+height.value>offsets.value.at(-1)-180&&props.hasAfter)page('after');}});}
function manual(){navigationVersion++;programmaticTop=null;programmatic=false;emit('manual');}
function bind(el,k){const old=nodes.get(k);if(old&&old!==el)observer?.unobserve(old);if(!el){nodes.delete(k);return;}nodes.set(k,el);observer?.observe(el);}
watch(()=>props.rows,()=>{const live=new Set(props.rows.map(key));for(const k of sizes.keys())if(!live.has(k))sizes.delete(k);});
onMounted(()=>{
  observer=new ResizeObserver(entries=>{
    const anchor=capture();let changed=false;
    for(const entry of entries){if(entry.target===box.value){height.value=entry.contentRect.height;continue;}const k=entry.target.dataset.rowKey,h=entry.borderBoxSize?.[0]?.blockSize||entry.target.getBoundingClientRect().height;if(h>0&&Math.abs((sizes.get(k)||88)-h)>.5){sizes.set(k,h);changed=true;}}
    if(changed){revision.value++;void restore(anchor);}
  });observer.observe(box.value);for(const el of nodes.values())observer.observe(el);
});
onBeforeUnmount(()=>{observer?.disconnect();cancelAnimationFrame(raf);});
defineExpose({capture,restore,scrollToTime,reset:()=>setTop(0)});
</script>
<template>
  <div id="message-list-scroll" ref="box" class="danmaku-list virtual-message-list" tabindex="0" :aria-label="ui.messages.弹幕列表" @scroll="scroll" @wheel.passive="manual" @touchstart.passive="manual" @pointerdown="manual" @keydown.stop="['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes($event.key)&&manual()">
    <div class="feed-boundary"><button v-if="hasBefore" :disabled="busy" @click="page('before')">{{ ui.messages.更早 }}</button></div>
    <slot v-if="!rows.length" name="empty"/>
    <div :style="{height:offsets[first]+'px'}" aria-hidden="true"/>
    <div v-for="item in shown" :key="item.key" :ref="el=>bind(el,item.key)" :data-row-key="item.key"><slot :message="item.row"/></div>
    <div :style="{height:(offsets.at(-1)-offsets[last])+'px'}" aria-hidden="true"/>
    <div class="feed-boundary"><span v-if="busy" role="status">{{ ui.messages.加载中 }}</span><button v-else-if="hasAfter" @click="page('after')">{{ ui.messages.更多 }}</button></div>
  </div>
</template>
<style scoped>
.virtual-message-list{overflow-anchor:none;overscroll-behavior:contain;min-height:0;min-width:0;scrollbar-width:none;}
.virtual-message-list::-webkit-scrollbar{display:none;}
.feed-boundary{height:32px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted,#936674);}
.feed-boundary button{border:0;background:transparent;color:inherit;cursor:pointer;text-decoration:underline;}
</style>
