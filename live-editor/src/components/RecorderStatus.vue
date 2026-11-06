<script setup>
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {ui} from '../../shared/ui-copy.js';
import {recorderStatusDetails} from '../recorder-status.js';
import PlatformBadge from './PlatformBadge.vue';
const props=defineProps({recorder:{type:Object,required:true},rooms:{type:Array,default:()=>[]},anchors:{type:Array,default:()=>[]},connected:Boolean,label:String});
const opened=ref(false),root=ref(null),trigger=ref(null);
const details=computed(()=>recorderStatusDetails(props.recorder,props.rooms,props.connected,props.anchors));
const roomPlatforms=computed(()=>details.value.filter(platform=>platform.rooms.length));
function outside(event){if(!root.value?.contains(event.target))opened.value=false;}
function escape(event){if(event.key==='Escape'&&opened.value){opened.value=false;event.stopPropagation();event.preventDefault();trigger.value?.focus();}}
onMounted(()=>{document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);});
onBeforeUnmount(()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);});
</script>
<template>
  <span ref="root" class="core-status-wrap">
    <button ref="trigger" type="button" class="core-status" :aria-expanded="opened" aria-controls="recorder-status-details" @keydown.stop @keydown.esc.prevent="opened=false" @click="opened=!opened"><i :class="{online:recorder.online}"/>{{ label }}</button>
    <span v-show="opened" class="recorder-status-backdrop" aria-hidden="true" @click="opened=false"/>
    <span v-show="opened" id="recorder-status-details" class="recorder-status-details">
      <span class="recorder-status-content">
      <span class="recorder-status-services">
        <span v-for="platform in details" :key="platform.platform" class="recorder-status-pill recorder-service-row" :title="platform.error">
          <PlatformBadge :platform="platform.platform" decorative/>
          <span class="recorder-status-text"><strong class="recorder-status-title">{{ platform.label }}</strong><span class="recorder-status-subtitle" :class="{'recorder-status-error':platform.failed}">{{ platform.status }}<template v-if="platform.idle"> · {{ platform.idle }}</template></span></span>
        </span>
      </span>
      <span v-if="roomPlatforms.length" class="recorder-status-rooms">
      <span v-for="platform in roomPlatforms" :key="platform.platform" class="recorder-platform-status" role="group" :aria-label="platform.label">
        <span v-for="room in platform.rooms" :key="room.id" class="recorder-status-pill recorder-room-row" :class="{'is-recording':room.video===ui.common.录制中}">
          <PlatformBadge :platform="platform.platform" decorative/>
          <span class="recorder-status-text"><strong class="recorder-status-title" :title="room.name">{{ room.name }}</strong><span class="recorder-status-subtitle"><span :class="{'recorder-status-error':room.videoFailed}" :title="room.videoHint">{{ ui.recorderStatus.视频录制 }}{{ room.video }}</span><span aria-hidden="true">·</span><span :class="{'recorder-status-error':room.chatFailed}" :title="room.chatHint">{{ ui.recorderStatus.弹幕采集 }}{{ room.chat }}</span></span></span>
        </span>
      </span>
      </span>
      </span>
    </span>
  </span>
</template>
