<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { labelsAt, labelGeometry } from '../../shared/linkmic-labels.js';

const props=defineProps({session:String,video:Object,base:{type:Number,default:0},loading:Boolean});
const emit=defineEmits(['cameras']);
const surface=ref(null),events=ref([]),time=ref(0),size=ref({width:0,height:0});
let player,observer,timer,request,disposed=false,frame=0,generation=0;
const playbackEvents=['timeupdate','seeking','seeked','loadedmetadata','loadeddata','resize','play','pause','ended','emptied'];
const geometry=computed(()=>{
  if(props.loading||!player?.videoWidth||player.readyState<2)return [];
  return labelsAt(events.value,time.value).map(person=>labelGeometry(person,size.value.width,size.value.height,player.videoWidth,player.videoHeight)).filter(g=>g?.text);
});
const styleFor=g=>({left:g.left+'px',top:g.top+'px',width:(g.right-g.left)+'px',height:(g.bottom-g.top)+'px'});
const textStyle=g=>({right:(g.right-g.x)+'px',bottom:(g.bottom-g.y)+'px',fontSize:g.size+'px',maxWidth:g.maxWidth+'px'});
const avatarStyle=g=>({left:(g.avatarX-g.left)+'px',top:(g.avatarY-g.top)+'px',width:g.avatarSize+'px',height:g.avatarSize+'px'});
function update(){
  const current=player?.currentTime||0;
  time.value=props.base+(player?.ended?Math.max(0,current-.001):current);
  if(!frame&&player&&!player.paused&&player.requestVideoFrameCallback)frame=player.requestVideoFrameCallback(()=>{frame=0;update();});
}
function resize(){if(surface.value){const box=surface.value.getBoundingClientRect();size.value={width:box.width,height:box.height};}update();}
function bind(video){
  if(frame&&player?.cancelVideoFrameCallback)player.cancelVideoFrameCallback(frame);frame=0;
  if(player)for(const event of playbackEvents)player.removeEventListener(event,resize);
  player=video;
  if(player)for(const event of playbackEvents)player.addEventListener(event,resize);
  resize();
}
async function load(){
  if(disposed||!props.session||request)return;
  const current=generation,controller=new AbortController();request=controller;
  const from=Math.max(0,props.base+(player?.currentTime||0)-10),to=from+60;
  try {
    const response=await fetch(`/api/sessions/${encodeURIComponent(props.session)}/linkmic?from=${from}&to=${to}`,{signal:controller.signal});
    if(!response.ok)return;
    const result=await response.json();
    if(current===generation&&!disposed){events.value=result.events;emit('cameras',result.cameraEvents||[]);update();}
  }catch{/* Names are optional; playback continues during a transient request failure. */}
  finally{if(request===controller)request=null;}
}
watch(()=>props.video,bind);
watch(()=>[props.session,props.base],()=>{generation++;request?.abort();request=null;events.value=[];emit('cameras',[]);update();void load();});
onMounted(()=>{bind(props.video);observer=new ResizeObserver(resize);observer.observe(surface.value);void load();timer=setInterval(load,1500);});
onBeforeUnmount(()=>{disposed=true;request?.abort();clearInterval(timer);observer?.disconnect();bind(null);});
</script>

<template>
  <div ref="surface" class="linkmic-overlay" aria-label="连麦主播名牌">
    <div v-for="(label,index) in geometry" :key="index" class="linkmic-tile" :class="{'linkmic-audio':label.audioOnly}" :style="styleFor(label)">
      <img v-if="label.audioOnly&&label.avatar" class="linkmic-avatar" :src="label.avatar" alt="" :style="avatarStyle(label)">
      <span class="linkmic-name" :style="textStyle(label)">{{ label.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.linkmic-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:3}
.linkmic-tile{position:absolute;overflow:hidden}
.linkmic-audio{background:rgba(53,53,61,.8)}
.linkmic-avatar{position:absolute;object-fit:contain;border-radius:50%}
.linkmic-name{position:absolute;color:#fff;font-family:"Microsoft YaHei","Segoe UI",sans-serif;font-weight:400;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000,0 0 3px #0009}
</style>
