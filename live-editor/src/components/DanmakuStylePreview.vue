<script setup>
import {ref,computed,watch,nextTick,onBeforeUnmount} from 'vue';
import image from '../assets/danmaku-style-preview.png';
import {danmakuGeometry} from '../../shared/danmaku-style.js';
const props=defineProps({style:Object,font:Object,rate:{type:Number,default:50}}),emit=defineEmits(['ready']);
const overlay=ref(''),pendingOverlay=ref(''),loading=ref(true),error=ref(''),samples=ref(0),geometry=computed(()=>danmakuGeometry(940,props.style));
const clips=ref([]),visibleClip=ref(''),motionLoading=ref(false),motionError=ref(''),players=new Map();
let timer,controller,generation=0,disposed=false,motionFinished=false;
function retainClip(url=''){
  for(const clip of clips.value)if(clip.url!==url){players.get(clip.url)?.pause();URL.revokeObjectURL(clip.url);}
  clips.value=clips.value.filter(clip=>clip.url===url);visibleClip.value=url;
}
function discardPending(){if(pendingOverlay.value)URL.revokeObjectURL(pendingOverlay.value);pendingOverlay.value='';}
function showStill(url){if(overlay.value)URL.revokeObjectURL(overlay.value);overlay.value=url;}
function finishMotion(){
  if(pendingOverlay.value){showStill(pendingOverlay.value);pendingOverlay.value='';}
  retainClip();motionLoading.value=false;
}
function schedule(motion=false){
  const version=++generation;clearTimeout(timer);controller?.abort();discardPending();
  // Keep the visible frame (or the running movie) until its replacement can
  // actually paint. Never flash the bare background or a new still in between.
  retainClip(motion===true?visibleClip.value:'');motionFinished=false;motionLoading.value=motion===true;motionError.value='';
  loading.value=true;error.value='';emit('ready',false);
  timer=setTimeout(()=>render(version,motion===true),250);
}
async function request(input,signal){
  for(let attempt=0;attempt<=4;attempt++){
    signal.throwIfAborted();
    const response=await fetch('/api/danmaku-style/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal});
    if(response.status===409&&attempt<4){await new Promise(resolve=>setTimeout(resolve,250));continue;}
    if(!response.ok)throw new Error((await response.json()).error||'样式预览生成失败。');
    return response;
  }
}
async function render(version,motion){
  if(disposed||version!==generation)return;
  controller=new AbortController();
  const signal=controller.signal,input={style:{...props.style},rate:props.rate,font:props.font?.id||null};
  // Start the movie first. Prepare its final still offscreen during playback.
  if(motion)motion=await renderMotion(input,version,signal);
  if(disposed||version!==generation)return;
  try{
    const response=await request(input,signal),count=Number(response.headers.get('X-Danmaku-Preview-Count'));
    const blob=await response.blob();if(disposed||version!==generation)return;
    const url=URL.createObjectURL(blob),check=new Image();
    try{check.src=url;await check.decode();}catch{URL.revokeObjectURL(url);throw new Error('样式预览图片无法显示。');}
    if(disposed||version!==generation){URL.revokeObjectURL(url);return;}
    if(motion&&!motionFinished)pendingOverlay.value=url;
    else{showStill(url);finishMotion();}
    samples.value=count;loading.value=false;emit('ready',true);
  }catch(e){
    if(disposed||version!==generation||signal.aborted)return;
    error.value=e.message;loading.value=false;
    if(!motion||motionFinished)finishMotion();
  }
}
async function renderMotion(input,version,signal){
  try{
    const response=await request({...input,motion:true},signal),blob=await response.blob();
    if(disposed||version!==generation)return false;
    const clip={url:URL.createObjectURL(blob),version};clips.value.push(clip);
    await nextTick();if(disposed||version!==generation)return false;
    const player=players.get(clip.url);
    player.muted=true;await player.play();
    if(disposed||version!==generation)return false;
    const present=()=>{
      if(disposed||version!==generation||!clips.value.some(item=>item.url===clip.url))return;
      retainClip(clip.url);motionLoading.value=false;
    };
    // The replacement stays hidden until it has a decoded frame to display.
    if(player.requestVideoFrameCallback)player.requestVideoFrameCallback(present);else present();
    return true;
  }catch(e){
    if(disposed||version!==generation||signal.aborted)return false;
    retainClip(visibleClip.value);motionLoading.value=false;motionFinished=true;
    motionError.value='滚动预览暂时无法播放，已保留静态预览。';return false;
  }
}
function ended(clip){
  if(clip.version!==generation)return;
  motionFinished=true;
  // A slow still request must not reveal a stale image at the end of the movie.
  if(pendingOverlay.value||error.value)finishMotion();
}
function playbackError(clip){
  if(clip.version!==generation)return;
  motionFinished=true;finishMotion();motionError.value='滚动预览暂时无法播放，已保留静态预览。';
}
watch(()=>[props.style?.size,props.style?.opacity,props.style?.speed,props.style?.fps,props.rate,props.font?.id],(value,previous=[])=>{
  schedule(!!previous.length&&(value[2]!==previous[2]||value[3]!==previous[3]));
},{immediate:true});
onBeforeUnmount(()=>{disposed=true;generation++;clearTimeout(timer);controller?.abort();discardPending();finishMotion();if(overlay.value)URL.revokeObjectURL(overlay.value);});
</script>
<template><figure class="style-preview"><div class="style-preview-image" :data-sample-count="samples" :data-font-size="geometry.size" :data-opacity="geometry.opacity" :data-ready="!loading&&!error&&!!(overlay||pendingOverlay)" :data-motion="motionLoading?'loading':visibleClip?'playing':'idle'"><img :src="overlay||image" alt="当前弹幕样式预览" width="1672" height="940"/><video v-for="clip in clips" :key="clip.url" :ref="node=>node?players.set(clip.url,node):players.delete(clip.url)" class="style-preview-motion" :class="{'is-visible':visibleClip===clip.url}" :src="clip.url" muted playsinline disablepictureinpicture aria-label="弹幕滚动预览，播放一轮后恢复静态" @ended="ended(clip)" @error="playbackError(clip)"/><span v-if="motionLoading||(!visibleClip&&loading)" class="preview-status" role="status">{{ motionLoading?'正在准备滚动预览…':'正在更新预览…' }}</span></div><figcaption><span>{{ visibleClip&&!motionLoading?'滚动预览 · '+props.style.speed.toFixed(1)+' 倍 · '+props.style.fps+' 帧':'导出样式预览' }}</span><span>{{ samples }} 条示例弹幕</span></figcaption><p class="motion-hint">调整速度或帧率后滚动一轮，随后恢复静态预览。</p><p v-if="error" class="inline-warning" role="alert">{{ error }} <button class="text-button" @click="schedule()">重新预览</button></p><p v-if="motionError" class="inline-warning" role="status">{{ motionError }}</p></figure></template>
<style scoped>
.style-preview{margin:0 0 18px}.style-preview-image{position:relative;width:min(100%,calc(42dvh * 1672 / 940));margin-inline:auto;overflow:hidden;border-radius:10px;background:#352c29;border:1px solid var(--line)}img{display:block;width:100%;height:auto}.style-preview-motion{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;visibility:hidden}.style-preview-motion.is-visible{visibility:visible}.preview-status{position:absolute;right:12px;bottom:12px;border-radius:6px;background:#302526cc;color:white;padding:6px 10px;font-size:12px}figcaption{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--muted);margin-top:8px}.style-preview .motion-hint{font-size:12px;color:var(--muted);margin:8px 0 0}
</style>
