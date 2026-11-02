<script setup>
import {ref,onMounted,onBeforeUnmount,nextTick} from 'vue';
import {api} from '../api.js';
const emit=defineEmits(['busy','close']);
const status=ref(null),busy=ref(false),error=ref(''),notice=ref(''),editing=ref(''),draft=ref('');
const platforms=[{id:'bilibili',name:'B 站',url:'https://api.bilibili.com/x/web-interface/nav'},
  {id:'douyin',name:'抖音',url:'https://live.douyin.com/'}];
const state=id=>status.value?.platforms?.[id];
async function copyUrl(platform){
  try{await navigator.clipboard.writeText(platform.url);notice.value=`网址已复制，请在已登录${platform.name}的浏览器中打开。`;}
  catch{const input=document.querySelector(`[data-cookie-url="${platform.id}"]`);input?.focus();input?.select();notice.value='请复制已选中的网址。';}
}
onMounted(async()=>{try{status.value=await api('platform-credentials');}catch{error.value='暂时无法读取保存状态，请返回后重试。';}});
onBeforeUnmount(()=>{draft.value='';});
async function begin(id){if(busy.value)return;draft.value='';editing.value=id;error.value='';notice.value='';await nextTick();document.querySelector(`[data-cookie-input="${id}"]`)?.focus();}
function cancel(){if(busy.value)return;draft.value='';editing.value='';error.value='';}
async function act(id,action){
  if(busy.value)return;
  if(action==='delete'&&!window.confirm('清除本机保存的登录信息？清除后以未登录方式连接，可能无法采集礼物。'))return;
  busy.value=true;emit('busy',true);error.value='';notice.value=action==='unlock'?'请在系统提示中授权解锁。':'';
  try{
    status.value=await api(`platform-credentials/${id}/${action}`,action==='save'?{cookie:draft.value}:{});
    draft.value='';editing.value='';
    notice.value=action==='delete'?'已清除本机保存的登录信息。':action==='unlock'?'已解锁，将继续使用保存的 Cookie。':'已加密保存，原文不会回显。';
    if(id==='douyin'&&action!=='delete')notice.value+=status.value.checks?.douyin==='pending'?'弹幕连接暂未刷新，将自动重试。':'后续弹幕和礼物连接将使用这份登录信息，视频录制继续进行。';
    await nextTick();document.querySelector(`[data-cookie-platform="${id}"]`)?.focus();
  }catch(e){error.value=e.message;notice.value='';}
  finally{busy.value=false;emit('busy',false);}
}
</script>
<template>
  <section class="platform-credentials" aria-label="Cookie 管理">
    <p class="muted">仅在本机加密保存，版本更新后继续保留。已保存的内容不会显示原文。</p>
    <p v-if="status?.available===false" class="inline-warning" role="alert">系统安全存储暂不可用，当前无法保存。</p>
    <section v-for="platform in platforms" :key="platform.id" class="credential-card" :aria-label="platform.name+' Cookie'">
      <div class="credential-row"><div><strong>{{ platform.name }}</strong><span class="credential-state">{{ status?state(platform.id)?.configured?'已保存':'未填写':'读取中…' }}</span></div><button class="button" :data-cookie-platform="platform.id" :disabled="busy||!status||status.available===false" @click="begin(platform.id)">{{ state(platform.id)?.configured?'去更换':'去填写' }}</button></div>
      <p v-if="platform.id==='douyin'" class="muted">用于抖音直播弹幕与礼物采集。未填写时仍可尝试录制视频和弹幕，礼物推送可能不完整；登录失效后请重新填写。</p>
      <form v-if="editing===platform.id" class="credential-editor" @submit.prevent="act(platform.id,'save')">
        <label class="field-label">{{ state(platform.id)?.configured?'粘贴新的 Cookie':'粘贴 Cookie' }}
          <input :data-cookie-input="platform.id" v-model="draft" type="password" :aria-label="platform.name+' Cookie'" autocomplete="new-password" autocapitalize="off" spellcheck="false" maxlength="32768" :disabled="busy" placeholder="粘贴请求头中的 Cookie 值"/>
        </label>
        <p v-if="state(platform.id)?.configured" class="muted">保存成功后，新内容会替换旧内容。</p>
        <div class="credential-actions"><button type="button" class="button" :disabled="busy" @click="cancel">取消</button><button class="button primary" :disabled="busy||!draft.trim()">{{ busy?'保存中…':'保存' }}</button></div>
      </form>
      <p v-if="state(platform.id)?.error" class="inline-warning">{{ state(platform.id).error }}</p>
      <div v-if="state(platform.id)?.configured" class="credential-actions">
        <button v-if="!state(platform.id).loaded" type="button" class="button" :disabled="busy||!status.available" @click="act(platform.id,'unlock')">解锁已保存的 Cookie</button>
        <button type="button" class="button" :disabled="busy" @click="act(platform.id,'delete')">清除 {{ platform.name }} Cookie</button>
      </div>
      <p v-if="platform.id==='bilibili'&&status?.bilibiliCore?.error" class="inline-warning">{{ status.bilibiliCore.error }}</p>
      <details class="cookie-guide"><summary>如何获取 {{ platform.name }} Cookie</summary>
        <ol>
          <li>在自己的 Chrome 或 Edge 浏览器中登录{{ platform.name }}。</li>
          <li>{{ platform.id==='bilibili'?'复制下面的网址，在同一浏览器打开。页面显示文字是正常的，不用复制正文。':'复制下面的网址，在同一浏览器打开并进入一个直播间。' }}
            <div class="cookie-guide-address"><input :data-cookie-url="platform.id" :value="platform.url" type="text" readonly :aria-label="platform.name+' Cookie 获取网址'" spellcheck="false" @focus="$event.target.select()"/><button type="button" class="button" @click="copyUrl(platform)">复制网址</button></div>
          </li>
          <li v-if="platform.id==='bilibili'">按 F12（Mac：⌘+⌥+i），选择“网络 / Network → 全部 / All”，刷新页面，点击列表中的 <code>nav</code> 请求。</li>
          <template v-else>
            <li>按 F12（Mac：⌘+⌥+i），打开“网络 / Network”。先清空左上方“过滤 / Filter”输入框，再点击类型按钮“文档 / Doc”，保持开发者工具打开并刷新直播间页面。</li>
            <li>点击名称为当前直播间号码的页面请求。进入“标头 / Headers”，确认“常规 / General”中的请求网址是 <code>https://live.douyin.com/直播间号码</code>。无需搜索接口名称。</li>
          </template>
          <li>在“标头 / Headers → 请求标头 / Request Headers”中，复制 <code>Cookie</code> 右侧的整段值，粘贴到上方输入框并保存。无需逐个复制字段或手动拼接。</li>
        </ol>
        <details v-if="platform.id==='douyin'" class="cookie-guide">
          <summary>列表为空，或看不到 Cookie？</summary>
          <p>确认过滤输入框已清空、左上方录制按钮为红色，并在打开开发者工具后刷新。若提示“显示临时标头 / Provisional headers”，可勾选“停用缓存 / Disable cache”再刷新。</p>
          <p>请选择直播间页面的“请求标头”中的 <code>Cookie</code>，不要复制“响应标头”中的 <code>Set-Cookie</code>。若保存时提示缺少 <code>sessionid</code> 或 <code>sessionid_ss</code>，请先确认这个直播间所在浏览器已登录抖音，再刷新并重新复制。</p>
        </details>
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
