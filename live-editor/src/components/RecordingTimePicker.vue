<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { ui } from '../../shared/ui-copy.js';
import { createBackdropClickGuard } from '../backdrop-click.js';

const props=defineProps({inputId:String,value:String,initial:String,min:String,max:String,label:String,disabled:Boolean,resolve:{type:Function,required:true}});
const emit=defineEmits(['apply','clear']);
const id=useId(),trigger=ref(null),panel=ref(null),open=ref(false),placement=ref({});
const date=ref(''),hour=ref('00'),minute=ref('00'),second=ref('00');
const guard=createBackdropClickGuard();
const pad=value=>String(value).padStart(2,'0');
const hours=Array.from({length:24},(_,i)=>pad(i));
const minutes=Array.from({length:60},(_,i)=>pad(i));
const dates=computed(()=>{
  const first=Date.parse(props.min?.slice(0,10)+'T00:00:00Z');
  const last=Date.parse(props.max?.slice(0,10)+'T00:00:00Z');
  const days=[];
  for(let day=first;day<=last;day+=86400000)days.push(new Date(day).toISOString().slice(0,10));
  return days;
});
const selectedTime=computed(()=>`${date.value}T${hour.value}:${minute.value}:${second.value}`);
const error=computed(()=>{
  if(!open.value)return '';
  try{props.resolve(selectedTime.value);return '';}catch(error){return error.message;}
});
function positionPanel(){
  if(!open.value||!trigger.value||!panel.value)return;
  const rect=trigger.value.getBoundingClientRect(),width=panel.value.offsetWidth,height=panel.value.offsetHeight;
  placement.value={left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12))+'px',
    top:Math.max(12,Math.min(rect.bottom+8,window.innerHeight-height-12))+'px'};
}
async function show(){
  if(props.disabled)return;
  const initial=props.value||props.initial;
  [date.value]=initial.split('T');
  [hour.value,minute.value,second.value]=initial.slice(11,19).split(':');
  guard.reset();open.value=true;
  await nextTick();positionPanel();panel.value?.querySelector('select')?.focus();
  window.addEventListener('resize',positionPanel);
}
function close(){
  open.value=false;guard.reset();window.removeEventListener('resize',positionPanel);
  void nextTick(()=>trigger.value?.focus({preventScroll:true}));
}
function submit(){
  if(error.value)return;
  emit('apply',props.resolve(selectedTime.value));close();
}
function clear(){emit('clear');close();}
function keydown(event){
  if(event.key==='Escape'){event.preventDefault();close();}
  if(event.key!=='Tab')return;
  const controls=[...panel.value.querySelectorAll('select,button:not(:disabled)')];
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&event.target===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&event.target===last){event.preventDefault();first.focus();}
}
watch(()=>props.disabled,disabled=>{if(disabled&&open.value)close();});
onBeforeUnmount(()=>window.removeEventListener('resize',positionPanel));
</script>

<template>
  <button ref="trigger" :id="inputId" type="button" class="recording-time-trigger" :class="{empty:!props.value}" :disabled="disabled" :aria-label="label" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="open?id:undefined" @click="show" @keydown.stop>
    {{ props.value?props.value.replace('T',' '):ui.clipMarkers.选择录制时间 }}
  </button>
  <Teleport to="body">
    <div v-if="open" class="recording-time-backdrop" @pointerdown="guard.pointerDown" @pointermove="guard.pointerMove" @pointerup="guard.pointerUp" @pointercancel="guard.reset" @click="guard.click($event)&&close()" @keydown.stop="keydown">
      <form :id="id" ref="panel" class="recording-time-picker" :style="placement" role="dialog" aria-modal="true" :aria-label="label" @submit.prevent="submit">
        <div class="recording-picker-heading"><strong>{{ label }}</strong><small>{{ ui.clipMarkers.北京时间 }}</small></div>
        <label class="recording-picker-date">{{ ui.clipMarkers.日期 }}<select v-model="date"><option v-for="day in dates" :key="day" :value="day">{{ day }}</option></select></label>
        <div class="recording-picker-clock">
          <label>{{ ui.clipMarkers.时 }}<select v-model="hour"><option v-for="n in hours" :key="n">{{ n }}</option></select></label>
          <label>{{ ui.clipMarkers.分 }}<select v-model="minute"><option v-for="n in minutes" :key="n">{{ n }}</option></select></label>
          <label>{{ ui.clipMarkers.秒 }}<select v-model="second"><option v-for="n in minutes" :key="n">{{ n }}</option></select></label>
        </div>
        <p class="recording-picker-bounds">{{ ui.clipMarkers.可选范围 }}<br/>{{ min?.replace('T',' ') }} — {{ max?.replace('T',' ') }}</p>
        <p v-if="error" class="position-error" role="status">{{ error }}</p>
        <div class="recording-picker-actions"><button v-if="props.value" type="button" class="button subtle" @click="clear">{{ ui.clipMarkers.清除标记 }}</button><button type="button" class="button subtle" @click="close">{{ ui.common.取消 }}</button><button type="submit" class="button primary" :disabled="!!error">{{ ui.clipMarkers.确定 }}</button></div>
      </form>
    </div>
  </Teleport>
</template>
