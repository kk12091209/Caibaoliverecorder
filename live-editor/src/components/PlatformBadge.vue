<script setup>
import { computed } from 'vue';
import bilibiliIcon from '../assets/platform-bilibili.svg';
import douyinIcon from '../assets/platform-douyin.svg';
import xiaohongshuIcon from '../assets/platform-xiaohongshu.svg';
import {platformLabel} from '../../shared/platforms.js';

const props = defineProps({
  platform: { type: String, required: true },
  compact: Boolean,
  decorative: Boolean,
});

const icon = computed(() => ({bilibili:bilibiliIcon,douyin:douyinIcon,xiaohongshu:xiaohongshuIcon})[props.platform]);
const label = computed(() => platformLabel(props.platform));
</script>

<template>
  <span
    class="platform-badge"
    :class="{ 'platform-badge--compact': compact }"
    :aria-hidden="decorative || undefined"
    :title="decorative ? undefined : label"
  >
    <img v-if="icon" :src="icon" :alt="decorative ? '' : label"/>
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
  border: 1px solid var(--platform-badge-edge);
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
