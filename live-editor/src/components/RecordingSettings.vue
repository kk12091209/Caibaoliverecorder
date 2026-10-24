<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const props=defineProps({previewTimestamp:Boolean});
const emit=defineEmits(['changed']);
const busy=ref(false),error=ref(''),draft=ref(null);
async function save(enabled){
  if(busy.value)return;
  busy.value=true;draft.value=enabled;error.value='';
  try{const value=await api('settings',{previewTimestamp:enabled});emit('changed',value.previewTimestamp);}
  catch(e){error.value=e.message;}
  finally{draft.value=null;busy.value=false;}
}
</script>

<template>
  <section class="recording-settings" aria-label="录制设置">
    <strong>录制设置</strong>
    <label class="checkbox"><input type="checkbox" :checked="draft??props.previewTimestamp" :disabled="busy" @change="save($event.target.checked)"/>时间戳<span v-if="busy" class="muted" role="status">保存中…</span></label>
    <p class="muted">默认关闭。开启后，在预览画面左上角显示当前画面对应的录制时间（北京时间）。</p>
    <p class="muted">仅辅助本地观看，不写入原始录像；纯净版和弹幕版导出均不包含时间戳。</p>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.recording-settings{border:1px solid var(--line);border-radius:10px;padding:14px;margin:16px 0;font-size:13px;}
.recording-settings>.checkbox{display:flex;width:fit-content;margin-top:14px;gap:8px;}
.recording-settings p{line-height:1.65;margin:8px 0 0;}
</style>
