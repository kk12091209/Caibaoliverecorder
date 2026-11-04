<script setup>
import { ui } from '../../shared/ui-copy.js';

import {ref,onMounted,onBeforeUnmount,nextTick} from 'vue';
import {api} from '../api.js';
const emit=defineEmits(['busy','close']);
const status=ref(null),busy=ref(false),error=ref(''),notice=ref(''),editing=ref(''),draft=ref('');
const platforms=[{id:'bilibili',name:ui.credentials.B站,url:'https://api.bilibili.com/x/web-interface/nav'},
  {id:'douyin',name:ui.common.抖音,url:'https://live.douyin.com/'}];
const state=id=>status.value?.platforms?.[id];
async function copyUrl(platform){
  try{await navigator.clipboard.writeText(platform.url);notice.value=ui.credentials.网址已复制(platform.name);}
  catch{const input=document.querySelector(`[data-cookie-url="${platform.id}"]`);input?.focus();input?.select();notice.value=ui.credentials.请复制已选中的网址;}
}
onMounted(async()=>{try{status.value=await api('platform-credentials');}catch{error.value=ui.credentials.暂时无法读取保存状态请返回后重试;}});
onBeforeUnmount(()=>{draft.value='';});
async function begin(id){if(busy.value)return;draft.value='';editing.value=id;error.value='';notice.value='';await nextTick();document.querySelector(`[data-cookie-input="${id}"]`)?.focus();}
function cancel(){if(busy.value)return;draft.value='';editing.value='';error.value='';}
async function act(id,action){
  if(busy.value)return;
  if(action==='delete'&&!window.confirm(ui.credentials.清除登录确认))return;
  busy.value=true;emit('busy',true);error.value='';notice.value=action==='unlock'?ui.credentials.请在系统提示中授权解锁:'';
  try{
    status.value=await api(`platform-credentials/${id}/${action}`,action==='save'?{cookie:draft.value}:{});
    draft.value='';editing.value='';
    notice.value=action==='delete'?ui.credentials.已清除本机保存的登录信息:action==='unlock'?ui.credentials.已解锁将继续使用保存的Cookie:ui.credentials.已加密保存原文不会回显;
    if(id==='douyin'&&action!=='delete')notice.value+=status.value.checks?.douyin==='pending'?ui.credentials.弹幕连接暂未刷新将自动重试:ui.credentials.将用于后续弹幕和礼物采集;
    await nextTick();document.querySelector(`[data-cookie-platform="${id}"]`)?.focus();
  }catch(e){error.value=e.message;notice.value='';}
  finally{busy.value=false;emit('busy',false);}
}
</script>
<template>
  <section class="platform-credentials" :aria-label="ui.common.Cookie管理">
    <p class="muted">{{ ui.credentials.本机保存说明 }}</p>
    <p v-if="status?.available===false" class="inline-warning" role="alert">{{ ui.credentials.安全存储不可用 }}</p>
    <section v-for="platform in platforms" :key="platform.id" class="credential-card" :aria-label="platform.name+' Cookie'">
      <div class="credential-row"><div><strong>{{ platform.name }}</strong><span class="credential-state">{{ status?state(platform.id)?.configured?ui.credentials.已保存:ui.credentials.未填写:ui.credentials.读取中 }}</span></div><button class="button" :data-cookie-platform="platform.id" :disabled="busy||!status||status.available===false" @click="begin(platform.id)">{{ state(platform.id)?.configured?ui.credentials.去更换:ui.credentials.去填写 }}</button></div>
      <p v-if="platform.id==='douyin'" class="muted">{{ ui.credentials.抖音登录用途 }}</p>
      <form v-if="editing===platform.id" class="credential-editor" @submit.prevent="act(platform.id,'save')">
        <label class="field-label">{{ state(platform.id)?.configured?ui.credentials.粘贴新的Cookie:ui.credentials.粘贴Cookie }}
          <input :data-cookie-input="platform.id" v-model="draft" type="password" :aria-label="platform.name+' Cookie'" autocomplete="new-password" autocapitalize="off" spellcheck="false" maxlength="32768" :disabled="busy" :placeholder="ui.credentials.粘贴请求头中的Cookie值"/>
        </label>
        <div class="credential-actions"><button type="button" class="button" :disabled="busy" @click="cancel">{{ ui.common.取消 }}</button><button class="button primary" :disabled="busy||!draft.trim()">{{ busy?ui.credentials.保存中:ui.credentials.保存 }}</button></div>
      </form>
      <p v-if="state(platform.id)?.error" class="inline-warning">{{ state(platform.id).error }}</p>
      <div v-if="state(platform.id)?.configured" class="credential-actions">
        <button v-if="!state(platform.id).loaded" type="button" class="button" :disabled="busy||!status.available" @click="act(platform.id,'unlock')">{{ ui.credentials.解锁已保存的Cookie }}</button>
        <button type="button" class="button" :disabled="busy" @click="act(platform.id,'delete')">{{ ui.credentials.清除 }} {{ platform.name }} Cookie</button>
      </div>
      <p v-if="platform.id==='bilibili'&&status?.bilibiliCore?.error" class="inline-warning">{{ status.bilibiliCore.error }}</p>
      <details class="cookie-guide"><summary>{{ ui.credentials.如何获取 }} {{ platform.name }} Cookie</summary>
        <ol>
          <li>{{ ui.credentials.登录浏览器步骤 }}{{ platform.name }}。</li>
          <li>{{ platform.id==='bilibili'?ui.credentials.打开B站页面步骤:ui.credentials.打开抖音页面步骤 }}
            <div class="cookie-guide-address"><input :data-cookie-url="platform.id" :value="platform.url" type="text" readonly :aria-label="platform.name+ui.credentials.Cookie获取网址" spellcheck="false" @focus="$event.target.select()"/><button type="button" class="button" @click="copyUrl(platform)">{{ ui.credentials.复制网址 }}</button></div>
          </li>
          <li v-if="platform.id==='bilibili'">{{ ui.credentials.选择B站请求步骤 }} <code>nav</code> {{ ui.credentials.请求 }}</li>
          <template v-else>
            <li>{{ ui.credentials.选择抖音文档步骤 }}</li>
            <li>{{ ui.credentials.核对抖音请求步骤 }} <code>{{ ui.credentials.抖音页面地址示例 }}</code>{{ ui.credentials.无需搜索接口名称 }}</li>
          </template>
          <li>{{ ui.credentials.复制请求标头步骤 }} <code>Cookie</code> {{ ui.credentials.粘贴完整Cookie步骤 }}</li>
        </ol>
        <details v-if="platform.id==='douyin'" class="cookie-guide">
          <summary>{{ ui.credentials.列表为空或看不到Cookie }}</summary>
          <p>{{ ui.credentials.请求列表排查 }}</p>
          <p>{{ ui.credentials.请选择直播间页面的请求标头中的 }} <code>Cookie</code>{{ ui.credentials.不要复制响应标头中的 }} <code>Set-Cookie</code>{{ ui.credentials.若保存时提示缺少 }} <code>sessionid</code> {{ ui.credentials.或 }} <code>sessionid_ss</code>{{ ui.credentials.缺少登录字段处理 }}</p>
        </details>
        <p class="muted">{{ ui.credentials.登录凭据安全提示 }}</p>
      </details>
    </section>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" role="alert" class="inline-warning">{{ error }}</p>
    <div class="confirm-actions"><button class="button" :disabled="busy" @click="emit('close')">{{ ui.common.返回设置 }}</button></div>
  </section>
</template>
<style scoped>
.platform-credentials p{line-height:1.6}.credential-card{border:1px solid var(--line);border-radius:var(--radius-card);padding:16px;margin-top:14px}.credential-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.credential-state{font-size:12px;color:var(--muted);margin-left:12px}.credential-editor{margin-top:16px}.credential-editor input{width:100%;min-width:0;box-sizing:border-box}.credential-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.cookie-guide{margin-top:12px;font-size:13px}.cookie-guide summary{cursor:pointer;color:var(--rose-dark)}.cookie-guide ol{padding-left:20px;line-height:1.7}.cookie-guide li{margin:6px 0}.cookie-guide code{overflow-wrap:anywhere}.cookie-guide-address{display:flex;align-items:center;gap:8px;margin-top:8px}.cookie-guide-address input{min-width:0;flex:1;font-size:12px}.cookie-guide-address button{flex-shrink:0;font-size:12px;padding:8px 10px}@media(max-width:520px){.cookie-guide-address{align-items:stretch;flex-direction:column}.cookie-guide-address input{flex:auto;width:100%;box-sizing:border-box}}
</style>
