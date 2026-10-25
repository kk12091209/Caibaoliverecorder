<script setup>
import {ref,onMounted,onBeforeUnmount,nextTick} from 'vue';
import {api} from '../api.js';
const emit=defineEmits(['busy','close']);
const status=ref(null),busy=ref(false),error=ref(''),notice=ref(''),editing=ref(false),draft=ref(''),input=ref(null),urlInput=ref(null);
const platform={id:'bilibili',name:'B 站'};
const loginStatusUrl='https://api.bilibili.com/x/web-interface/nav';
async function copyUrl(){
  try{await navigator.clipboard.writeText(loginStatusUrl);notice.value='网址已复制，请在已登录 B 站的浏览器中打开。';}
  catch{urlInput.value?.focus();urlInput.value?.select();notice.value='请复制已选中的网址。';}
}
onMounted(async()=>{try{status.value=await api('platform-credentials');}catch{error.value='暂时无法读取保存状态，请返回后重试。';}});
onBeforeUnmount(()=>{draft.value='';});
async function begin(){if(busy.value)return;draft.value='';editing.value=true;error.value='';notice.value='';await nextTick();input.value?.focus();}
function cancel(){if(busy.value)return;draft.value='';editing.value=false;error.value='';}
async function unlock(){
  if(busy.value)return;busy.value=true;emit('busy',true);error.value='';notice.value='请在系统提示中授权解锁。';
  try{status.value=await api('platform-credentials/bilibili/unlock',{});notice.value='已解锁，将继续使用原来保存的 Cookie。';}
  catch(e){error.value=e.message;notice.value='';}
  finally{busy.value=false;emit('busy',false);}
}
async function save(){
  if(busy.value)return;busy.value=true;emit('busy',true);error.value='';notice.value='';
  try{status.value=await api('platform-credentials/bilibili/save',{cookie:draft.value});draft.value='';editing.value=false;notice.value='已保存。已保存的内容不可查看。';await nextTick();document.querySelector('[data-cookie-platform="bilibili"]')?.focus();}
  catch(e){error.value=e.message;}
  finally{busy.value=false;emit('busy',false);}
}
</script>
<template>
  <section class="platform-credentials" aria-label="Cookie 管理">
    <p class="muted">仅在本机加密保存，版本更新后继续保留。已保存的内容只能更换，不会显示原文。</p>
    <p v-if="status?.available===false" class="inline-warning" role="alert">系统安全存储暂不可用，当前无法保存。</p>
    <section class="credential-card" :aria-label="platform.name+' Cookie'">
      <div class="credential-row"><div><strong>{{ platform.name }}</strong><span class="credential-state">{{ status?status.platforms[platform.id].configured?'已保存':'未填写':'读取中…' }}</span></div><button class="button" :data-cookie-platform="platform.id" :disabled="busy||!status||status.available===false" @click="begin">{{ status?.platforms?.[platform.id]?.configured?'去更换':'去填写' }}</button></div>
      <form v-if="editing" class="credential-editor" @submit.prevent="save">
        <label class="field-label">{{ status.platforms[platform.id].configured?'粘贴新的 Cookie':'粘贴 Cookie' }}
          <input ref="input" v-model="draft" type="password" :aria-label="platform.name+' Cookie'" autocomplete="new-password" autocapitalize="off" spellcheck="false" maxlength="32768" :disabled="busy" placeholder="粘贴请求头中的 Cookie 值"/>
        </label>
        <p v-if="status.platforms[platform.id].configured" class="muted">保存成功后，新内容会替换旧内容。</p>
        <div class="credential-actions"><button type="button" class="button" :disabled="busy" @click="cancel">取消</button><button class="button primary" :disabled="busy||!draft.trim()">{{ busy?'保存中…':'保存' }}</button></div>
      </form>
      <p v-if="status?.platforms?.[platform.id]?.error" class="inline-warning">{{ status.platforms[platform.id].error }}</p>
      <button v-if="status?.platforms?.bilibili?.configured&&!status.platforms.bilibili.loaded" type="button" class="button" :disabled="busy||!status.available" @click="unlock">解锁已保存的 Cookie</button>
      <p v-if="status?.bilibiliCore?.error" class="inline-warning">{{ status.bilibiliCore.error }}</p>
      <details class="cookie-guide"><summary>如何获取 {{ platform.name }} Cookie</summary>
        <ol>
          <li>在自己的 Chrome 或 Edge 浏览器中打开 <a href="https://www.bilibili.com/" target="_blank" rel="noopener noreferrer">B 站</a>并登录。</li>
          <li>复制下面的网址，在同一浏览器打开。页面出现一段文字是正常的，不用复制页面正文。
            <div class="cookie-guide-address"><input ref="urlInput" :value="loginStatusUrl" type="text" readonly aria-label="B 站登录状态接口网址" spellcheck="false" @focus="$event.target.select()"/><button type="button" class="button" @click="copyUrl">复制网址</button></div>
          </li>
          <li>按 F12（Mac：⌘⌥I），选择“网络 / Network → 全部 / All”，刷新页面，点击列表中的 <code>nav</code>。</li>
          <li>在“标头 / Headers → 请求标头 / Request Headers”中，复制 <code>Cookie</code> 右侧的整段值，粘贴到上方输入框并保存。无需逐个复制字段或手动拼接。</li>
        </ol>
        <p class="muted">Cookie 是登录凭据，请勿分享。无需在控制台运行代码。</p>
      </details>
    </section>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" role="alert" class="inline-warning">{{ error }}</p>
    <div class="confirm-actions"><button class="button" :disabled="busy" @click="emit('close')">返回设置</button></div>
  </section>
</template>
<style scoped>
.platform-credentials p{line-height:1.6}.credential-card{border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:14px}.credential-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.credential-state{font-size:12px;color:var(--muted);margin-left:12px}.credential-editor{margin-top:16px}.credential-editor input{width:100%;min-width:0;box-sizing:border-box}.credential-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.cookie-guide{margin-top:12px;font-size:13px}.cookie-guide summary{cursor:pointer;color:var(--rose-dark)}.cookie-guide ol{padding-left:20px;line-height:1.7}.cookie-guide li{margin:6px 0}.cookie-guide code{overflow-wrap:anywhere}.cookie-guide-address{display:flex;align-items:center;gap:8px;margin-top:8px}.cookie-guide-address input{min-width:0;flex:1;font-size:12px}.cookie-guide-address button{flex-shrink:0;font-size:12px;padding:8px 10px}@media(max-width:520px){.cookie-guide-address{align-items:stretch;flex-direction:column}.cookie-guide-address input{flex:auto;width:100%;box-sizing:border-box}}
</style>
