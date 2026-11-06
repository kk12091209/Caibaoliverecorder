<script setup>
import { computed } from 'vue';
import { ui } from '../../shared/ui-copy.js';
import bilibiliIcon from '../assets/platform-bilibili.svg';
import douyinIcon from '../assets/platform-douyin.svg';

const props = defineProps({
  platform: { type: String, required: true },
  compact: Boolean,
  decorative: Boolean,
});

const isDouyin = computed(() => props.platform === 'douyin');
const label = computed(() => isDouyin.value ? ui.common.抖音 : ui.common.B站);
</script>

<template>
  <span
    class="platform-badge"
    :class="{ 'platform-badge--compact': compact }"
    :aria-hidden="decorative || undefined"
    :title="decorative ? undefined : label"
  >
    <img :src="isDouyin ? douyinIcon : bilibiliIcon" :alt="decorative ? '' : label"/>
  </span>
</template>

<style scoped>
.platform-badge {
  --badge-size: 34px;
  --badge-icon-size: 22px;
  display: grid;
  place-items: center;
  flex: 0 0 var(--badge-size);
  width: var(--badge-size);
  height: var(--badge-size);
  border: 1px solid rgba(255, 255, 255, .4);
  border-radius: 50%;
  background: var(--panel);
}
.platform-badge--compact {
  --badge-size: 24px;
  --badge-icon-size: 16px;
}
.platform-badge img {
  display: block;
  width: var(--badge-icon-size);
  height: var(--badge-icon-size);
}
</style>
