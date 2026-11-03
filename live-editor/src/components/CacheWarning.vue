<script setup>
import {ref,onMounted,onBeforeUnmount} from 'vue';
import {ui} from '../../shared/ui-copy.js';
const props=defineProps({usage:String,threshold:Number,busy:Boolean,error:String});
const emit=defineEmits(['acknowledge']);
const dialog=ref(null),acknowledge=ref(null);
const previousFocus=document.activeElement;
onMounted(()=>acknowledge.value?.focus());
onBeforeUnmount(()=>{if(previousFocus?.isConnected)previousFocus.focus();});
function onKey(event){
  if(event.key==='Escape'){event.preventDefault();if(!props.busy)emit('acknowledge',false);return;}
  if(event.key!=='Tab')return;
  const nodes=[...dialog.value.querySelectorAll('button:not(:disabled)')];
  if(!nodes.length){event.preventDefault();return;}
  const first=nodes[0],last=nodes.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}
</script>

<template>
  <div class="modal-backdrop cache-warning-backdrop" @keydown.stop="onKey">
    <section ref="dialog" class="modal cache-warning" role="alertdialog" aria-modal="true" aria-labelledby="cache-warning-title" aria-describedby="cache-warning-description" :aria-busy="busy" tabindex="-1">
      <h2 id="cache-warning-title">{{ ui.cacheWarning.标题 }}</h2>
      <p id="cache-warning-description">{{ ui.cacheWarning.占用提醒(usage,threshold) }}</p>
      <p class="muted">{{ ui.cacheWarning.继续处理说明 }}</p>
      <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
      <div class="confirm-actions">
        <button type="button" class="button" :disabled="busy" @click="emit('acknowledge',true)">{{ ui.cacheWarning.去清理 }}</button>
        <button ref="acknowledge" type="button" class="button primary" :disabled="busy" @click="emit('acknowledge',false)">{{ busy?ui.common.正在保存:ui.cacheWarning.已知晓 }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cache-warning-backdrop{z-index:16}.cache-warning{max-width:460px}.cache-warning p{line-height:1.65}.cache-warning .confirm-actions{flex-wrap:wrap}
</style>
