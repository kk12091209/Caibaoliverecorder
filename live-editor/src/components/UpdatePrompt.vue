<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Download, LoaderCircle, X } from 'lucide-vue-next';
import { api } from '../api.js';
import { isDesktop } from '../desktop.js';

const props=defineProps({state:Object,blocked:Boolean});
const emit=defineEmits(['changed','started','manage']);
const dismissed=ref([]),ignore=ref(false),busy=ref(false),error=ref(''),dialog=ref(null);
const update=computed(()=>props.state||{}),candidate=computed(()=>update.value.candidate);
const visible=computed(()=>!props.blocked&&!!candidate.value?.key&&update.value.enabled!==false&&!update.value.deferred&&!update.value.ignored&&!update.value.autoInstall&&['available','ready'].includes(update.value.status)&&!dismissed.value.includes(candidate.value.key));
let previousFocus;
watch(()=>candidate.value?.key,()=>{ignore.value=false;error.value='';});
watch(visible,async open=>{
  if(open){previousFocus=document.activeElement;await nextTick();if(visible.value)dialog.value?.querySelector('.update-now')?.focus();}
  else if(previousFocus?.isConnected){previousFocus.focus();previousFocus=null;}
},{immediate:true});
function remember(key){if(!dismissed.value.includes(key))dismissed.value.push(key);}
async function close(){
  if(busy.value)return;
  const key=candidate.value?.key;if(!key)return;
  if(!ignore.value){remember(key);return;}
  busy.value=true;error.value='';
  try{emit('changed',await api('updates/ignore',{key}));remember(key);}
  catch(e){error.value=e.message;}
  finally{busy.value=false;}
}
async function install(){
  if(busy.value||!candidate.value)return;
  const key=candidate.value.key;busy.value=true;error.value='';
  try{
    const value=await api(update.value.status==='ready'&&isDesktop?'updates/apply':'updates/download',update.value.status==='ready'&&isDesktop?{key}:{key,autoInstall:isDesktop});
    remember(key);emit('changed',value);emit('started',isDesktop?'正在准备更新，下载并校验后将在空闲时安装并重新打开。':'已开始下载更新，可在软件更新中查看进度。');
    if(!isDesktop)emit('manage');
  }catch(e){error.value=e.message;}
  finally{busy.value=false;}
}
function onKey(event){
  if(event.key==='Escape'){event.preventDefault();void close();return;}
  if(event.key!=='Tab')return;
  const nodes=[...dialog.value.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
  if(!nodes.length){event.preventDefault();return;}
  const first=nodes[0],last=nodes.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}
onBeforeUnmount(()=>{if(previousFocus?.isConnected)previousFocus.focus();});
</script>

<template>
  <div v-if="visible" class="modal-backdrop update-prompt-backdrop" @keydown.stop="onKey">
    <section ref="dialog" class="modal update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-prompt-title" aria-describedby="update-prompt-description" tabindex="-1">
      <button class="icon-button update-prompt-close" type="button" aria-label="关闭更新提醒" :disabled="busy" @click="close"><X :size="17"/></button>
      <span class="update-eyebrow">软件更新</span>
      <h2 id="update-prompt-title">发现新版本 {{ candidate.version }}</h2>
      <p id="update-prompt-description">当前版本 {{ update.current?.version }} · 新版本 {{ candidate.version }}</p>
      <div class="update-notes"><strong>更新内容</strong><ul v-if="candidate.notes?.length"><li v-for="(note,index) in candidate.notes" :key="index">{{ note }}</li></ul><p v-else>优化使用体验与稳定性。</p></div>
      <p class="muted">{{ isDesktop?'更新包下载并通过校验后，软件会在空闲时更新并重新打开，录像和设置会保留。':'可在此下载更新包，请在桌面软件中完成安装。' }}</p>
      <p v-if="update.installBlocked" class="muted">{{ update.installBlocked }}</p>
      <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
      <label class="checkbox update-ignore"><input v-model="ignore" type="checkbox" :disabled="busy"/>下次版本更新再提示</label>
      <div class="update-prompt-actions"><button class="button" type="button" :disabled="busy" @click="close">关闭</button><button class="button primary update-now" type="button" :disabled="busy" @click="install"><LoaderCircle v-if="busy" :size="16" class="spin"/><Download v-else :size="16"/>立即更新</button></div>
    </section>
  </div>
</template>

<style scoped>
.update-prompt-backdrop{z-index:16;}
.update-prompt{padding-top:30px;}
.update-prompt-close{position:absolute;right:16px;top:16px;width:28px;height:28px;border:1px solid var(--line);border-radius:50%;background:rgba(255,255,255,.5);}
.update-eyebrow{display:block;color:var(--muted);font-size:12px;margin-bottom:10px;}
.update-prompt h2{padding-right:30px;line-height:1.4;overflow-wrap:anywhere;}
.update-notes{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0;margin:18px 0;max-height:36dvh;overflow-y:auto;font-size:13px;overflow-wrap:anywhere;}
.update-notes ul{padding-left:18px;margin:10px 0 0;line-height:1.8;}
.update-ignore{display:flex;width:fit-content;gap:8px;margin:20px 0 16px;font-size:13px;}
.update-prompt-actions{display:flex;justify-content:flex-end;gap:10px;}
.update-prompt-actions .button{min-width:92px;}
</style>
