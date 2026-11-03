<script setup>
import { ui } from '../../shared/ui-copy.js';

import {ref} from 'vue';
import {api} from '../api.js';
const props=defineProps({targets:{type:Array,default:()=>[]},available:Boolean});
const emit=defineEmits(['changed','choose']);
const input=ref(''),busy=ref(''),error=ref(''),removing=ref('');
const when=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):ui.legacyFollowing.尚未开始;
async function run(key,task){if(busy.value)return;busy.value=key;error.value='';try{await task();emit('changed');}catch(e){error.value=e.message;}finally{busy.value='';}}
function add(){return run('add',async()=>{await api('follow-users',{url:input.value});input.value='';});}
function toggle(target){return run(target.uid,()=>api(`follow-users/${target.uid}/enable`,{enabled:!target.enabled}));}
function remove(target){return run(target.uid,async()=>{await api(`follow-users/${target.uid}/remove`,{confirmed:true});removing.value='';});}
</script>
<template>
<section class="room-section follow-users" :aria-label="ui.legacyFollowing.抖音连麦跟录">
  <h2>{{ ui.legacyFollowing.抖音连麦跟录 }} <small>{{ ui.legacyFollowing.本地测试 }}</small></h2>
  <form class="room-form" @submit.prevent="add"><input v-model="input" :aria-label="ui.legacyFollowing.抖音用户主页或分享链接" :placeholder="ui.legacyFollowing.粘贴整段个人名片分享内容" :disabled="!!busy"/><button class="button primary small" :disabled="!available||!!busy||!input.trim()">{{ ui.legacyFollowing.绑定 }}</button></form>
  <p class="muted">{{ ui.legacyFollowing.旧版跟录说明 }}</p>
  <p v-if="error" role="alert" class="inline-warning">{{ error }}</p>
  <article v-for="target in targets" :key="target.uid" class="room-item">
    <strong>{{ target.name }}</strong><small class="uid">UID {{ target.uid }}</small>
    <p role="status">{{ target.state }}<span v-if="target.host"> · {{ target.host }}</span></p>
    <div class="room-controls"><label><input type="checkbox" :checked="target.enabled" :disabled="!available||!!busy" @change="toggle(target)"/>{{ ui.legacyFollowing.开启监控 }}</label><button class="text-button" :disabled="!!busy" @click="removing=target.uid">{{ ui.legacyFollowing.移除 }}</button></div>
    <div v-if="removing===target.uid" class="follow-confirm"><p>{{ ui.legacyFollowing.停止并移除该用户已录素材保留 }}</p><button class="button small" :disabled="!!busy" @click="removing=''">{{ ui.common.取消 }}</button><button class="button small danger" :disabled="!!busy" @click="remove(target)">{{ ui.common.确认移除 }}</button></div>
    <details v-if="target.history.length"><summary>{{ ui.legacyFollowing.跟录时段最近 }} {{ target.history.length }} {{ ui.legacyFollowing.次 }}</summary><div v-for="entry in target.history" :key="entry.id" class="follow-history"><strong>{{ entry.host }} · {{ entry.web_rid }}</strong><p>{{ ui.legacyFollowing.发现 }}{{ when(entry.discovered) }}<br/>{{ ui.legacyFollowing.开始 }}{{ when(entry.started) }}<br/>{{ ui.legacyFollowing.结束 }}{{ entry.ended?when(entry.ended):ui.legacyFollowing.进行中 }}</p><p>{{ entry.reason }}</p><button v-for="(session,index) in entry.materials" :key="session" class="text-button" @click="emit('choose',session)">{{ ui.legacyFollowing.查看素材 }} {{ index+1 }}</button></div></details>
  </article>
  <details class="muted"><summary>{{ ui.legacyFollowing.监控与停止规则 }}</summary><p>{{ ui.legacyFollowing.旧版跟录检查规则 }}</p><p>{{ ui.legacyFollowing.旧版共享录像说明 }}</p></details>
</section>
</template>
<style scoped>
.follow-users h2{display:flex;gap:8px;align-items:center}.follow-users h2 small{font-size:11px;font-weight:normal}.follow-users .muted,.follow-users p{font-size:12px;line-height:1.6}.uid{display:block;overflow-wrap:anywhere;font-size:11px}.follow-history{margin:8px 0;padding:8px;border-left:2px solid currentColor;font-size:12px}.follow-history p{margin:3px 0}.follow-users summary{cursor:pointer;font-size:12px;margin-top:10px}.follow-confirm{padding:8px 0}.follow-confirm button{margin-right:8px}
</style>
