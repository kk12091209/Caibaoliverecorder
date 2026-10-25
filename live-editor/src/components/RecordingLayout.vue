<script setup>
import {ref,watch,onMounted,onBeforeUnmount} from 'vue';
import {drawRecordingLayout} from '../recording-layout-preview.js';

const props=defineProps({video:Object,events:{type:Array,default:()=>[]},style:Object,base:{type:Number,default:0},loading:Boolean});
const canvas=ref(null),active=ref(false);
let player,observer,frame=0,raf=0;
const names=['timeupdate','seeking','seeked','loadedmetadata','loadeddata','resize','play','pause','ended','emptied'];
function cancel(){if(frame&&player?.cancelVideoFrameCallback)player.cancelVideoFrameCallback(frame);if(raf)cancelAnimationFrame(raf);frame=raf=0;}
function update(){
  const el=canvas.value;if(!el)return;
  const ctx=el.getContext('2d');
  if(props.loading||!player?.videoWidth||player.readyState<2||player.seeking){ctx.clearRect(0,0,el.width,el.height);active.value=false;}
  else try{active.value=drawRecordingLayout(ctx,player,props.events,props.base+Math.max(0,player.currentTime-(player.ended ? .001 : 0)),props.style,el.width,el.height);}catch{ctx.clearRect(0,0,el.width,el.height);active.value=false;}
  if(!frame&&!raf&&player&&!player.paused&&props.events.length&&props.style?.cameraPosition!=='original'){
    if(player.requestVideoFrameCallback)frame=player.requestVideoFrameCallback(()=>{frame=0;update();});
    else raf=requestAnimationFrame(()=>{raf=0;update();});
  }
}
function resize(){const el=canvas.value;if(!el)return;const r=el.getBoundingClientRect(),scale=Math.min(window.devicePixelRatio||1,2,2048/Math.max(1,r.width));el.width=Math.max(2,Math.round(r.width*scale));el.height=Math.max(2,Math.round(r.height*scale));update();}
function bind(value){cancel();for(const event of names)player?.removeEventListener(event,update);player=value;for(const event of names)player?.addEventListener(event,update);update();}
watch(()=>props.video,bind);
watch(()=>[props.events,props.style,props.base,props.loading],update,{deep:true});
onMounted(()=>{bind(props.video);observer=new ResizeObserver(resize);observer.observe(canvas.value);resize();});
onBeforeUnmount(()=>{observer?.disconnect();bind(null);});
</script>
<template><canvas ref="canvas" class="recording-layout" :data-active="active" aria-hidden="true"/></template>
<style scoped>.recording-layout{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;contain:strict}</style>
