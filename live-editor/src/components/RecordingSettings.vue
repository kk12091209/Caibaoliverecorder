<script setup>
import { ui } from '../../shared/ui-copy.js';

import { computed, ref } from 'vue';
import { api } from '../api.js';
import { CAMERA_POSITIONS, normalizedRecordingStyle } from '../../shared/recording-style.js';
import { TIMESTAMP_STYLES, normalizedTimestampStyle, TIMESTAMP_POSITIONS, normalizedTimestampPosition } from '../../shared/timestamp-style.js';
import TimestampText from './TimestampText.vue';
import {normalizedGiftStyle} from '../../shared/gifts.js';
import {giftMetrics,giftRegions} from '../../shared/gift-layout.js';
import GiftStylePreview from './GiftStylePreview.vue';

const props=defineProps({previewTimestamp:Boolean,previewTimestampStyle:String,previewTimestampPosition:String,recordingStyle:Object,giftStyle:Object});
const emit=defineEmits(['changed','busy','close']);
const busy=ref(false),error=ref(''),saved=ref(false),timestamp=ref(props.previewTimestamp);
const draft=ref(normalizedRecordingStyle(props.recordingStyle));
const gifts=ref(normalizedGiftStyle(props.giftStyle)), activeGiftRegion=ref('gift');
const giftCorners=CAMERA_POSITIONS.filter(choice=>choice.value!=='original');
const giftRows=computed(()=>{
  const m=giftMetrics(1920,1080,gifts.value);
  const {gift}=giftRegions(m,gifts.value);
  return Math.floor((gift.end-gift.top+m.gap)/(m.row+m.gap));
});
function setRegionHeight({key,value}) {
  gifts.value[key==='gift'?'giftHeight':'scHeight']=value;
  saved.value=false;
}
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
  try{const value=await api('settings',{previewTimestamp:timestamp.value,previewTimestampStyle:timestampStyle.value,previewTimestampPosition:timestampPosition.value,recordingStyle:draft.value,giftStyle:gifts.value});emit('changed',value);saved.value=true;}
  catch(e){error.value=e.message;}
  finally{busy.value=false;emit('busy',false);}
}
</script>

<template>
  <section class="recording-style-editor" :aria-label="ui.common.录制样式" @input="saved=false" @change="saved=false">
    <GiftStylePreview :style="gifts" :disabled="busy" :active="activeGiftRegion" @select="activeGiftRegion=$event" @height="setRegionHeight">
    <div class="recording-style-demo" :class="{'keep-original':original}" :aria-label="ui.recordingStyle.摄像头位置示意图">
      <div class="demo-game"><span>{{ ui.recordingStyle.主画面 }}</span><div class="demo-grid"/></div>
      <TimestampText v-if="timestamp" class="demo-timestamp" label="2026-10-25 18:30:00" :variant="timestampStyle" :position="timestampPosition" :style="timestampDemoPosition"/>
      <div class="demo-camera" :style="demoStyle"><span>{{ ui.recordingStyle.摄像头 }}</span></div>
    </div>
    </GiftStylePreview>
    <div class="timestamp-options">
      <label class="checkbox timestamp-choice"><input v-model="timestamp" type="checkbox" :disabled="busy"/>{{ ui.recordingStyle.时间戳 }}</label>
      <div v-if="timestamp" class="timestamp-controls">
        <label class="timestamp-style-choice"><span>{{ ui.recordingStyle.时间戳样式 }}</span><select v-model="timestampStyle" :disabled="busy"><option v-for="choice in TIMESTAMP_STYLES" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
        <label class="timestamp-style-choice"><span>{{ ui.recordingStyle.时间戳位置 }}</span><select v-model="timestampPosition" :disabled="busy"><option v-for="choice in TIMESTAMP_POSITIONS" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
      </div>
    </div>
    <p class="muted">{{ ui.recordingStyle.北京时间仅用于预览不随视频导出 }}</p>
    <fieldset class="gift-settings" :disabled="busy"><legend>普通礼物</legend>
      <div class="gift-region-settings" @focusin="activeGiftRegion='gift'">
        <label>位置<select v-model="gifts.giftCorner"><option v-for="choice in giftCorners" :key="choice.value" :value="choice.value">{{choice.label}}</option></select></label>
        <label>区域高度 <output>{{gifts.giftHeight}}% · 可显示 {{giftRows}} 行</output>
          <input v-model.number="gifts.giftHeight" type="range" min="1" max="100"/>
        </label>
      </div>
      <label class="checkbox"><input v-model="gifts.preview" type="checkbox"/>{{ ui.common.展示礼物 }}</label>
      <label class="checkbox"><input v-model="gifts.export" type="checkbox"/>{{ ui.recordingStyle.弹幕版导出默认展示礼物 }}</label>
      <div class="gift-price-fields"><label>{{ ui.recordingStyle.B站最低单次金额元 }}<input v-model.number="gifts.minBilibili" type="number" min="0" max="1000000000" step="0.01" :aria-label="ui.recordingStyle.B站礼物最低金额"/></label><label>{{ ui.recordingStyle.抖音最低单次金额元 }}<input v-model.number="gifts.minDouyin" type="number" min="0" max="1000000000" step="0.01" :aria-label="ui.recordingStyle.抖音礼物最低金额"/></label></div>
      <p class="muted">{{ ui.recordingStyle.礼物金额说明 }}</p>
    </fieldset>
    <fieldset class="gift-settings" :disabled="busy">
      <legend>B 站上舰提示位置</legend>
      <div class="camera-choices">
        <label :class="{selected:gifts.guardPosition==='gifts'}"><input v-model="gifts.guardPosition" type="radio" name="guard-position" value="gifts"/>普通礼物区</label>
        <label :class="{selected:gifts.guardPosition==='top-center'}"><input v-model="gifts.guardPosition" type="radio" name="guard-position" value="top-center"/>画面顶部居中</label>
      </div>
    </fieldset>
    <fieldset class="gift-settings" :disabled="busy">
      <legend>B 站醒目留言</legend>
      <div class="gift-region-settings" @focusin="activeGiftRegion='sc'">
        <label>位置<select v-model="gifts.scCorner"><option v-for="choice in giftCorners" :key="choice.value" :value="choice.value">{{choice.label}}</option></select></label>
        <label>区域高度 <output>{{gifts.scHeight}}%</output>
          <input v-model.number="gifts.scHeight" type="range" min="1" max="100"/>
        </label>
      </div>
      <label class="checkbox"><input v-model="gifts.scPreview" type="checkbox"/>预览展示醒目留言</label>
      <label class="checkbox"><input v-model="gifts.scExport" type="checkbox"/>弹幕版导出默认展示醒目留言</label>
      <label class="gift-sc-min">醒目留言最低金额（元）<input v-model.number="gifts.minSuperChat" type="number" min="0" max="1000000000" step="0.01"/></label>
    </fieldset>
    <label class="camera-size gift-scale"><span>礼物和醒目留言文字大小 <output>{{gifts.textScale}}%</output></span>
      <input v-model.number="gifts.textScale" type="range" min="80" max="135" :disabled="busy"/>
    </label>
    <fieldset class="camera-position" :disabled="busy"><legend>{{ ui.recordingStyle.独立摄像头位置 }}</legend>
      <div class="camera-choices"><label v-for="choice in CAMERA_POSITIONS" :key="choice.value" :class="{selected:draft.cameraPosition===choice.value}"><input v-model="draft.cameraPosition" type="radio" name="camera-position" :value="choice.value"/>{{ choice.label }}</label></div>
    </fieldset>
    <label class="camera-size"><span>{{ ui.recordingStyle.摄像头大小 }} <output>{{ draft.cameraSize }}%</output></span><input v-model.number="draft.cameraSize" type="range" min="10" max="40" step="1" :aria-label="ui.recordingStyle.摄像头大小" :disabled="busy||original"/></label>
    <p class="muted">{{ ui.recordingStyle.摄像头调整范围 }}</p>
    <p class="muted">{{ ui.common.样式生效范围 }}</p>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <p v-if="busy||saved" class="recording-save-state" role="status">{{ busy?ui.common.正在保存:saved?ui.recordingStyle.录制样式已保存:'' }}</p>
    <div class="recording-style-actions"><button class="button" :disabled="busy" @click="emit('close')">{{ ui.common.返回设置 }}</button><button class="button primary" :disabled="busy" @click="save">{{ busy?ui.common.正在保存:ui.common.保存样式 }}</button></div>
  </section>
</template>

<style scoped>
.recording-style-editor{font-size:13px}.recording-style-editor p{line-height:1.65}.recording-style-demo{position:relative;width:100%;aspect-ratio:16/9;background:#161b25;border-radius:var(--radius-card);overflow:hidden}.demo-game{position:absolute;inset:0;background:linear-gradient(145deg,#354b67,#6b9b8a);display:grid;place-items:center;color:#e8f5ed;font-size:22px}.demo-grid{position:absolute;inset:0;background:linear-gradient(90deg,#ffffff0b 1px,transparent 1px),linear-gradient(#ffffff0b 1px,transparent 1px);background-size:12.5% 16.666%}.keep-original .demo-game{inset:15% 30% 15% 0}.demo-camera{position:absolute;aspect-ratio:4/3;border:2px solid #f6d7df;border-radius:var(--radius-control);background:linear-gradient(150deg,#bb7488,#e4b59f);display:grid;place-items:center;color:#fff;font-size:clamp(11px,2vw,16px);box-sizing:border-box}.demo-timestamp{position:absolute;z-index:1;max-width:calc(100% - 16px);font-size:clamp(11px,2vw,14px)}.demo-caption{display:block;text-align:center;color:var(--muted);margin-top:7px}.camera-position{margin:20px 0 16px;padding:0;border:0}.camera-position legend{font-weight:600;margin-bottom:10px}.camera-choices{display:flex;gap:8px;flex-wrap:wrap}.camera-choices label{display:flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:var(--radius-control);padding:9px 10px;cursor:pointer}.camera-choices .selected{border-color:var(--rose);background:var(--rose-light,#fff0f4)}.camera-choices input{width:auto;margin:0;accent-color:var(--rose)}.camera-size{display:block}.camera-size>span{display:flex;justify-content:space-between;font-weight:600}.camera-size input{width:100%;padding:0;margin:10px 0;accent-color:var(--rose);box-shadow:none}.camera-size output,.recording-save-state{color:var(--rose-dark)}.timestamp-options{border-top:1px solid var(--line);padding-top:16px;margin-top:18px}.timestamp-choice{margin:0}.timestamp-controls{display:flex;gap:10px 18px;flex-wrap:wrap;margin-top:10px}.timestamp-style-choice{display:flex;flex:1 1 210px;align-items:center;justify-content:space-between;gap:8px}.timestamp-style-choice select{width:auto;min-width:130px;margin:0;padding:8px 10px}.recording-style-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.gift-region-settings{display:grid;grid-template-columns:minmax(110px,1fr) minmax(125px,2fr);gap:12px}
.gift-region-settings label,.gift-sc-min{display:block}
.gift-region-settings select,.gift-sc-min input{margin-top:5px}
.gift-region-settings output{float:right;color:var(--rose-dark)}
.gift-region-settings input[type=range]{accent-color:var(--rose);padding:0;width:100%}
.gift-scale{margin-top:18px}
</style>
<style scoped>.gift-settings{border:1px solid var(--line);border-radius:var(--radius-card);padding:14px;margin-top:18px}.gift-settings legend{font-weight:600}.gift-settings .checkbox{display:flex;margin:8px 0}.gift-price-fields{display:flex;gap:14px;flex-wrap:wrap}.gift-price-fields label{flex:1 1 180px}.gift-price-fields input{margin-top:6px;width:100%;box-sizing:border-box}</style>
