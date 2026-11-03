<script setup>
import { ui } from '../../shared/ui-copy.js';

import { ref } from 'vue';
import { api } from '../api.js';
const props=defineProps({font:Object,draft:Boolean,disabled:Boolean}),emit=defineEmits(['changed','busy']);
const picker=ref(null),busy=ref(false),error=ref('');
async function importFont(event){
  const file=event.target.files?.[0];event.target.value='';if(!file)return;
  busy.value=true;emit('busy',true);error.value='';
  try{
    if(!/\.(ttf|otf)$/i.test(file.name)||file.size>32*1024*1024)throw new Error(ui.fonts.字体格式或大小无效);
    try{await new FontFace('CaiboImportCheck',await file.arrayBuffer()).load();}catch{throw new Error(ui.fonts.字体不可用于预览);}
    const response=await fetch(props.draft?'/api/danmaku-font/draft':'/api/danmaku-font',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
    const value=await response.json();if(!response.ok)throw new Error(value.error||ui.fonts.字体导入失败);emit('changed',value.font);
  }catch(e){error.value=e.message;}finally{busy.value=false;emit('busy',false);}
}
async function reset(){if(props.draft){error.value='';emit('changed',null);return;}busy.value=true;emit('busy',true);error.value='';try{emit('changed',(await api('danmaku-font',{reset:true})).font);}catch(e){error.value=e.message;}finally{busy.value=false;emit('busy',false);}}
</script>
<template><section class="font-settings" :aria-label="ui.fonts.弹幕字体设置"><h3>{{ ui.fonts.弹幕字体 }}</h3><p>{{ props.font?.family||ui.common.默认字体 }}</p><div class="font-actions"><input ref="picker" type="file" accept=".ttf,.otf" hidden :aria-label="ui.fonts.选择弹幕字体文件" @change="importFont"/><button class="button secondary small" :disabled="busy||disabled" @click="picker.click()">{{ busy?ui.common.正在保存:ui.fonts.导入字体文件 }}</button><button v-if="font" class="button subtle small" :disabled="busy||disabled" @click="reset">{{ ui.fonts.恢复默认 }}</button></div><p class="muted">{{ ui.fonts.支持TTFOTF需包含中文字形 }}{{ draft?ui.fonts.保存样式后应用字体:ui.fonts.字体已应用 }}</p><p v-if="error" class="inline-warning" role="alert">{{ error }}</p></section></template>
<style scoped>.font-settings{margin:16px 0;padding:16px 0;border-bottom:1px solid var(--line)}h3{font-size:15px;margin:0 0 10px}p{font-size:13px;line-height:1.6}.font-actions{display:flex;gap:10px;flex-wrap:wrap}</style>
