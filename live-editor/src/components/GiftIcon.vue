<script setup>
import {ref,watch} from 'vue';
import {Gift,Ship} from 'lucide-vue-next';
const props=defineProps({gift:Object});const failed=ref(false);
watch(()=>props.gift?.iconUrl,()=>failed.value=false);
</script>
<template><span class="gift-icon"><img v-if="gift?.iconUrl&&!failed" :src="gift.iconUrl" alt="" referrerpolicy="no-referrer" @error="failed=true"/><Ship v-else-if="gift?.type==='guard'" aria-label="上舰"/><Gift v-else aria-label="礼物"/></span></template>
<style scoped>.gift-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:28px;color:#d29f51}.gift-icon img{height:100%;width:100%;object-fit:contain}.gift-icon svg{height:75%;width:75%}</style>
