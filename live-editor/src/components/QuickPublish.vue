<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { LoaderCircle } from 'lucide-vue-next';
import { ui } from '../../shared/ui-copy.js';
import { api } from '../api.js';
import { preventImplicitPublication, publicationAccountLabel, publicationModes, publicationStatus, publicationTransferLabel, publicationValidation } from '../bilibili-publication.js';
import PublicationTags from './PublicationTags.vue';
import PublicationCopyright from './PublicationCopyright.vue';
import PublicationCategory from './PublicationCategory.vue';

const props = defineProps({ jobId: { type: String, required: true } });
const emit = defineEmits(['busy', 'changed', 'close']);
const copy = ui.autoPost;
const route = `jobs/${encodeURIComponent(props.jobId)}/quick-publish`;
const request = new AbortController();
const loading = ref(true);
const loaded = ref(false);
const working = ref(false);
const error = ref('');
const accountError = ref('');
const title = ref('');
const description = ref('');
const tags = ref([]);
const tagInput = ref(null);
const categoryId = ref('');
const categoryValid = ref(false);
const copyright = ref('');
const source = ref('');
const mode = ref('');
const available = ref([]);
const account = ref(null);
const publication = ref(null);
const titleInput = ref(null);
let pollTimer;

const activeStatuses = ['submitting', 'uploading'];
const active = computed(() => activeStatuses.includes(publication.value?.status));
const locked = computed(() => working.value || active.value || ['submitted', 'uncertain'].includes(publication.value?.status)
  || (publication.value?.status === 'failed' && !publication.value.canRetry));
const variants = computed(() => publicationModes.filter(option => available.value.includes(option.id)));
const accountLabel = computed(() => publicationAccountLabel(account.value));
const validationError = computed(() => publicationValidation({
  title: title.value.trim(), tags: tags.value, copyright: copyright.value, source: source.value,
}));
const canPublish = computed(() => !locked.value && !!account.value?.uid && !accountError.value
  && !!title.value.trim() && available.value.includes(mode.value) && categoryValid.value && !validationError.value);

async function readDetails({ hydrate = false } = {}) {
  const details = await api(route, undefined, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]) });
  account.value = details.account || null;
  accountError.value = details.accountError || '';
  publication.value = details.publication || null;
  if (hydrate) {
    title.value = details.title || '';
    description.value = details.description || '';
    tags.value = details.tags ?? [];
    categoryId.value = String(details.categoryId ?? '');
    copyright.value = details.copyright ? Number(details.copyright) : '';
    source.value = details.source || '';
    available.value = details.availableModes || [];
    mode.value = available.value.includes(details.mode) ? details.mode : available.value[0] || '';
    loaded.value = true;
  }
  return details;
}

function continuePolling() {
  clearTimeout(pollTimer);
  if (active.value && !request.signal.aborted) pollTimer = setTimeout(pollStatus, 2000);
}

async function pollStatus() {
  try {
    await readDetails();
    error.value = '';
    emit('changed');
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause.message;
  } finally {
    continuePolling();
  }
}

async function submit() {
  if (!canPublish.value) return;
  if (!tagInput.value.commit()) return;
  working.value = true;
  emit('busy', true);
  error.value = '';
  try {
    const response = await api(route, {
      title: title.value.trim(), description: description.value.trim(), tags: tags.value,
      categoryId: categoryId.value, copyright: copyright.value, source: copyright.value === 2 ? source.value.trim() : '',
      mode: mode.value, accountUid: String(account.value.uid),
    }, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]) });
    publication.value = response.publication || null;
    emit('changed');
  } catch (cause) {
    if (request.signal.aborted) return;
    error.value = cause.message;
    try { await readDetails(); emit('changed'); } catch { /* The next open can load the saved task. */ }
  } finally {
    working.value = false;
    emit('busy', false);
    continuePolling();
  }
}

onMounted(async () => {
  try {
    await readDetails({ hydrate: true });
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause.message;
  } finally {
    loading.value = false;
  }
  if (loaded.value) {
    continuePolling();
    await nextTick();
    titleInput.value?.focus({ preventScroll: true });
  }
});
onBeforeUnmount(() => { request.abort(); clearTimeout(pollTimer); });
</script>

<template>
  <p v-if="loading" role="status">{{ copy.读取成片 }}</p>
  <p v-else-if="!loaded && error" class="inline-warning" role="alert">{{ error }}</p>
  <form v-if="loaded" class="quick-publish-settings" @submit.prevent="submit" @keydown.enter="preventImplicitPublication">
    <p v-if="accountLabel" class="export-target">{{ copy.投稿账号(accountLabel) }}</p>
    <p v-if="accountError || !accountLabel" class="inline-warning" role="alert">{{ accountError || copy.投稿账号不可用 }}</p>
    <div v-if="publication" class="setting-info" role="status" :data-publish-status="publication.status">
      <strong>{{ publicationStatus(publication.status) }}</strong>
      <small v-if="publication.transfer">{{ publicationTransferLabel(publication.transfer) }}</small>
      <span v-if="publication.bvid || publication.aid">{{ copy.稿件编号(publication.bvid || publication.aid) }}</span>
      <progress v-if="active && Number.isFinite(publication.progress)" :value="publication.progress" max="1" :aria-label="copy.上传中"/>
      <span v-if="publication.error">{{ publication.error }}</span>
      <small v-if="publication.status === 'uncertain'">{{ copy.请到创作中心确认 }}</small>
    </div>
    <fieldset class="quick-publish-fields" :disabled="locked">
      <label class="field-label" for="quick-publish-title">
        {{ copy.标题 }}
        <input id="quick-publish-title" ref="titleInput" v-model="title" required maxlength="80"/>
      </label>
      <label class="field-label" for="quick-publish-description">
        {{ copy.简介 }}
        <textarea id="quick-publish-description" v-model="description" rows="2" maxlength="2000"/>
      </label>
      <PublicationTags ref="tagInput" v-model="tags" input-id="quick-publish-tags"/>
      <PublicationCategory v-model="categoryId" :account-uid="account?.uid && !accountError ? String(account.uid) : ''" @valid="categoryValid = $event"/>
      <PublicationCopyright v-model:copyright="copyright" v-model:source="source" field-prefix="quick-publish" required/>
      <fieldset class="quick-publish-versions">
        <legend>{{ copy.投稿版本 }}</legend>
        <label v-for="option in variants" :key="option.id" class="checkbox">
          <input v-model="mode" type="radio" name="quick-publish-mode" :value="option.id"/>
          {{ option.label }}
        </label>
        <p v-if="mode === 'dual'" class="muted">{{ copy.分P预览 }}</p>
      </fieldset>
    </fieldset>
    <p v-if="error || (!locked && validationError)" class="inline-warning" role="alert">{{ error || validationError }}</p>
    <div class="confirm-actions">
      <button type="button" class="button" :disabled="working" @click="emit('close')">{{ locked ? ui.common.关闭 : ui.common.取消 }}</button>
      <button v-if="!locked || working" type="submit" class="button primary" :disabled="!canPublish">
        <LoaderCircle v-if="working" :size="16" class="spin" aria-hidden="true"/>
        {{ working ? copy.正在提交 : copy.提交B站审核 }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.quick-publish-fields, .quick-publish-versions { border: 0; padding: 0; margin: 0; min-width: 0; }
.quick-publish-fields .field-label { margin-block: 12px; }
.quick-publish-versions { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.quick-publish-versions legend { font-size: 12px; color: var(--muted); padding-bottom: 8px; }
.quick-publish-versions p { flex-basis: 100%; margin: 0; }
textarea { width: 100%; min-height: 64px; resize: vertical; color: var(--text); background: var(--input); border: 1px solid var(--line-strong); border-radius: var(--radius-control); padding: 8px 10px; font: inherit; }
</style>
