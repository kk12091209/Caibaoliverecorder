<script setup>
import { ChevronDown } from 'lucide-vue-next';

defineProps({ name: String, title: String });
const open = defineModel('open', { type: Boolean });
</script>

<template>
  <section class="settings-group">
    <h3>
      <button
        :id="`settings-${name}-title`"
        type="button"
        class="settings-group-toggle"
        :aria-expanded="!!open"
        :aria-controls="`settings-${name}-body`"
        @click="open = !open"
      >
        {{ title }}
        <ChevronDown :size="16" aria-hidden="true"/>
      </button>
    </h3>
    <div v-show="open" :id="`settings-${name}-body`" class="settings-group-body">
      <slot/>
    </div>
  </section>
</template>
