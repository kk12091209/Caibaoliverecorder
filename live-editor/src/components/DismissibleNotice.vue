<script setup>
import {ref,onMounted,onBeforeUnmount} from 'vue';
import {X} from 'lucide-vue-next';
defineProps({closeLabel:{type:String,default:'关闭提示'}});
const emit=defineEmits(['dismiss']),card=ref(null),visible=ref(true);
function dismiss(){if(!visible.value)return;visible.value=false;emit('dismiss');}
function outside(event){if(visible.value&&card.value&&!event.composedPath().includes(card.value))dismiss();}
function escape(event){if(event.key==='Escape')dismiss();}
onMounted(()=>{document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);});
onBeforeUnmount(()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);});
</script>
<template><aside v-if="visible" ref="card" class="dismissible-notice"><slot/><button type="button" class="icon-button dismiss-notice" :aria-label="closeLabel" @click="dismiss"><X :size="16"/></button></aside></template>
<style scoped>
.dismissible-notice{padding-right:44px}.dismiss-notice{position:absolute;right:8px;top:8px}
</style>
