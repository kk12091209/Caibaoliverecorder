<script setup>
import { ui } from '../../shared/ui-copy.js';

import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { RefreshCw, ExternalLink, LoaderCircle } from 'lucide-vue-next';
import { getPowerStatus, openPowerSettings } from '../desktop.js';

const status=ref(null),checking=ref(false),opening=ref(false),error=ref(''),message=ref(''),guide=ref(false);
let disposed=false,timer;
const systemSleep=computed(()=>({
  enabled:{label:ui.power.已开启,detail:ui.power.系统防休眠已开启说明,tone:'good'},
  disabled:{label:ui.power.已关闭,detail:ui.power.系统防休眠已关闭说明,tone:'warning'},
  unknown:{label:ui.power.无法确认,detail:ui.power.系统睡眠设置读取失败,tone:'warning'}
}[status.value?.systemSleepAC]||{label:checking.value?ui.power.检测中:ui.power.未检测,detail:ui.power.读取系统保存的接电睡眠设置}));
const checkedTime=computed(()=>{const date=new Date(status.value?.checkedAt);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString('zh-CN',{hour12:false});});
const protection=computed(()=>({
  active:{label:ui.power.保护已申请,detail:ui.power.应用防休眠已申请说明,tone:'good'},
  standby:{label:ui.power.自动待命,detail:ui.power.应用防休眠待命说明},
  inactive:{label:ui.power.申请未成功,detail:ui.power.应用防休眠申请失败,tone:'warning'},
  unknown:{label:ui.power.无法确认,detail:ui.power.应用防休眠无法确认,tone:'warning'}
}[status.value?.protection]||{label:checking.value?ui.power.检测中:ui.power.未检测,detail:ui.power.应用保护检测说明}));
const lid=computed(()=>({
  enabled:{label:ui.power.当前不触发睡眠,detail:ui.power.合盖策略限制说明},
  disabled:{label:ui.power.当前会触发睡眠,detail:ui.power.合盖会休眠提示,tone:'warning'},
  'not-applicable':{label:ui.power.不适用,detail:ui.power.无需设置合盖行为},
  unknown:{label:ui.power.无法确认,detail:ui.power.合盖状态无法确认,tone:'warning'}
}[status.value?.lid]||{label:checking.value?ui.power.检测中:ui.power.未检测,detail:ui.power.检测只读说明}));
async function refresh(){
  if(disposed||checking.value||document.hidden)return;
  checking.value=true;
  try{
    const value=await getPowerStatus();if(disposed)return;
    if(value?.version!==2||!['enabled','disabled','unknown'].includes(value.systemSleepAC)||!['active','standby','inactive','unknown'].includes(value.protection)||!['enabled','disabled','not-applicable','unknown'].includes(value.lid))throw new Error(ui.power.桌面睡眠状态不完整);
    status.value=value;error.value='';
  }catch(e){if(!disposed){status.value=null;error.value=e.message;}}
  finally{if(!disposed)checking.value=false;}
}
async function openSettings(){
  if(opening.value)return;opening.value=true;message.value='';
  try{await openPowerSettings();if(!disposed)message.value=ui.power.系统设置已打开返回后自动检测;}
  catch(e){if(!disposed)message.value=e.message;}
  finally{if(!disposed)opening.value=false;}
}
function focusRefresh(){void refresh();}
onMounted(()=>{void refresh();timer=setInterval(focusRefresh,5000);window.addEventListener('focus',focusRefresh);document.addEventListener('visibilitychange',focusRefresh);});
onBeforeUnmount(()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',focusRefresh);document.removeEventListener('visibilitychange',focusRefresh);});
</script>

<template>
  <section class="power-settings" :aria-label="ui.power.录制与休眠">
    <div class="power-heading"><strong>{{ ui.power.录制与休眠 }}</strong><button class="button small" :disabled="checking" @click="refresh"><LoaderCircle v-if="checking" class="spin" :size="14"/><RefreshCw v-else :size="14"/>{{ ui.power.重新检测 }}</button></div>
    <div class="power-row" :aria-label="ui.power.系统接电睡眠设置"><div><strong>{{ ui.power.接电时防止自动睡眠 }}</strong><p>{{ systemSleep.detail }}</p></div><span class="power-badge" :class="systemSleep.tone" role="status">{{ systemSleep.label }}</span></div>
    <div class="power-row" :aria-label="ui.power.自动休眠保护"><div><strong>{{ ui.power.本应用的录制防休眠 }}</strong><p>{{ protection.detail }}</p></div><span class="power-badge" :class="protection.tone" role="status">{{ protection.label }}</span></div>
    <div class="power-row" :aria-label="ui.power.合盖运行状态"><div><strong>{{ ui.power.系统当前合盖策略 }}</strong><p>{{ lid.detail }}</p></div><span class="power-badge" :class="lid.tone" role="status">{{ lid.label }}</span></div>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <button class="text-button power-guide-button" :aria-expanded="guide" aria-controls="power-guide" @click="guide=!guide">{{ guide?ui.power.收起设置指引:ui.power.如何设置避免录制中断 }}</button>
    <div v-if="guide" id="power-guide" class="power-guide">
      <p><strong>{{ ui.power.熄屏后继续运行 }}</strong></p>
      <p v-if="status?.lid==='not-applicable'">{{ ui.power.台式机电源指引 }}</p>
      <p v-else>{{ ui.power.笔记本电源指引 }}</p>
      <p><strong>{{ ui.power.合盖后继续运行 }}</strong></p>
      <p>{{ ui.power.Mac合盖使用条件 }}</p>
      <p class="inline-warning">{{ ui.power.休眠中断录制提醒 }}</p>
      <button class="button small" :disabled="opening" @click="openSettings"><LoaderCircle v-if="opening" class="spin" :size="14"/><ExternalLink v-else :size="14"/>{{ ui.power.打开系统电源设置 }}</button>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
    <small v-if="checkedTime" class="power-footnote">{{ ui.power.最近检测 }} {{ checkedTime }}</small>
  </section>
</template>

<style scoped>
.power-settings{border:1px solid var(--line);border-radius:var(--radius-card);padding:14px;margin:16px 0;font-size:13px;color:var(--text);}
.power-heading,.power-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;}
.power-heading{align-items:center;flex-wrap:wrap;margin-bottom:6px;}
.power-row{padding:12px 0;border-bottom:1px solid var(--line);}
.power-row>div{min-width:0;flex:1;}.power-row p,.power-guide p{margin:7px 0;line-height:1.65;overflow-wrap:anywhere;}.power-row p,.power-footnote{color:var(--muted);}
.power-badge{flex-shrink:0;font-size:12px;border:1px solid var(--line);border-radius:var(--radius-card);padding:4px 8px;white-space:nowrap;}
.power-badge.good{color:var(--power-ok-ink);background:var(--power-ok-surface);border-color:var(--power-ok-edge);}.power-badge.warning{color:var(--power-warning-ink);background:var(--power-warning-surface);border-color:var(--power-warning-edge);}
.power-guide-button{margin:12px 0;}.power-guide{padding:0 0 12px;}.power-footnote{display:block;line-height:1.6;}
@media(max-width:480px){.power-row{flex-wrap:wrap;}.power-row>div{flex-basis:100%;}.power-heading .button{font-size:12px;}}
</style>
