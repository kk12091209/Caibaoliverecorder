<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createRecordingClock, toRecordingInput } from '../recording-time.js';
import TimestampText from './TimestampText.vue';
import { normalizedTimestampPosition } from '../../shared/timestamp-style.js';
import { containedVideoFrame } from '../../shared/video-geometry.js';

const props=defineProps({video:Object,base:{type:Number,default:0},session:Object,sources:Array,loading:Boolean,timestampStyle:String,timestampPosition:String});
const surface=ref(null),label=ref(''),epoch=ref(null),frame=ref(null);
const clock=computed(()=>createRecordingClock(props.session,props.sources));
let observer,width=0,height=0;
function measure(){
  const video=props.video;
  if(!width||!height||!video?.videoWidth||!video?.videoHeight){frame.value=null;return;}
  const {width:w,height:h,left,top}=containedVideoFrame(width,height,video.videoWidth,video.videoHeight),pad=Math.min(8,w*.025,h*.025);
  const position=normalizedTimestampPosition(props.timestampPosition),right=position.endsWith('right'),bottom=position.startsWith('bottom');
  const x=`${left+pad}px`,y=`${top+pad}px`;
  frame.value={left:right?'auto':x,right:right?x:'auto',top:bottom?'auto':y,bottom:bottom?y:'auto',maxWidth:`${Math.max(0,w-2*pad)}px`,fontSize:`${Math.max(11,Math.min(14,w/50))}px`};
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
watch(()=>props.timestampPosition,measure);
onMounted(()=>{
  observer=new ResizeObserver(entries=>{const rect=entries[0]?.contentRect;if(rect){width=rect.width;height=rect.height;measure();}});
  observer.observe(surface.value);
});
onBeforeUnmount(()=>observer?.disconnect());
</script>

<template>
  <!-- DOM only: this component never touches video pixels or export settings. -->
  <div ref="surface" class="recording-timestamp-layer" aria-hidden="true">
    <TimestampText v-if="label&&frame" class="recording-timestamp" :label="label" :variant="timestampStyle" :position="timestampPosition" :style="frame" :data-epoch="epoch" title="录制时间（北京时间），仅用于本地预览"/>
  </div>
</template>

<style scoped>
.recording-timestamp-layer{position:absolute;inset:0;pointer-events:none;z-index:4;}
.recording-timestamp{position:absolute;overflow:hidden;}
</style>
