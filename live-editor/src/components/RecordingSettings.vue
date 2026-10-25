<script setup>
import { computed, ref } from 'vue';
import { api } from '../api.js';
import { CAMERA_POSITIONS, normalizedRecordingStyle } from '../../shared/recording-style.js';
import { TIMESTAMP_STYLES, normalizedTimestampStyle, TIMESTAMP_POSITIONS, normalizedTimestampPosition } from '../../shared/timestamp-style.js';
import TimestampText from './TimestampText.vue';

const props=defineProps({previewTimestamp:Boolean,previewTimestampStyle:String,previewTimestampPosition:String,recordingStyle:Object});
const emit=defineEmits(['changed','busy','close']);
const busy=ref(false),error=ref(''),saved=ref(false),timestamp=ref(props.previewTimestamp);
const draft=ref(normalizedRecordingStyle(props.recordingStyle));
const timestampStyle=ref(normalizedTimestampStyle(props.previewTimestampStyle));
const timestampPosition=ref(normalizedTimestampPosition(props.previewTimestampPosition));
const timestampDemoPosition=computed(()=>({
  left:timestampPosition.value.endsWith('left')?'8px':'auto',right:timestampPosition.value.endsWith('right')?'8px':'auto',
  top:timestampPosition.value.startsWith('top')?'8px':'auto',bottom:timestampPosition.value.startsWith('bottom')?'8px':'auto'}));
const original=computed(()=>draft.value.cameraPosition==='original');
const demoStyle=computed(()=>({width:(original.value?24:draft.value.cameraSize)+'%',
  left:original.value?'74%':draft.value.cameraPosition.endsWith('left')?'2%':'auto',
  right:original.value?'auto':draft.value.cameraPosition.endsWith('right')?'2%':'auto',
  top:original.value?'35%':draft.value.cameraPosition.startsWith('top')?'3.5%':'auto',
  bottom:original.value?'auto':draft.value.cameraPosition.startsWith('bottom')?'3.5%':'auto'}));
async function save(){
  if(busy.value)return;
  busy.value=true;emit('busy',true);error.value='';
  try{const value=await api('settings',{previewTimestamp:timestamp.value,previewTimestampStyle:timestampStyle.value,previewTimestampPosition:timestampPosition.value,recordingStyle:draft.value});emit('changed',value);saved.value=true;}
  catch(e){error.value=e.message;}
  finally{busy.value=false;emit('busy',false);}
}
</script>

<template>
  <section class="recording-style-editor" aria-label="录制样式" @input="saved=false" @change="saved=false">
    <p class="muted">所有直播间共用一套样式，识别到独立摄像头时自动使用。</p>
    <div class="recording-style-demo" :class="{'keep-original':original}" aria-label="摄像头位置示意图">
      <div class="demo-game"><span>主画面</span><div class="demo-grid"/></div>
      <TimestampText v-if="timestamp" class="demo-timestamp" label="2026-10-25 18:30:00" :variant="timestampStyle" :position="timestampPosition" :style="timestampDemoPosition"/>
      <div class="demo-camera" :style="demoStyle"><span>摄像头</span></div>
    </div>
    <small class="demo-caption">位置示意 · 真实摄像头保持原有比例</small>
    <div class="timestamp-options">
      <label class="checkbox timestamp-choice"><input v-model="timestamp" type="checkbox" :disabled="busy"/>时间戳</label>
      <div v-if="timestamp" class="timestamp-controls">
        <label class="timestamp-style-choice"><span>时间戳样式</span><select v-model="timestampStyle" :disabled="busy"><option v-for="choice in TIMESTAMP_STYLES" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
        <label class="timestamp-style-choice"><span>时间戳位置</span><select v-model="timestampPosition" :disabled="busy"><option v-for="choice in TIMESTAMP_POSITIONS" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
      </div>
    </div>
    <p class="muted">显示录制时间（北京时间），默认关闭、位置默认左上角。与摄像头位置独立，选到同一角时按所选位置显示。仅用于本地观看，导出不包含时间戳。</p>
    <fieldset class="camera-position" :disabled="busy"><legend>独立摄像头位置</legend>
      <div class="camera-choices"><label v-for="choice in CAMERA_POSITIONS" :key="choice.value" :class="{selected:draft.cameraPosition===choice.value}"><input v-model="draft.cameraPosition" type="radio" name="camera-position" :value="choice.value"/>{{ choice.label }}</label></div>
    </fieldset>
    <label class="camera-size"><span>摄像头大小 <output>{{ draft.cameraSize }}%</output></span><input v-model.number="draft.cameraSize" type="range" min="10" max="40" step="1" aria-label="摄像头大小" :disabled="busy||original"/></label>
    <p class="muted">预览、纯净版和弹幕版导出使用相同的位置。未识别到独立摄像头时保留原画面；已嵌入主画面的摄像头无法单独移动。</p>
    <p class="muted">原始录像保留。调整摄像头样式后，相关预处理内容需要重新生成；已创建的导出任务继续使用创建时的样式。</p>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <p class="recording-save-state" role="status">{{ busy?'正在保存…':saved?'录制样式已保存':'调整后点击保存样式' }}</p>
    <div class="recording-style-actions"><button class="button" :disabled="busy" @click="emit('close')">返回设置</button><button class="button primary" :disabled="busy" @click="save">{{ busy?'正在保存…':'保存样式' }}</button></div>
  </section>
</template>

<style scoped>
.recording-style-editor{font-size:13px}.recording-style-editor p{line-height:1.65}.recording-style-demo{position:relative;width:100%;aspect-ratio:16/9;background:#161b25;border-radius:12px;overflow:hidden}.demo-game{position:absolute;inset:0;background:linear-gradient(145deg,#354b67,#6b9b8a);display:grid;place-items:center;color:#e8f5ed;font-size:22px}.demo-grid{position:absolute;inset:0;background:linear-gradient(90deg,#ffffff0b 1px,transparent 1px),linear-gradient(#ffffff0b 1px,transparent 1px);background-size:12.5% 16.666%}.keep-original .demo-game{inset:15% 30% 15% 0}.demo-camera{position:absolute;aspect-ratio:4/3;border:2px solid #f6d7df;border-radius:6px;background:linear-gradient(150deg,#bb7488,#e4b59f);display:grid;place-items:center;color:#fff;font-size:clamp(11px,2vw,16px);box-sizing:border-box}.demo-timestamp{position:absolute;z-index:1;max-width:calc(100% - 16px);font-size:clamp(11px,2vw,14px)}.demo-caption{display:block;text-align:center;color:var(--muted);margin-top:7px}.camera-position{margin:20px 0 16px;padding:0;border:0}.camera-position legend{font-weight:600;margin-bottom:10px}.camera-choices{display:flex;gap:8px;flex-wrap:wrap}.camera-choices label{display:flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:8px;padding:9px 10px;cursor:pointer}.camera-choices .selected{border-color:var(--rose);background:var(--rose-light,#fff0f4)}.camera-choices input{width:auto;margin:0;accent-color:var(--rose)}.camera-size{display:block}.camera-size>span{display:flex;justify-content:space-between;font-weight:600}.camera-size input{width:100%;padding:0;margin:10px 0;accent-color:var(--rose);box-shadow:none}.camera-size output,.recording-save-state{color:var(--rose-dark)}.timestamp-options{border-top:1px solid var(--line);padding-top:16px;margin-top:18px}.timestamp-choice{margin:0}.timestamp-controls{display:flex;gap:10px 18px;flex-wrap:wrap;margin-top:10px}.timestamp-style-choice{display:flex;flex:1 1 210px;align-items:center;justify-content:space-between;gap:8px}.timestamp-style-choice select{width:auto;min-width:130px;margin:0;padding:8px 10px}.recording-style-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
</style>
