<script setup>
import {ref,computed,watch} from 'vue';
import {api} from '../api.js';
import FontSettings from './FontSettings.vue';
import DanmakuStylePreview from './DanmakuStylePreview.vue';
import {DANMAKU_SIZE_STEPS,normalizedDanmakuStyle} from '../../shared/danmaku-style.js';
const props=defineProps({style:Object,font:Object,rate:{type:Number,default:50}}),emit=defineEmits(['changed','busy','close']);
const initial=normalizedDanmakuStyle(props.style),sizeIndex=ref(DANMAKU_SIZE_STEPS.indexOf(initial.size)),opacity=ref(initial.opacity),rate=ref(props.rate);
const font=ref(props.font),error=ref(''),saving=ref(false),saved=ref(false),fontBusy=ref(false),previewReady=ref(false);
const draft=computed(()=>({size:DANMAKU_SIZE_STEPS[sizeIndex.value],opacity:opacity.value}));
watch(()=>[sizeIndex.value,opacity.value,rate.value,font.value?.id],()=>saved.value=false);
watch(()=>saving.value||fontBusy.value,value=>emit('busy',value));
async function persist(){
  if(saving.value||fontBusy.value||!previewReady.value)return;
  saving.value=true;error.value='';
  try{const result=await api('settings',{danmakuStyle:{...draft.value},danmakuPerSecond:rate.value,danmakuFont:font.value?.id||null});emit('changed',result);saved.value=true;}
  catch(e){error.value=e.message;saved.value=false;}
  finally{saving.value=false;}
}
</script>
<template><div class="danmaku-style-editor">
  <DanmakuStylePreview :style="draft" :font="font" :rate="rate" @ready="previewReady=$event"/>
  <div class="style-sliders">
    <label class="style-control" for="style-rate"><span>每秒弹幕上限<output for="style-rate">{{ rate }} 条</output></span><input id="style-rate" v-model.number="rate" type="range" min="1" max="50" step="1" :disabled="saving||fontBusy"/><small>1 条<span>50 条</span></small></label>
    <label class="style-control" for="style-size"><span>弹幕字号<output for="style-size">{{ draft.size }}<small v-if="draft.size===0.6">默认</small></output></span><input id="style-size" v-model.number="sizeIndex" type="range" min="0" :max="DANMAKU_SIZE_STEPS.length-1" step="1" :aria-valuetext="String(draft.size)" :disabled="saving||fontBusy"/><small>0.4<span>5</span></small></label>
    <label class="style-control" for="style-opacity"><span>弹幕不透明度<output for="style-opacity">{{ opacity }}%</output></span><input id="style-opacity" v-model.number="opacity" type="range" min="0" max="100" step="1" :disabled="saving||fontBusy"/><small>完全透明<span>完全显示</span></small></label>
  </div>
  <p class="style-hint">弹幕在画面上下区域轮换显示，轨道数量随画面高度和字号计算。预览与导出使用同一套排布和字体渲染；轨道已满时减少显示，保留原始弹幕。100% 为完全显示。</p>
  <FontSettings :font="font" draft :disabled="saving" @changed="font=$event" @busy="fontBusy=$event"/>
  <p class="style-hint">点击「保存样式」后，字体、密度、字号与不透明度一起应用于预览和新建导出。0.6 保持原有导出字号。</p>
  <p class="style-save-state" role="status">{{ saving?'正在保存…':saved?'样式已保存':'预览调整尚未保存' }}</p>
  <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
<div class="style-actions"><button class="button" :disabled="saving||fontBusy" @click="emit('close')">返回设置</button><button class="button primary" :disabled="saving||fontBusy||!previewReady" @click="persist">{{ saving?'正在保存…':'保存样式' }}</button></div>
</div></template>
<style scoped>
.style-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}.style-sliders{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.style-control{display:block;min-width:0}.style-control>span{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;gap:8px;margin-bottom:10px}.style-control output{color:var(--rose-dark);white-space:nowrap}.style-control output small{font-weight:400;font-size:10px;margin-left:5px}.style-control>small{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;font-weight:400;margin-top:7px}.style-control input{width:100%;display:block;margin:0;accent-color:var(--rose);cursor:pointer;height:20px}.style-control input:focus-visible{outline:2px solid var(--rose);outline-offset:4px;border-radius:4px}.danmaku-style-editor .style-hint{font-size:12px;margin:14px 0 8px}.style-save-state{font-size:12px;color:var(--rose-dark)!important}
@media(max-width:650px){.style-sliders{grid-template-columns:1fr;gap:20px}}
</style>
