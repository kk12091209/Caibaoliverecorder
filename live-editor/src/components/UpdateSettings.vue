<script setup>
import { computed, ref } from 'vue';
import { Download, RefreshCw, LoaderCircle } from 'lucide-vue-next';
import { api } from '../api.js';
import { isDesktop, openUpdateInstaller } from '../desktop.js';
const props=defineProps({ state:Object });
const emit=defineEmits(['changed']);
const busy=ref(false),message=ref(''),error=ref('');
const update=computed(()=>props.state||{});
const working=computed(()=>busy.value||['checking','downloading'].includes(update.value.status));
const percent=computed(()=>Math.min(100,Math.floor((update.value.received||0)/(update.value.candidate?.size||1)*100)));
const status=computed(()=>({idle:'启动后会自动检查，也可手动检查。',checking:'正在检查更新…',current:'已是最新修订。',available:'发现可用更新',downloading:'正在下载安装包…',ready:'安装包已下载并通过校验。',error:'暂时无法检查更新。'})[update.value.status]||'正在连接更新服务…');
async function action(name,input={}){
  if(busy.value)return;busy.value=true;error.value='';message.value='';
  try{emit('changed',await api('updates/'+name,input));}catch(e){error.value=e.message;}finally{busy.value=false;}
}
async function install(){
  if(working.value)return;busy.value=true;error.value='';message.value='';
  try{message.value=await openUpdateInstaller();}catch(e){error.value=e.message;}finally{busy.value=false;}
}
</script>

<template>
  <section class="update-settings" aria-label="软件更新">
    <div class="update-heading"><strong>软件更新</strong><span>当前 {{ update.current?.version || '0.1.6' }}<small v-if="update.current"> · 修订 {{ update.current.revision }}</small></span></div>
    <label class="checkbox"><input type="checkbox" :checked="update.enabled!==false" :disabled="busy" @change="action('settings',{enabled:$event.target.checked})"/>自动检查更新并提醒</label>
    <p class="muted">后台每天检查 GitHub 发布页；由你确认下载和安装，不会强制中断录制或导出。</p>
    <div class="update-actions"><button class="button small" :disabled="working" @click="action('check')"><LoaderCircle v-if="update.status==='checking'" class="spin" :size="14"/><RefreshCw v-else :size="14"/>检查更新</button><small v-if="update.checkedAt">上次检查 {{ new Date(update.checkedAt).toLocaleString() }}</small></div>
    <p role="status">{{ status }}</p>
    <div v-if="update.candidate" class="update-available">
      <strong>{{ update.candidate.version }} · 修订 {{ update.candidate.revision }}</strong>
      <ul><li v-for="(note,index) in update.candidate.notes" :key="index">{{ note }}</li></ul>
      <template v-if="update.status==='downloading'"><progress :value="update.received" :max="update.candidate.size" aria-label="更新下载进度"/><p>{{ percent }}% · {{ (update.received/1048576).toFixed(1) }} / {{ (update.candidate.size/1048576).toFixed(1) }} MB</p><button class="button small" :disabled="busy" @click="action('cancel')">取消下载</button></template>
      <div v-else class="update-actions">
        <button v-if="update.status==='ready'" class="button primary small" :disabled="working||!!update.installBlocked||!isDesktop" @click="install"><Download :size="14"/>{{ busy?'正在验证…':'打开安装包' }}</button>
        <button v-else class="button primary small" :disabled="working" @click="action('download',{key:update.candidate.key})"><Download :size="14"/>下载更新（{{ (update.candidate.size/1048576).toFixed(1) }} MB）</button>
        <button class="button subtle small" :disabled="working" @click="action('defer')">稍后提醒</button>
      </div>
      <p v-if="update.status==='ready'" class="muted">{{ update.platform==='darwin-arm64'?'打开 DMG 后，退出软件，再拖入“应用程序”替换。':'打开安装向导后，按提示更新到原安装目录。' }}录像和设置保留。</p>
      <p v-if="update.status==='ready'&&update.installBlocked" class="inline-warning">{{ update.installBlocked }}</p>
      <p v-if="update.status==='ready'&&!isDesktop" class="muted">请回到桌面应用打开安装包。</p>
    </div>
    <p v-if="error||update.error" class="inline-warning" role="alert">{{ error||update.error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <button v-if="update.hasCache" class="text-button" :disabled="working" @click="action('clear')">清理已下载的安装包</button>
  </section>
</template>

<style scoped>
.update-settings{border:1px solid var(--line);border-radius:10px;padding:14px;margin:16px 0;color:var(--text);font-size:13px;}
.update-heading{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
.update-heading span,.update-actions small{color:var(--muted);font-size:12px;}
.update-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0;}
.update-available{border-top:1px solid var(--line);padding-top:14px;margin-top:12px;}
.update-available ul{padding-left:18px;line-height:1.7;margin:10px 0;overflow-wrap:anywhere;}
progress{display:block;width:100%;height:10px;accent-color:var(--accent);margin:14px 0;}
</style>
