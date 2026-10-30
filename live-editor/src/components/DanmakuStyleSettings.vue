<script setup>
import {ref,computed,watch,nextTick} from 'vue';
import {api} from '../api.js';
import FontSettings from './FontSettings.vue';
import DanmakuStylePreview from './DanmakuStylePreview.vue';
import {DANMAKU_SIZE_STEPS,normalizedDanmakuStyle} from '../../shared/danmaku-style.js';
import {normalizedHighlightStyle} from '../../shared/highlight-style.js';
import {DANMAKU_SAMPLES} from '../../shared/danmaku-samples.js';
const props=defineProps({style:Object,highlightStyle:Object,font:Object,rate:{type:Number,default:50}}),emit=defineEmits(['changed','busy','close']);
const initial=normalizedDanmakuStyle(props.style),sizeIndex=ref(DANMAKU_SIZE_STEPS.indexOf(initial.size)),opacity=ref(initial.opacity),rate=ref(props.rate);
const speed=ref(initial.speed),fps=ref(initial.fps),confirmFps=ref(false),cancelFps=ref(null),fps30=ref(null),fps60=ref(null);
const areaTop=ref(initial.areaTop),areaHeight=ref(initial.areaHeight);
const highlightInitial=normalizedHighlightStyle(props.highlightStyle),highlightScale=ref(highlightInitial.scale),highlightSender=ref(highlightInitial.showSender),highlightColor=ref(highlightInitial.color);
const previewHighlighted=ref(['00','02']);
const highlightDraft=computed(()=>({scale:highlightScale.value,showSender:highlightSender.value,color:highlightColor.value}));
function togglePreviewHighlight(id){previewHighlighted.value=previewHighlighted.value.includes(id)?previewHighlighted.value.filter(x=>x!==id):[...previewHighlighted.value,id];}
const font=ref(props.font),error=ref(''),saving=ref(false),saved=ref(false),fontBusy=ref(false);
const draft=computed(()=>({size:DANMAKU_SIZE_STEPS[sizeIndex.value],opacity:opacity.value,speed:speed.value,fps:fps.value,areaTop:areaTop.value,areaHeight:areaHeight.value}));
function changeArea(area){areaTop.value=area.areaTop;areaHeight.value=area.areaHeight;}
watch(()=>[sizeIndex.value,opacity.value,speed.value,fps.value,areaTop.value,areaHeight.value,rate.value,font.value?.id],()=>saved.value=false);
watch(()=>JSON.stringify(highlightDraft.value),()=>saved.value=false);
watch(()=>saving.value||fontBusy.value,value=>emit('busy',value));
async function selectFps(event){
  const value=Number(event.target.value);
  if(value===60&&fps.value===30){fps30.value.checked=true;confirmFps.value=true;await nextTick();cancelFps.value?.focus();}
  else{fps.value=value;confirmFps.value=false;}
}
async function finishFps(confirmed){fps.value=confirmed?60:30;confirmFps.value=false;await nextTick();(confirmed?fps60:fps30).value?.focus();}
async function persist(){
  if(saving.value||fontBusy.value||confirmFps.value)return;
  saving.value=true;error.value='';
  try{const result=await api('settings',{danmakuStyle:{...draft.value},highlightStyle:{...highlightDraft.value},danmakuPerSecond:rate.value,danmakuFont:font.value?.id||null});emit('changed',result);saved.value=true;}
  catch(e){error.value=e.message;saved.value=false;}
  finally{saving.value=false;}
}
</script>
<template><div class="danmaku-style-editor">
  <DanmakuStylePreview :style="draft" :highlight-style="highlightDraft" :highlighted="previewHighlighted" :font="font" :rate="rate" :disabled="saving||fontBusy" @area-change="changeArea"/>
  <div class="style-sliders">
    <label class="style-control" for="style-rate"><span>每秒弹幕上限<output for="style-rate">{{ rate }} 条</output></span><input id="style-rate" v-model.number="rate" type="range" min="1" max="50" step="1" :style="{'--style-fill':((rate-1)/49*100)+'%'}" :disabled="saving||fontBusy"/><small>1 条<span>50 条</span></small></label>
    <label class="style-control" for="style-size"><span>弹幕字号<output for="style-size">{{ draft.size }}<small v-if="draft.size===0.6">默认</small></output></span><input id="style-size" v-model.number="sizeIndex" type="range" min="0" :max="DANMAKU_SIZE_STEPS.length-1" step="1" :style="{'--style-fill':(sizeIndex/(DANMAKU_SIZE_STEPS.length-1)*100)+'%'}" :aria-valuetext="String(draft.size)" :disabled="saving||fontBusy"/><small>0.4<span>5</span></small></label>
    <label class="style-control" for="style-opacity"><span>弹幕不透明度<output for="style-opacity">{{ opacity }}%</output></span><input id="style-opacity" v-model.number="opacity" type="range" min="0" max="100" step="1" :style="{'--style-fill':opacity+'%'}" :disabled="saving||fontBusy"/><small>完全透明<span>完全显示</span></small></label>
  </div>
  <div class="style-motion-row">
    <label class="style-control" for="style-speed"><span>弹幕速度<output for="style-speed">{{ speed.toFixed(1) }} 倍<small v-if="speed===1">默认</small></output></span><input id="style-speed" v-model.number="speed" type="range" min="0.5" max="2" step="0.1" :style="{'--style-fill':((speed-0.5)/1.5*100)+'%'}" :aria-valuetext="speed.toFixed(1)+' 倍'" :disabled="saving||fontBusy"/><small>0.5 倍 · 较慢<span>2.0 倍 · 较快</span></small></label>
    <fieldset class="style-frame-rate" :disabled="saving||fontBusy||confirmFps"><legend>弹幕帧率</legend><div><label><input ref="fps30" type="radio" name="danmaku-fps" value="30" :checked="fps===30" @change="selectFps"/>30 帧</label><label><input ref="fps60" type="radio" name="danmaku-fps" value="60" :checked="fps===60" @change="selectFps"/>60 帧（默认）</label></div><small>30 帧处理通常更快；60 帧滚动更流畅。帧率不改变滚动速度。</small></fieldset>
  </div>
  <div v-if="confirmFps" class="fps-confirm" role="alertdialog" aria-labelledby="fps-confirm-title" aria-describedby="fps-confirm-description" @keydown.esc.stop.prevent="finishFps(false)"><strong id="fps-confirm-title">切换为 60 帧？</strong><p id="fps-confirm-description">该操作可能会导致处理速度变慢，是否继续？</p><div><button ref="cancelFps" class="button" @click="finishFps(false)">取消，保留 30 帧</button><button class="button primary" @click="finishFps(true)">继续，使用 60 帧</button></div></div>
  <p class="style-hint">弹幕在选定区域内重新排布，优先避让已有弹幕。缩小区域不减少条数、不缩小字号；区域越小，弹幕越集中，极高密度时仍可能重叠。预览与导出使用同一套排布和字体渲染。</p>
  <fieldset class="highlight-settings" :disabled="saving||fontBusy"><legend>突出弹幕样式</legend><p class="style-hint">在弹幕列表右键选择「突出显示此条弹幕」后应用。这里的示例选择只用于预览。</p><div class="highlight-controls"><label class="style-control" for="highlight-scale"><span>字号倍率<output>{{ highlightScale.toFixed(1) }} 倍</output></span><input id="highlight-scale" v-model.number="highlightScale" type="range" min="1" max="3" step="0.1" :style="{'--style-fill':((highlightScale-1)/2*100)+'%'}"/><small>1 倍 · 跟随普通字号<span>3 倍</span></small></label><div class="highlight-color"><label>高亮弹幕颜色<input type="color" aria-label="选择高亮弹幕颜色" :value="highlightColor||'#FFD166'" @input="highlightColor=$event.target.value"/></label><span>{{ highlightColor||'保留原色' }}</span><button type="button" class="text-button" @click="highlightColor=null">恢复原色</button></div></div><label class="checkbox"><input v-model="highlightSender" type="checkbox"/>显示发送者昵称（昵称：弹幕内容，默认关闭）</label><div class="highlight-samples" aria-label="选择预览中突出的示例弹幕"><button v-for="(text,index) in DANMAKU_SAMPLES.slice(0,Math.min(rate,8))" :key="index" type="button" :class="{selected:previewHighlighted.includes(String(index).padStart(2,'0'))}" :aria-pressed="previewHighlighted.includes(String(index).padStart(2,'0'))" @click="togglePreviewHighlight(String(index).padStart(2,'0'))"><span aria-hidden="true">{{ previewHighlighted.includes(String(index).padStart(2,'0'))?'✦':'○' }}</span> {{ text }}</button></div></fieldset>
  <FontSettings :font="font" draft :disabled="saving" @changed="font=$event" @busy="fontBusy=$event"/>
  <p class="style-hint">点击「保存样式」后，展示区域、字体、密度、字号、不透明度、速度、帧率与突出样式一起应用于预览和新建导出。已创建的导出任务保留原设置。0.6 保持原有字号，1.0 倍保持原有滚动速度。</p>
  <p class="style-save-state" role="status">{{ saving?'正在保存…':saved?'样式已保存':'预览调整尚未保存' }}</p>
  <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
<div class="style-actions"><button class="button" :disabled="saving||fontBusy" @click="emit('close')">返回设置</button><button class="button primary" :disabled="saving||fontBusy||confirmFps" @click="persist">{{ saving?'正在保存…':'保存样式' }}</button></div>
</div></template>
<style scoped>
.style-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}.style-sliders{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.style-control{display:block;min-width:0}.style-control>span{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;gap:8px;margin-bottom:10px}.style-control output{color:var(--rose-dark);white-space:nowrap}.style-control output small{font-weight:400;font-size:10px;margin-left:5px}.style-control>small{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;font-weight:400;margin-top:7px}.style-control input{width:100%;display:block;margin:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;appearance:none;-webkit-appearance:none;cursor:pointer;height:24px}.style-control input:focus{border:0;box-shadow:none}.style-control input:focus-visible{outline:2px solid var(--rose);outline-offset:4px;border-radius:4px}
.style-control input::-webkit-slider-runnable-track{height:8px;border:0;border-radius:99px;background:linear-gradient(to right,var(--rose) var(--style-fill),var(--line-strong) var(--style-fill))}.style-control input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:18px;height:18px;margin-top:-5px;border:1px solid var(--line-strong);border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002}.style-control input::-moz-range-track{height:8px;border:0;border-radius:99px;background:linear-gradient(to right,var(--rose) var(--style-fill),var(--line-strong) var(--style-fill))}.style-control input::-moz-range-thumb{width:18px;height:18px;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002}.style-control input:disabled{opacity:.55;cursor:default}.danmaku-style-editor .style-hint{font-size:12px;margin:14px 0 8px}.style-save-state{font-size:12px;color:var(--rose-dark)!important}
.style-motion-row{display:grid;grid-template-columns:1fr 2fr;gap:18px;margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}.style-frame-rate{border:0;padding:0;margin:0;min-width:0}.style-frame-rate legend{font-size:13px;font-weight:600;margin-bottom:10px}.style-frame-rate>div{display:flex;gap:22px}.style-frame-rate label{display:flex;align-items:center;gap:7px;font-size:13px}.style-frame-rate input{width:auto;margin:0;accent-color:var(--rose)}.style-frame-rate small{display:block;font-size:11px;color:var(--muted);margin-top:9px;line-height:1.5}.fps-confirm{margin-top:16px;padding:14px;border:1px solid var(--line-strong);border-radius:10px;background:var(--rose-light,#fff3f5);font-size:13px}.fps-confirm>div{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.highlight-settings{border:1px solid var(--line);border-radius:10px;padding:14px;margin:18px 0}.highlight-settings legend{font-size:13px;font-weight:600}.highlight-controls{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:14px 0}.highlight-color{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}.highlight-color label{display:flex;align-items:center;gap:8px}.highlight-color input{width:44px;height:32px;padding:3px;cursor:pointer}.highlight-color span{color:var(--muted)}.highlight-samples{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.highlight-samples button{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:6px;padding:6px 8px;font-size:11px;text-align:left}.highlight-samples button.selected{border-color:var(--rose);background:#ff7d9218}.highlight-settings .checkbox{font-size:12px}
@media(max-width:650px){.highlight-controls{grid-template-columns:1fr}.highlight-samples button{max-width:100%}.style-sliders,.style-motion-row{grid-template-columns:1fr;gap:20px}}
</style>
