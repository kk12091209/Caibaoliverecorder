<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { RefreshCw, ExternalLink, LoaderCircle } from 'lucide-vue-next';
import { getPowerStatus, openPowerSettings } from '../desktop.js';

const status=ref(null),checking=ref(false),opening=ref(false),error=ref(''),message=ref(''),guide=ref(false);
let disposed=false,timer;
const systemSleep=computed(()=>({
  enabled:{label:'已开启',detail:'系统已设为接电时不自动睡眠。这是系统电源设置，不代表合盖后一定能继续录制。',tone:'good'},
  disabled:{label:'已关闭',detail:'系统允许接电时自动睡眠。录制期间，本应用仍会单独申请防休眠保护。',tone:'warning'},
  unknown:{label:'无法确认',detail:'未能读取系统电源设置，不能用应用保护或合盖策略推断这个开关。',tone:'warning'}
}[status.value?.systemSleepAC]||{label:checking.value?'检测中…':'未检测',detail:'读取系统保存的接电睡眠设置。'}));
const checkedTime=computed(()=>{const date=new Date(status.value?.checkedAt);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString('zh-CN',{hour12:false});});
const protection=computed(()=>({
  active:{label:'保护已申请',detail:'本应用已申请阻止自动休眠，允许熄屏；关闭上面的系统开关不会取消此请求。',tone:'good'},
  standby:{label:'自动待命',detail:'当前没有需要保护的任务。开始监控或处理视频时会自动申请防休眠。'},
  inactive:{label:'申请未成功',detail:'当前任务需要保护，但本应用的防休眠请求尚未成功。',tone:'warning'},
  unknown:{label:'无法确认',detail:'未能确认系统是否接受防休眠请求，请重新检测。',tone:'warning'}
}[status.value?.protection]||{label:checking.value?'检测中…':'未检测',detail:'有监控或录制任务时自动保护，无需手动开启。'}));
const lid=computed(()=>({
  enabled:{label:'当前不触发睡眠',detail:'仅表示系统当前报告的合盖策略，不代表上面的开关已开启，也不保证合盖后能持续录制。电源或外接设备变化后需重新检测。'},
  disabled:{label:'当前会触发睡眠',detail:'系统当前报告合盖会触发休眠。录制时请保持盖子打开，或按指引配置合盖使用。',tone:'warning'},
  'not-applicable':{label:'不适用',detail:'系统未报告笔记本上盖，此设备无需设置合盖行为。'},
  unknown:{label:'无法确认',detail:'系统未提供可靠的合盖状态，不能确认合盖后能继续录制。',tone:'warning'}
}[status.value?.lid]||{label:checking.value?'检测中…':'未检测',detail:'检测当前系统状态，不会修改电脑的电源设置。'}));
async function refresh(){
  if(disposed||checking.value||document.hidden)return;
  checking.value=true;
  try{
    const value=await getPowerStatus();if(disposed)return;
    if(value?.version!==2||!['enabled','disabled','unknown'].includes(value.systemSleepAC)||!['active','standby','inactive','unknown'].includes(value.protection)||!['enabled','disabled','not-applicable','unknown'].includes(value.lid))throw new Error('休眠状态回复不完整，请重新检测；旧版桌面组件需要更新后才能读取系统开关。');
    status.value=value;error.value='';
  }catch(e){if(!disposed){status.value=null;error.value=e.message;}}
  finally{if(!disposed)checking.value=false;}
}
async function openSettings(){
  if(opening.value)return;opening.value=true;message.value='';
  try{await openPowerSettings();if(!disposed)message.value='已请求打开系统设置。完成后回到这里，状态会自动重新检测。';}
  catch(e){if(!disposed)message.value=e.message;}
  finally{if(!disposed)opening.value=false;}
}
function focusRefresh(){void refresh();}
onMounted(()=>{void refresh();timer=setInterval(focusRefresh,5000);window.addEventListener('focus',focusRefresh);document.addEventListener('visibilitychange',focusRefresh);});
onBeforeUnmount(()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',focusRefresh);document.removeEventListener('visibilitychange',focusRefresh);});
</script>

<template>
  <section class="power-settings" aria-label="录制与休眠">
    <div class="power-heading"><strong>录制与休眠</strong><button class="button small" :disabled="checking" @click="refresh"><LoaderCircle v-if="checking" class="spin" :size="14"/><RefreshCw v-else :size="14"/>重新检测</button></div>
    <div class="power-row" aria-label="系统接电睡眠设置"><div><strong>接电时防止自动睡眠</strong><p>{{ systemSleep.detail }}</p></div><span class="power-badge" :class="systemSleep.tone" role="status">{{ systemSleep.label }}</span></div>
    <div class="power-row" aria-label="自动休眠保护"><div><strong>本应用的录制防休眠</strong><p>{{ protection.detail }}</p></div><span class="power-badge" :class="protection.tone" role="status">{{ protection.label }}</span></div>
    <div class="power-row" aria-label="合盖运行状态"><div><strong>系统当前合盖策略</strong><p>{{ lid.detail }}</p></div><span class="power-badge" :class="lid.tone" role="status">{{ lid.label }}</span></div>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <button class="text-button power-guide-button" :aria-expanded="guide" aria-controls="power-guide" @click="guide=!guide">{{ guide?'收起设置指引':'如何设置，避免录制中断' }}</button>
    <div v-if="guide" id="power-guide" class="power-guide">
      <p><strong>熄屏后继续运行</strong></p>
      <p v-if="status?.lid==='not-applicable'">打开“系统设置 → 节能”，查看“当显示器关闭时，防止自动进入睡眠”。</p>
      <p v-else>打开“系统设置 → 电池 → 选项”，开启“使用电源适配器供电且显示器关闭时，防止自动进入睡眠”。部分机型的名称或可用选项不同。</p>
      <p><strong>合盖后继续运行</strong></p>
      <p>macOS 没有通用的“合盖不休眠”开关。苹果支持的合盖使用方式需要连接电源、外接显示器和外接键盘鼠标。完成连接后，回到这里重新检测。</p>
      <p class="inline-warning">上面的“防止自动睡眠”选项不等于合盖保护。真正进入休眠后无法继续录制，手动睡眠或低电量也可能中断录制。</p>
      <button class="button small" :disabled="opening" @click="openSettings"><LoaderCircle v-if="opening" class="spin" :size="14"/><ExternalLink v-else :size="14"/>打开系统电源设置</button>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
    <small class="power-footnote"><span v-if="checkedTime">最近检测 {{ checkedTime }}。 </span>状态随系统条件变化；本页打开时自动刷新。点击打开设置不会直接更改开关。</small>
  </section>
</template>

<style scoped>
.power-settings{border:1px solid var(--line);border-radius:10px;padding:14px;margin:16px 0;font-size:13px;color:var(--text);}
.power-heading,.power-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;}
.power-heading{align-items:center;flex-wrap:wrap;margin-bottom:6px;}
.power-row{padding:12px 0;border-bottom:1px solid var(--line);}
.power-row>div{min-width:0;flex:1;}.power-row p,.power-guide p{margin:7px 0;line-height:1.65;overflow-wrap:anywhere;}.power-row p,.power-footnote{color:var(--muted);}
.power-badge{flex-shrink:0;font-size:12px;border:1px solid var(--line);border-radius:20px;padding:4px 8px;white-space:nowrap;}
.power-badge.good{color:#285d38;background:#edf7ee;border-color:#b9d6bf;}.power-badge.warning{color:#89500c;background:#fff6e4;border-color:#e5c795;}
.power-guide-button{margin:12px 0;}.power-guide{padding:0 0 12px;}.power-footnote{display:block;line-height:1.6;}
@media(max-width:480px){.power-row{flex-wrap:wrap;}.power-row>div{flex-basis:100%;}.power-heading .button{font-size:12px;}}
</style>
