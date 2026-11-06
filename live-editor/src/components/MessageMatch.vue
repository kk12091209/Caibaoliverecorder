<script setup>
import { computed } from 'vue';

const props=defineProps({text:String,pattern:RegExp});
const parts=computed(()=>props.pattern?(props.text||'').split(props.pattern):[props.text]);
</script>

<template>
  <template v-for="(part,index) in parts" :key="index"><mark v-if="index%2" class="message-match">{{ part }}</mark><template v-else>{{ part }}</template></template>
</template>
