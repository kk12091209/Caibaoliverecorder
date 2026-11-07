<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ui } from '../../shared/ui-copy.js';
import { giftGeometry, giftPrice } from '../../shared/gifts.js';
import GiftIcon from './GiftIcon.vue';

const props = defineProps({ cards: { type: Array, default: () => [] }, video: Object, loading: Boolean });
const surface = ref(null);
const size = ref({ width: 0, height: 0, left: 0, top: 0 });
let observer;

function resize() {
  const parent = surface.value?.parentElement;
  if (!parent) return;
  const { clientWidth, clientHeight } = parent;
  const video = props.video;
  const scale = video?.videoWidth ? Math.min(clientWidth / video.videoWidth, clientHeight / video.videoHeight) : 1;
  const width = video?.videoWidth ? video.videoWidth * scale : clientWidth;
  const height = video?.videoHeight ? video.videoHeight * scale : clientHeight;
  size.value = { width, height, left: (clientWidth - width) / 2, top: (clientHeight - height) / 2 };
}

const surfaceStyle = computed(() => Object.fromEntries(
  Object.entries(size.value).map(([key, value]) => [key, value + 'px'])
));
const stackStyle = computed(() => {
  const { width, height } = size.value;
  const box = giftGeometry(width, height);
  return {
    left: box.x + 'px', top: box.y + 'px', width: box.w + 'px',
    gap: (8 * height / 720) + 'px', fontSize: box.size + 'px',
    '--gift-card-height': box.h + 'px',
    '--gift-icon-size': box.icon + 'px',
    '--gift-card-padding': box.pad + 'px',
  };
});

watch(() => [props.video, props.video?.videoWidth, props.loading], resize);
onMounted(() => {
  observer = new ResizeObserver(resize);
  observer.observe(surface.value.parentElement);
  resize();
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="surface" class="gift-surface" :style="surfaceStyle" :aria-label="ui.gifts.画面礼物">
    <div v-if="cards.length" class="gift-stack" :style="stackStyle">
      <article v-for="gift in cards" :key="gift.id" class="gift-card" :class="{ 'gift-card--super-chat': gift.type === 'sc' }">
        <template v-if="gift.type === 'sc'">
          <div class="gift-super-chat-header">
            <strong><span aria-hidden="true">✦ </span>{{ gift.name }}</strong>
            <strong>{{ giftPrice(gift) }}</strong>
          </div>
          <span class="gift-sender">{{ gift.user }}</span>
          <p v-if="gift.text" class="gift-comment">{{ gift.text }}</p>
        </template>
        <template v-else>
          <GiftIcon :gift="gift" class="gift-card-icon"/>
          <div class="gift-details">
            <strong>{{ gift.user }}</strong>
            <span>{{ gift.name }} × {{ gift.count }} · {{ giftPrice(gift) }}</span>
          </div>
        </template>
      </article>
    </div>
  </div>
</template>

<style scoped>
.gift-surface { position: absolute; pointer-events: none; overflow: hidden; z-index: 5; }
.gift-stack { position: absolute; display: grid; }
.gift-card {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--gift-card-padding);
  min-height: var(--gift-card-height);
  min-width: 0;
  padding: var(--gift-card-padding);
  background: #372535ce;
  border-radius: var(--radius-control);
  color: white;
  line-height: 1.3;
}
.gift-card strong { font-weight: 600; }
.gift-card .gift-card-icon { width: var(--gift-icon-size); height: var(--gift-icon-size); flex-shrink: 0; }
.gift-details { display: grid; gap: 3px; min-width: 0; }
.gift-details > *, .gift-sender { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gift-card.gift-card--super-chat {
  display: grid;
  gap: .25em;
  background: rgba(255, 227, 205, .88);
  outline: 1px solid rgba(205, 151, 116, .52);
  outline-offset: -1px;
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  backdrop-filter: blur(20px) saturate(140%);
  box-shadow: 0 1px 5px rgba(74, 36, 50, .10);
  color: #4a2432;
}
.gift-super-chat-header { display: flex; justify-content: space-between; gap: .5em; }
.gift-super-chat-header span { color: #e23b62; }
.gift-sender { font-size: .85em; color: #7d4b5c; }
.gift-comment {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-line;
  margin: 0;
}
</style>
