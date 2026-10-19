<script setup>
import {computed,ref} from 'vue';
import {adjustDanmakuArea,MIN_DANMAKU_AREA_HEIGHT} from '../../shared/danmaku-style.js';

const props=defineProps({areaTop:{type:Number,default:0},areaHeight:{type:Number,default:1},disabled:Boolean});
const emit=defineEmits(['change','dragging']);
const surface=ref(null),drag=ref(null);
const percent=value=>Number((value*100).toFixed(1));
const frameStyle=computed(()=>({top:props.areaTop*100+'%',height:props.areaHeight*100+'%'}));
function start(event,action){
  if(props.disabled||drag.value||event.button!==0||!event.isPrimary)return;
  const height=surface.value.getBoundingClientRect().height;
  if(!height)return;
  event.preventDefault();event.currentTarget.focus();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.value={action,id:event.pointerId,y:event.clientY,height,areaTop:props.areaTop,areaHeight:props.areaHeight};
  emit('dragging',true);
}
function move(event){
  if(!drag.value||drag.value.id!==event.pointerId||props.disabled)return;
  emit('change',adjustDanmakuArea(drag.value,drag.value.action,(event.clientY-drag.value.y)/drag.value.height));
}
function finish(event){
  if(!drag.value||drag.value.id!==event.pointerId)return;
  drag.value=null;emit('dragging',false);
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
}
function keyboard(event,action){
  if(props.disabled)return;
  let delta;
  if(event.key==='ArrowUp')delta=event.shiftKey ? -.1 : -.01;
  else if(event.key==='ArrowDown')delta=event.shiftKey ? .1 : .01;
  else if(event.key==='Home')delta=-1;
  else if(event.key==='End')delta=1;
  else return;
  event.preventDefault();event.stopPropagation();
  emit('change',adjustDanmakuArea(props,action,delta));
}
</script>

<template>
  <div ref="surface" class="area-selector" :class="{'is-dragging':drag,'is-disabled':disabled}">
    <div class="area-frame" :style="frameStyle" :data-area-top="areaTop" :data-area-height="areaHeight">
      <button type="button" class="area-move" role="slider" aria-label="弹幕展示区域位置" aria-orientation="vertical" :aria-valuemin="0" :aria-valuemax="percent(1-areaHeight)" :aria-valuenow="percent(areaTop)" :aria-valuetext="'顶部 '+percent(areaTop)+'%，高度 '+percent(areaHeight)+'%'" :disabled="disabled" title="按住拖动，或用上下方向键调整位置" @pointerdown="start($event,'move')" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="keyboard($event,'move')"><span>拖动调整位置</span></button>
      <button type="button" class="area-handle top" role="slider" aria-label="弹幕展示区域上边界" aria-orientation="vertical" :aria-valuemin="0" :aria-valuemax="percent(areaTop+areaHeight-MIN_DANMAKU_AREA_HEIGHT)" :aria-valuenow="percent(areaTop)" :disabled="disabled" title="拖动上边界调整高度，或使用上下方向键" @pointerdown="start($event,'top')" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="keyboard($event,'top')"><span></span></button>
      <button type="button" class="area-handle bottom" role="slider" aria-label="弹幕展示区域下边界" aria-orientation="vertical" :aria-valuemin="percent(areaTop+MIN_DANMAKU_AREA_HEIGHT)" :aria-valuemax="100" :aria-valuenow="percent(areaTop+areaHeight)" :disabled="disabled" title="拖动下边界调整高度，或使用上下方向键" @pointerdown="start($event,'bottom')" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="keyboard($event,'bottom')"><span></span></button>
    </div>
  </div>
</template>

<style scoped>
.area-selector{position:absolute;inset:0;pointer-events:none;user-select:none}
.area-frame{position:absolute;left:0;right:0;box-shadow:0 0 0 100vmax #17100e80;outline:1px solid #ffffff70;outline-offset:-1px}
.area-frame:hover,.area-frame:focus-within,.is-dragging .area-frame{outline-color:#ffffffb3}
.area-frame button{appearance:none;margin:0;box-shadow:none;border:0;pointer-events:auto;touch-action:none;color:#fff;font:inherit}
.area-move{position:absolute;inset:0;width:100%;height:100%;padding:0;border-radius:0;background:transparent;cursor:grab}
.area-move span{position:absolute;left:10px;top:10px;padding:4px 7px;border-radius:4px;background:#392a26bf;font-size:11px;opacity:0;transition:opacity .12s}
.area-move:hover span,.area-move:focus-visible span,.is-dragging .area-move span{opacity:1}
.is-dragging .area-move{cursor:grabbing}
.area-frame .area-handle{position:absolute;left:50%;transform:translateX(-50%);width:80px;height:30px;max-height:50%;padding:0;display:grid;place-items:center;background:transparent;cursor:ns-resize;border-radius:4px}
.area-handle.top{top:0}.area-handle.bottom{bottom:0}
.area-handle span{display:block;width:32px;height:2px;border-radius:2px;background:#fff;box-shadow:0 1px 2px #0006;opacity:.65;transition:opacity .12s,width .12s,height .12s}
.area-handle:hover span,.area-handle:focus-visible span,.area-handle:active span{width:40px;height:3px;opacity:1}
.area-frame button:focus-visible{outline:2px solid #fff;outline-offset:-4px}
.is-disabled .area-frame button{cursor:default;pointer-events:none}
@media(pointer:coarse){.area-frame .area-handle{width:96px;height:36px}}
</style>
