<script setup>
import {ref,onMounted,onBeforeUnmount,nextTick} from 'vue';
import {api} from '../api.js';
const emit=defineEmits(['busy','close']);
const status=ref(null),busy=ref(false),error=ref(''),notice=ref(''),editing=ref(''),draft=ref(''),input=ref(null);
const platforms=[{id:'bilibili',name:'B 站',site:'https://live.bilibili.com/',filter:'api.live.bilibili.com'},{id:'douyin',name:'抖音',site:'https://live.douyin.com/',filter:'live.douyin.com/webcast/'}];
onMounted(async()=>{try{status.value=await api('platform-credentials');}catch{error.value='暂时无法读取保存状态，请返回后重试。';}});
onBeforeUnmount(()=>{draft.value='';});
async function begin(platform){if(busy.value)return;draft.value='';editing.value=platform;error.value='';notice.value='';await nextTick();input.value?.[0]?.focus();}
function cancel(){if(busy.value)return;draft.value='';editing.value='';error.value='';}
async function save(platform){
  if(busy.value)return;busy.value=true;emit('busy',true);error.value='';notice.value='';
  try{status.value=await api(`platform-credentials/${platform}/save`,{cookie:draft.value});draft.value='';editing.value='';notice.value='已保存。已保存的内容不可查看。';await nextTick();document.querySelector(`[data-cookie-platform="${platform}"]`)?.focus();}
  catch(e){error.value=e.message;}
  finally{busy.value=false;emit('busy',false);}
}
</script>
<template>
  <section class="platform-credentials" aria-label="Cookie 管理">
    <p class="muted">仅在本机加密保存。已保存的内容只能更换，不会显示原文。</p>
    <p v-if="status?.available===false" class="inline-warning" role="alert">系统安全存储暂不可用，当前无法保存。</p>
    <section v-for="platform in platforms" :key="platform.id" class="credential-card" :aria-label="platform.name+' Cookie'">
      <div class="credential-row"><div><strong>{{ platform.name }}</strong><span class="credential-state">{{ status?status.platforms[platform.id].configured?'已保存':'未填写':'读取中…' }}</span></div><button class="button" :data-cookie-platform="platform.id" :disabled="busy||!status||status.available===false" @click="begin(platform.id)">{{ status?.platforms?.[platform.id]?.configured?'去更换':'去填写' }}</button></div>
      <form v-if="editing===platform.id" class="credential-editor" @submit.prevent="save(platform.id)">
        <label class="field-label">{{ status.platforms[platform.id].configured?'粘贴新的 Cookie':'粘贴 Cookie' }}
          <input ref="input" v-model="draft" type="password" :aria-label="platform.name+' Cookie'" autocomplete="new-password" autocapitalize="off" spellcheck="false" maxlength="32768" :disabled="busy" placeholder="粘贴请求头中的 Cookie 值"/>
        </label>
        <p v-if="status.platforms[platform.id].configured" class="muted">保存成功后，新内容会替换旧内容。</p>
        <div class="credential-actions"><button type="button" class="button" :disabled="busy" @click="cancel">取消</button><button class="button primary" :disabled="busy||!draft.trim()">{{ busy?'保存中…':'保存' }}</button></div>
      </form>
      <p v-if="status?.platforms?.[platform.id]?.error" class="inline-warning">{{ status.platforms[platform.id].error }}</p>
      <p v-if="platform.id==='bilibili'&&status?.bilibiliCore?.error" class="inline-warning">{{ status.bilibiliCore.error }}</p>
      <details class="cookie-guide"><summary>如何获取 {{ platform.name }} Cookie</summary>
        <ol><li>在自己的浏览器打开 <a :href="platform.site" target="_blank" rel="noopener noreferrer">{{ platform.name }}直播</a>并登录。</li><li>按 F12（Mac：⌘⌥I），选择“网络 / Network”，刷新网页，筛选 <code>{{ platform.filter }}</code>。</li><li>选中请求，在“标头 → 请求标头”中复制 <code>Cookie</code> 的值，粘贴并保存。</li></ol>
        <p class="muted">Cookie 是登录凭据，请勿分享。无需在控制台运行代码。</p>
      </details>
    </section>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" role="alert" class="inline-warning">{{ error }}</p>
    <div class="confirm-actions"><button class="button" :disabled="busy" @click="emit('close')">返回设置</button></div>
  </section>
</template>
<style scoped>
.platform-credentials p{line-height:1.6}.credential-card{border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:14px}.credential-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.credential-state{font-size:12px;color:var(--muted);margin-left:12px}.credential-editor{margin-top:16px}.credential-editor input{width:100%;min-width:0;box-sizing:border-box}.credential-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.cookie-guide{margin-top:12px;font-size:13px}.cookie-guide summary{cursor:pointer;color:var(--rose-dark)}.cookie-guide ol{padding-left:20px;line-height:1.7}.cookie-guide li{margin:6px 0}.cookie-guide code{overflow-wrap:anywhere}
</style>
