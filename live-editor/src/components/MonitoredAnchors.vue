<script setup>
import { ui } from '../../shared/ui-copy.js';

import {X,CornerDownRight,LoaderCircle} from 'lucide-vue-next';
import {roomAvailable,roomStatus} from '../room-status.js';
defineProps({anchors:{type:Array,default:()=>[]},recorder:{type:Object,required:true},busy:{type:Array,default:()=>[]}});
defineEmits(['action','remove']);
const rawStatus=anchor=>anchor.legacy?roomStatus(anchor):anchor.state||'';
function status(anchor){
  const value=rawStatus(anchor);
  if(/正在恢复|重试|正在重连/.test(value))return ui.anchors.正在恢复录制;
  if(/上限/.test(value))return ui.anchors.已达时长上限;
  if(/待确认|疑似|失联/.test(value))return anchor.recording?ui.anchors.录制中待确认:ui.anchors.等待恢复;
  if(anchor.recording)return anchor.kind==='guest'?ui.anchors.连麦录制中:ui.anchors.直播录制中;
  return anchor.enabled?ui.anchors.监控中:ui.common.已停止;
}
const warning=anchor=>anchor.error||anchor.chatError||(/待确认|疑似|失联|上限|正在恢复|重试|正在重连/.test(rawStatus(anchor))?rawStatus(anchor):'');
const identity=anchor=>(anchor.platform==='douyin'?ui.common.抖音:ui.common.B站)+(anchor.ownWebRid?ui.anchors.本人直播间+anchor.ownWebRid:'');
</script>
<template>
  <div v-if="!anchors.length" class="rail-empty">{{ ui.anchors.粘贴直播间或抖音名片 }}</div>
  <article v-for="anchor in anchors" :key="anchor.key" class="monitored-anchor" :data-recording="anchor.recording" :aria-label="ui.anchors.监控主播+anchor.name">
    <div class="anchor-heading"><strong :title="anchor.name">{{ anchor.name||ui.anchors.主播 }}</strong><button class="anchor-remove" :aria-label="ui.anchors.移除监控+anchor.name" :title="ui.common.移除监控主播" :disabled="busy.includes(anchor.key)||!roomAvailable(anchor,recorder)" @click="$emit('remove',anchor)"><X :size="14" aria-hidden="true"/></button></div>
    <div class="anchor-summary">
      <div class="anchor-state"><span class="anchor-platform" :title="identity(anchor)">{{ anchor.platform==='douyin'?ui.common.抖音:ui.common.B站 }}</span><span class="anchor-status" role="status" :title="rawStatus(anchor)"><i :class="{'is-recording':anchor.recording,'is-enabled':anchor.enabled}" aria-hidden="true"/>{{ status(anchor) }}</span></div>
      <button class="anchor-toggle" :class="{'is-stopped':!anchor.enabled}" :disabled="busy.includes(anchor.key)||!roomAvailable(anchor,recorder)" :aria-label="(anchor.enabled?ui.anchors.停止监控:ui.anchors.开始监控)+anchor.name" @click="$emit('action',anchor,anchor.enabled?'stop':'start')"><LoaderCircle v-if="busy.includes(anchor.key)" :size="12" class="spin" aria-hidden="true"/><span>{{ anchor.enabled?ui.anchors.停止:ui.anchors.开始 }}</span></button>
    </div>
    <div v-if="anchor.kind==='guest'&&anchor.host" class="anchor-destination" :title="ui.anchors.连麦至+anchor.host+ui.anchors.的直播间"><CornerDownRight :size="13" aria-hidden="true"/><span>{{ ui.anchors.连麦至连麦至 }} <strong>{{ anchor.host }}</strong></span></div>
    <p v-if="warning(anchor)" class="anchor-warning" role="status">{{ warning(anchor) }}</p>
  </article>
</template>
<style scoped>
.monitored-anchor{margin-top:9px;padding:10px 11px;background:var(--card);border:1px solid var(--line);border-radius:10px;min-width:0}
.monitored-anchor[data-recording=true]{border-color:rgba(218,79,62,.3)}
.anchor-heading{display:flex;align-items:center;gap:6px;min-width:0}
.anchor-heading strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:650;line-height:1.6}
.anchor-remove{display:grid;place-items:center;width:24px;height:24px;flex-shrink:0;margin-right:-4px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--faint)}
.anchor-remove:hover{background:rgba(122,62,82,.08);color:var(--text)}
.anchor-summary{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:5px;min-height:26px}
.anchor-state{display:flex;flex-wrap:wrap;align-items:center;gap:5px 7px;min-width:0}
.anchor-platform{font-size:10px;line-height:17px;padding:0 4px;border-radius:4px;background:rgba(122,62,82,.06);color:var(--muted);white-space:nowrap}
.anchor-status{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;color:var(--muted)}
.anchor-status i{width:5px;height:5px;flex-shrink:0;border-radius:50%;background:var(--faint);opacity:.6}
.anchor-status i.is-enabled{background:#aa6d25;opacity:1}.anchor-status i.is-recording{background:var(--rose);opacity:1}
.anchor-toggle{display:inline-flex;align-items:center;justify-content:center;gap:3px;flex-shrink:0;min-height:26px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:transparent;font-size:11px;line-height:18px;color:var(--muted)}
.anchor-toggle:hover{background:rgba(122,62,82,.06);border-color:var(--line-strong)}.anchor-toggle.is-stopped{color:#bd465a;background:rgba(255,125,146,.08);border-color:rgba(189,70,90,.22)}
.anchor-destination{display:flex;align-items:flex-start;gap:5px;margin-top:5px;padding-top:6px;border-top:1px solid var(--line);color:var(--muted);font-size:11px;line-height:1.55}
.anchor-destination svg{flex-shrink:0;margin-top:2px;color:var(--faint)}.anchor-destination span{min-width:0;overflow-wrap:anywhere}.anchor-destination strong{font-weight:500;color:var(--text)}
.anchor-warning{font-size:11px;line-height:1.55;color:#9d4a32;margin:7px 0 0;overflow-wrap:anywhere}
</style>
