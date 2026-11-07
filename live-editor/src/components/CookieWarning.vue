<script setup>
import {computed,onMounted,onBeforeUnmount,ref} from 'vue';
import {ui} from '../../shared/ui-copy.js';
import {platformLabel} from '../../shared/platforms.js';

const props=defineProps({platform:String,busy:Boolean,error:String});
const emit=defineEmits(['acknowledge']);
const dialog=ref(null),acknowledge=ref(null);
const title=computed(()=>ui.credentials.失效提醒标题(platformLabel(props.platform)));
const previousFocus=document.activeElement;
onMounted(()=>acknowledge.value?.focus());
onBeforeUnmount(()=>{if(previousFocus?.isConnected)previousFocus.focus();});

function onKey(event){
  if(event.key==='Escape'){
    event.preventDefault();
    if(!props.busy)emit('acknowledge',false);
    return;
  }
  if(event.key!=='Tab')return;
  const buttons=[...dialog.value.querySelectorAll('button:not(:disabled)')];
  if(!buttons.length){event.preventDefault();return;}
  const first=buttons[0],last=buttons.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}
</script>

<template>
  <div class="modal-backdrop cookie-warning-backdrop" @keydown.stop="onKey">
    <section ref="dialog" class="modal cookie-warning" role="alertdialog" aria-modal="true" aria-labelledby="cookie-warning-title" aria-describedby="cookie-warning-description" :aria-busy="busy" tabindex="-1">
      <h2 id="cookie-warning-title">{{ title }}</h2>
      <p id="cookie-warning-description">{{ ui.credentials.继续录制 }}{{ ui.credentials.失效说明 }}</p>
      <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
      <div class="confirm-actions">
        <button type="button" class="button" :disabled="busy" @click="emit('acknowledge',true)">{{ ui.credentials.前往Cookie设置 }}</button>
        <button ref="acknowledge" type="button" class="button primary" :disabled="busy" @click="emit('acknowledge',false)">{{ ui.credentials.我已知晓 }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cookie-warning-backdrop{z-index:16}.cookie-warning{max-width:460px}.cookie-warning p{line-height:1.65}.cookie-warning .confirm-actions{flex-wrap:wrap}
</style>
