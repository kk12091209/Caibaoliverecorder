<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createRecordingClock, toRecordingInput } from '../recording-time.js';

const props=defineProps({video:Object,base:{type:Number,default:0},session:Object,sources:Array,loading:Boolean});
const surface=ref(null),label=ref(''),epoch=ref(null),frame=ref(null);
const clock=computed(()=>createRecordingClock(props.session,props.sources));
let observer,width=0,height=0;
function measure(){
  const video=props.video;
  if(!width||!height||!video?.videoWidth||!video?.videoHeight){frame.value=null;return;}
  const scale=Math.min(width/video.videoWidth,height/video.videoHeight);
  const w=video.videoWidth*scale,h=video.videoHeight*scale,pad=Math.min(8,w*.025,h*.025);
  frame.value={left:`${(width-w)/2+pad}px`,top:`${(height-h)/2+pad}px`,maxWidth:`${Math.max(0,w-2*pad)}px`,fontSize:`${Math.max(11,Math.min(14,w/50))}px`};
}
function update(){
  const video=props.video;
  if(props.loading||!video||video.seeking||video.readyState<2){label.value='';epoch.value=null;return;}
  const wall=clock.value(props.base+video.currentTime);
  const second=wall===null?null:Math.floor(wall/1000)*1000;
  if(second===epoch.value)return;
  epoch.value=second;
  try{label.value=second===null?'':toRecordingInput(second).slice(0,19).replace('T',' ');}
  catch{label.value='';}
}
watch(()=>props.video,(video,_,onCleanup)=>{
  const refresh=()=>{measure();update();};
  const events=['timeupdate','seeking','seeked','loadeddata','pause','ended','emptied'];
  for(const name of events)video?.addEventListener(name,update);
  for(const name of ['loadedmetadata','resize'])video?.addEventListener(name,refresh);
  refresh();
  onCleanup(()=>{
    for(const name of events)video?.removeEventListener(name,update);
    for(const name of ['loadedmetadata','resize'])video?.removeEventListener(name,refresh);
  });
},{immediate:true});
watch([clock,()=>props.base,()=>props.loading],update);
onMounted(()=>{
  observer=new ResizeObserver(entries=>{const rect=entries[0]?.contentRect;if(rect){width=rect.width;height=rect.height;measure();}});
  observer.observe(surface.value);
});
onBeforeUnmount(()=>observer?.disconnect());
</script>

<template>
  <!-- DOM only: this component never touches video pixels or export settings. -->
  <div ref="surface" class="recording-timestamp-layer" aria-hidden="true">
    <time v-if="label&&frame" class="recording-timestamp" :style="frame" :datetime="label.replace(' ','T')+'+08:00'" :data-epoch="epoch" title="录制时间（北京时间），仅用于本地预览"><span>{{ label.slice(0,10) }}</span><span>{{ label.slice(11) }}</span></time>
  </div>
</template>

<style scoped>
.recording-timestamp-layer{position:absolute;inset:0;pointer-events:none;z-index:4;}
.recording-timestamp{position:absolute;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;width:max-content;box-sizing:border-box;overflow:hidden;border-radius:4px;padding:4px 6px;color:#fff;background:rgba(0,0,0,.48);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;line-height:1.3;text-shadow:0 1px 2px #000;}
.recording-timestamp span{white-space:nowrap;}
</style>
