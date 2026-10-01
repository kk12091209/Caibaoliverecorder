<script setup>
import {ref,computed,watch,onMounted,onBeforeUnmount} from 'vue';
import {aggregateAudio,aggregateDensity,audioStateLabel,densityStateLabel,timeAtPixel,windowPercent} from '../timeline-signals.js';

const props=defineProps({kind:{type:String,default:'audio'},audio:Object,density:Object,from:{type:Number,default:0},to:{type:Number,default:0},dataFrom:{type:Number,default:0},dataTo:{type:Number,default:0},position:{type:Number,default:0},selected:Boolean,loading:Boolean,error:String,disabled:Boolean});
const emit=defineEmits(['seek']);
const host=ref(null),canvas=ref(null),width=ref(0);let observer,frame=0;
const label=computed(()=>props.kind==='audio'?audioStateLabel(props.audio,{selected:props.selected,loading:props.loading,error:props.error}):'弹幕密度');
const densityHint=computed(()=>densityStateLabel(props.density,{selected:props.selected,error:props.error}));
const cursor=computed(()=>props.position>=props.from&&props.position<=props.to?windowPercent(props.position,props.from,props.to):null);
const currentValue=computed(()=>Math.min(props.to,Math.max(props.from,props.position)));
function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
function draw() {
  const element=canvas.value;if(!element||!width.value)return;
  const w=width.value,h=props.kind==='audio'?36:40,dpr=Math.min(2,window.devicePixelRatio||1);
  const pixelWidth=Math.round(w*dpr),pixelHeight=Math.round(h*dpr);
  if(element.width!==pixelWidth||element.height!==pixelHeight){element.width=pixelWidth;element.height=pixelHeight;}
  const context=element.getContext('2d');if(!context)return;
  context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,w,h);
  if(props.to<=props.from)return;
  const dataFrom=props.kind==='density'?(props.density?.from??props.dataFrom):props.dataFrom;
  const dataTo=props.kind==='density'?(props.density?.to??props.dataTo):props.dataTo;
  const start=(dataFrom-props.from)/(props.to-props.from)*w,span=(dataTo-dataFrom)/(props.to-props.from)*w;
  if(!(span>0))return;
  context.save();context.beginPath();context.rect(0,0,w,h);context.clip();
  if(props.kind==='audio') {
    const bins=aggregateAudio(props.audio?.bins,Math.max(1,Math.min(w,span)/2));
    for(let i=0;i<bins.length;i++) {
      const bin=bins[i],x=start+i*span/bins.length,bw=Math.max(1,span/bins.length-1);
      if(bin.state==='ready'||bin.state==='silent') {
        const peak=Math.max(.65,Math.sqrt(bin.peak)*(h/2-4)),rms=Math.max(.5,Math.sqrt(bin.rms)*(h/2-4));
        context.fillStyle='rgba(255,183,196,.95)';context.fillRect(x,h/2-peak,bw,peak*2);
        context.fillStyle='rgba(255,125,146,.95)';context.fillRect(x,h/2-rms,bw,rms*2);
      }
      if(bin.state==='pending'||bin.pending){context.fillStyle='rgba(255,125,146,.28)';context.fillRect(x,h-3,bw,2);}
      if(bin.state==='unavailable'){context.fillStyle='rgba(218,79,62,.35)';context.fillRect(x,h/2-.5,bw,1);}
    }
  } else {
    const bins=aggregateDensity(props.density?.bins,Math.max(1,Math.min(w,span)/3)),max=Math.max(1,...bins),scale=Math.log1p(max);
    context.fillStyle='rgba(255,125,146,.9)';
    for(let i=0;i<bins.length;i++){const height=Math.log1p(bins[i])/scale*25;if(height>0)context.fillRect(start+i*span/bins.length,h-3-height,Math.max(1,span/bins.length-1),height);}
  }
  context.restore();
}
function seek(event){if(props.disabled||props.to<=props.from)return;const rect=host.value.getBoundingClientRect();emit('seek',timeAtPixel(event.clientX-rect.left,rect.width,props.from,props.to));}
function keySeek(event){
  if(props.disabled)return;const step=event.shiftKey?10:1;
  const value=event.key==='Home'?props.from:event.key==='End'?props.to:event.key==='ArrowLeft'?currentValue.value-step:event.key==='ArrowRight'?currentValue.value+step:null;
  if(value!==null){event.preventDefault();event.stopPropagation();emit('seek',Math.min(props.to,Math.max(props.from,value)));}
}
watch(()=>[props.audio,props.density,props.from,props.to,props.dataFrom,props.dataTo,width.value],schedule);
onMounted(()=>{observer=new ResizeObserver(entries=>{width.value=entries[0]?.contentRect.width||0;schedule();});observer.observe(host.value);schedule();});
onBeforeUnmount(()=>{observer?.disconnect();if(frame)cancelAnimationFrame(frame);});
</script>

<template>
  <div ref="host" :class="['timeline-signal','signal-'+kind,{disabled}]" :role="kind==='density'?'slider':undefined" :tabindex="kind==='density'&&!disabled?0:undefined" :aria-label="kind==='density'?'弹幕密度定位':label" :aria-disabled="kind==='density'?disabled:undefined" :aria-valuemin="kind==='density'?from:undefined" :aria-valuemax="kind==='density'?to:undefined" :aria-valuenow="kind==='density'?currentValue:undefined" :title="kind==='density'?'有效弹幕越密集，柱形越高；点击定位画面':error||label" @click="kind==='density'&&seek($event)" @keydown="kind==='density'&&keySeek($event)">
    <canvas ref="canvas" aria-hidden="true"/>
    <span class="signal-caption">{{ label }}</span><span v-if="kind==='density'&&densityHint" class="signal-hint">{{ densityHint }}</span>
    <i v-if="kind==='density'&&cursor!==null" class="signal-cursor" :style="{left:cursor+'%'}"/>
  </div>
</template>
