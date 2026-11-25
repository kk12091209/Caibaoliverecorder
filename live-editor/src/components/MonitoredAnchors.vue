<script setup>
import { ui } from '../../shared/ui-copy.js';
import {computed} from 'vue';
import {MoreHorizontal,LoaderCircle} from 'lucide-vue-next';
import {monitoredAnchorStatus,roomAvailable} from '../room-status.js';
import PlatformBadge from './PlatformBadge.vue';
const props=defineProps({anchors:{type:Array,default:()=>[]},recorder:{type:Object,required:true},busy:{type:Array,default:()=>[]},menuKey:{type:String,default:''}});
defineEmits(['action','menu']);
const cards=computed(()=>props.anchors.map(anchor=>({anchor,...monitoredAnchorStatus(anchor)})));
const roomNumber=anchor=>anchor.ownWebRid||(anchor.platform==='douyin'?(anchor.legacy?anchor.webRid:''):anchor.roomId)||'—';
</script>
<template>
  <article
    v-for="{anchor,recording,label,detail,warning} in cards"
    :key="anchor.key"
    class="monitored-anchor"
    :data-recording="recording"
    :aria-label="ui.anchors.监控主播+anchor.name"
    @contextmenu.prevent.stop="$emit('menu',$event,anchor)"
    @click.ctrl.exact.capture.prevent.stop="$emit('menu',$event,anchor)"
    @keydown.shift.f10.prevent.stop="$emit('menu',$event,anchor)"
    @keydown.context-menu.prevent.stop="$emit('menu',$event,anchor)"
  >
    <div class="anchor-heading">
      <PlatformBadge :platform="anchor.platform" compact/>
      <strong :title="anchor.name">{{ anchor.name||ui.anchors.主播 }}</strong>
      <button
        type="button"
        class="anchor-menu-trigger"
        :aria-label="ui.anchors.监控主播+anchor.name+' · '+ui.anchors.主播操作"
        :title="ui.anchors.主播操作"
        :aria-expanded="menuKey===anchor.key"
        aria-haspopup="menu"
        @pointerdown.stop
        @click="$emit('menu',$event,anchor)"
      ><MoreHorizontal :size="16" aria-hidden="true"/></button>
    </div>
    <div class="anchor-room">{{ ui.anchors.本人直播间 }}{{ roomNumber(anchor) }}</div>
    <div class="anchor-summary">
      <div class="anchor-state"><span class="anchor-status" role="status" :title="detail"><i :class="{'is-recording':recording,'is-enabled':anchor.enabled}" aria-hidden="true"/>{{ label }}</span></div>
      <button class="anchor-toggle" :class="{'is-stopped':!anchor.enabled}" :disabled="busy.includes(anchor.key)||!roomAvailable(anchor,recorder)" :aria-label="(anchor.enabled?ui.anchors.停止监控:ui.anchors.开始监控)+anchor.name" @click="$emit('action',anchor,anchor.enabled?'stop':'start')"><LoaderCircle v-if="busy.includes(anchor.key)" :size="12" class="spin" aria-hidden="true"/><span>{{ anchor.enabled?ui.anchors.停止:ui.anchors.开始 }}</span></button>
    </div>
    <p v-if="warning" class="anchor-warning" role="status">{{ warning }}</p>
  </article>
</template>
<style scoped>
.monitored-anchor{margin-top:9px;padding:10px 11px;background:var(--monitor-surface, var(--card));color:var(--monitor-ink, inherit);border:1px solid var(--monitor-edge, var(--line));border-radius:var(--radius-card);min-width:0}
.monitored-anchor[data-recording=true]{border-color:var(--monitor-live-edge, var(--line-strong))}
.anchor-heading{display:flex;align-items:center;gap:6px;min-width:0}
.anchor-heading strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:1.6}
.anchor-room{margin-top:2px;font-size:11px;line-height:1.6;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.anchor-menu-trigger{display:grid;place-items:center;width:24px;height:24px;flex-shrink:0;margin-right:-4px;padding:0;border:0;border-radius:var(--radius-control);background:transparent;color:var(--faint)}
.anchor-menu-trigger:hover{background:var(--anchor-remove-hover);color:var(--text)}
.anchor-summary{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:5px;min-height:26px}
.anchor-state{display:flex;flex-wrap:wrap;align-items:center;gap:5px 7px;min-width:0}
.anchor-status{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;color:var(--muted)}
.anchor-status i{width:5px;height:5px;flex-shrink:0;border-radius:50%;background:var(--faint);opacity:.6}
.anchor-status i.is-enabled{background:var(--icon);opacity:1}.anchor-status i.is-recording{background:var(--danger);opacity:1}
.anchor-toggle{display:inline-flex;align-items:center;justify-content:center;gap:3px;flex-shrink:0;min-height:26px;padding:3px 6px;border:1px solid var(--monitor-control-edge, var(--line));border-radius:var(--radius-control);background:var(--monitor-control-surface, transparent);font-size:11px;line-height:18px;color:var(--monitor-control-ink, var(--muted))}
.anchor-toggle:hover{background:var(--anchor-toggle-hover);border-color:var(--line-strong)}.anchor-toggle.is-stopped{color:var(--accent-dark);background:var(--selected);border-color:var(--monitor-control-edge, var(--anchor-start-edge))}
.anchor-warning{font-size:11px;line-height:1.55;color:var(--warning-text);margin:7px 0 0;overflow-wrap:anywhere}
</style>
