<script setup>
import {ref,computed,watch,onMounted,onBeforeUnmount} from 'vue';
import {giftCards,giftGeometry,giftPrice} from '../../shared/gifts.js';
import GiftIcon from './GiftIcon.vue';
const props=defineProps({events:Array,time:Number,enabled:Boolean,video:Object,loading:Boolean});
const surface=ref(null),size=ref({width:0,height:0,left:0,top:0});let observer;
function resize(){const parent=surface.value?.parentElement;if(!parent)return;const w=parent.clientWidth,h=parent.clientHeight,v=props.video;
  const scale=v?.videoWidth?Math.min(w/v.videoWidth,h/v.videoHeight):1,width=v?.videoWidth?v.videoWidth*scale:w,height=v?.videoHeight?v.videoHeight*scale:h;
  size.value={width,height,left:(w-width)/2,top:(h-height)/2};}
const cards=computed(()=>props.enabled&&!props.loading?giftCards(props.events||[],props.time||0):[]);
const geometry=lane=>giftGeometry(size.value.width,size.value.height,lane);
const cardStyle=lane=>{const g=geometry(lane);return {left:g.x+'px',top:g.y+'px',width:g.w+'px',height:g.h+'px',padding:g.pad+'px',gap:g.pad+'px',fontSize:g.size+'px'};};
watch(()=>[props.video,props.video?.videoWidth,props.loading],resize);
onMounted(()=>{observer=new ResizeObserver(resize);observer.observe(surface.value.parentElement);resize();});
onBeforeUnmount(()=>observer?.disconnect());
</script>
<template><div ref="surface" class="gift-surface" :style="{left:size.left+'px',top:size.top+'px',width:size.width+'px',height:size.height+'px'}" aria-label="画面礼物"><div v-for="(gift,lane) in cards" :key="gift.id" class="gift-card" :style="cardStyle(lane)"><GiftIcon :gift="gift" :style="{width:geometry(lane).icon+'px',height:geometry(lane).icon+'px'}"/><div><strong>{{ gift.user }}</strong><span>{{ gift.name }} × {{ gift.count }} · {{ giftPrice(gift) }}</span></div></div></div></template>
<style scoped>.gift-surface{position:absolute;pointer-events:none;overflow:hidden;z-index:5}.gift-card{position:absolute;box-sizing:border-box;display:flex;align-items:center;background:#372535ce;border-radius:6px;color:white;line-height:1.3}.gift-card>div{min-width:0;display:grid;gap:3px}.gift-card strong,.gift-card span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gift-card strong{font-weight:600}</style>
