<script setup>
import { computed } from 'vue';
import { normalizedTimestampStyle, normalizedTimestampPosition } from '../../shared/timestamp-style.js';

const props=defineProps({label:{type:String,required:true},variant:String,position:String});
const styleName=computed(()=>normalizedTimestampStyle(props.variant));
</script>

<template>
  <time class="timestamp-text" :class="`timestamp-${styleName}`" :data-position="normalizedTimestampPosition(position)" :datetime="label.replace(' ','T')+'+08:00'" :aria-label="label">
    <span class="timestamp-date">{{ label.slice(0,10) }}</span>
    <span class="timestamp-clock">{{ label.slice(11) }}</span>
  </time>
</template>

<style scoped>
.timestamp-text{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:2px .45em;width:max-content;max-width:100%;box-sizing:border-box;color:#fff;background:transparent;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:inherit;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.35;text-shadow:-1px 0 1px #000,1px 0 1px #000,0 -1px 1px #000,0 1px 1px #000,0 1px 3px #000;}
.timestamp-date,.timestamp-clock{white-space:nowrap;}
.timestamp-inline .timestamp-date{font-size:.9em;font-weight:500;padding-right:.55em;border-right:1px solid #ffffffb3;}
.timestamp-inline .timestamp-clock{font-size:1.14em;font-weight:700;}
.timestamp-stacked{flex-direction:column;align-items:flex-start;gap:0;}
.timestamp-stacked .timestamp-date{font-size:.82em;font-weight:500;}
.timestamp-stacked .timestamp-clock{font-size:1.3em;}
.timestamp-text[data-position$="right"]{justify-content:flex-end;}
.timestamp-stacked[data-position$="right"]{align-items:flex-end;}
</style>
