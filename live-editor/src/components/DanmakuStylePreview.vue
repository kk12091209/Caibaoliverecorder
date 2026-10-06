<script setup>
import {ref,computed,watch,onBeforeUnmount} from 'vue';
import image from '../assets/danmaku-style-preview.png';
import {danmakuGeometry} from '../../shared/danmaku-style.js';
const props=defineProps({style:Object,font:Object,rate:{type:Number,default:50}}),emit=defineEmits(['ready']);
const overlay=ref(''),loading=ref(true),error=ref(''),samples=ref(0),geometry=computed(()=>danmakuGeometry(940,props.style));
let timer,controller,generation=0,disposed=false;
function schedule(){
  const version=++generation;clearTimeout(timer);controller?.abort();loading.value=true;error.value='';emit('ready',false);
  timer=setTimeout(()=>render(version),250);
}
async function render(version,attempt=0){
  if(disposed||version!==generation)return;
  controller=new AbortController();
  try{
    const response=await fetch('/api/danmaku-style/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({style:props.style,rate:props.rate,font:props.font?.id||null}),signal:controller.signal});
    if(response.status===409&&attempt<4){timer=setTimeout(()=>render(version,attempt+1),250);return;}
    if(!response.ok)throw new Error((await response.json()).error||'样式预览生成失败。');
    const count=Number(response.headers.get('X-Danmaku-Preview-Count'));
    const blob=await response.blob();if(disposed||version!==generation)return;
    const url=URL.createObjectURL(blob),check=new Image();
    try{check.src=url;await check.decode();}catch{URL.revokeObjectURL(url);throw new Error('样式预览图片无法显示。');}
    if(disposed||version!==generation){URL.revokeObjectURL(url);return;}
    if(overlay.value)URL.revokeObjectURL(overlay.value);overlay.value=url;samples.value=count;loading.value=false;emit('ready',true);
  }catch(e){if(disposed||version!==generation||e.name==='AbortError')return;error.value=e.message;loading.value=false;}
}
watch(()=>[props.style?.size,props.style?.opacity,props.rate,props.font?.id],schedule,{immediate:true});
onBeforeUnmount(()=>{disposed=true;generation++;clearTimeout(timer);controller?.abort();if(overlay.value)URL.revokeObjectURL(overlay.value);});
</script>
<template><figure class="style-preview"><div class="style-preview-image" :data-sample-count="samples" :data-font-size="geometry.size" :data-opacity="geometry.opacity" :data-ready="!loading&&!error&&!!overlay"><img :src="overlay&&!loading&&!error?overlay:image" alt="当前弹幕样式预览" width="1672" height="940"/><span v-if="loading" class="preview-status" role="status">正在更新预览…</span></div><figcaption><span>导出样式预览</span><span>{{ samples }} 条示例弹幕</span></figcaption><p v-if="error" class="inline-warning" role="alert">{{ error }} <button class="text-button" @click="schedule">重新预览</button></p></figure></template>
<style scoped>
.style-preview{margin:0 0 18px}.style-preview-image{position:relative;width:min(100%,calc(42dvh * 1672 / 940));margin-inline:auto;overflow:hidden;border-radius:10px;background:#352c29;border:1px solid var(--line)}img{display:block;width:100%;height:auto}.preview-status{position:absolute;right:12px;bottom:12px;border-radius:6px;background:#302526cc;color:white;padding:6px 10px;font-size:12px}figcaption{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--muted);margin-top:8px}
</style>
