<script setup>
import { onMounted, ref } from 'vue';
import { ui } from '../../shared/ui-copy.js';
import { api } from '../api.js';

const props = defineProps({ formatBytes: { type: Function, required: true } });
const emit = defineEmits(['changed']);
const copy = ui.storageCleanup;
const snapshot = ref(null), busy = ref(false), error = ref(''), status = ref(''), selected = ref(null);
const size = bytes => bytes == null ? copy.大小待核对 : props.formatBytes(bytes, 1000);

async function run(action) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  status.value = '';
  try { await action(); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
function inspect(reconcile = false) {
  selected.value = null;
  return run(async () => {
    snapshot.value = reconcile ? await api('storage/cleanup/review', {}) : await api('storage/cleanup');
    if (reconcile) emit('changed');
  });
}
function retry() {
  selected.value = null;
  return run(async () => {
    snapshot.value = await api('storage/cleanup/retry', {});
    emit('changed');
  });
}
function open(workspace) {
  return run(async () => { await api('storage/cleanup/open', { directory: workspace.name }); });
}
function remove() {
  if (!selected.value) return;
  const { workspace, file } = selected.value;
  selected.value = null;
  return run(async () => {
    const result = await api('storage/cleanup/remove', {
      directory: workspace.name, file: file.name, confirmation: file.confirmation, confirmed: true,
    });
    status.value = copy.本次已移除(size(result.freedBytes));
    emit('changed');
    snapshot.value = await api('storage/cleanup');
  });
}
onMounted(inspect);
</script>

<template>
  <section v-if="snapshot?.workspaces.length" class="cleanup-settings cleanup-storage" :aria-label="copy.临时工作区">
    <strong>{{ copy.临时工作区 }}</strong>
    <p class="muted">{{ copy.历史残留说明 }}</p>
    <div class="directory-actions">
      <button type="button" class="button small" :disabled="busy" @click="inspect(true)">{{ copy.重新检查 }}</button>
      <button type="button" class="button small" :disabled="busy" @click="retry">{{ copy.重试已确认的暂存清理 }}</button>
    </div>
    <p v-if="busy" role="status">{{ copy.正在核对磁盘 }}</p>
    <p v-if="error" role="alert" class="cleanup-error">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
    <dl class="cleanup-storage-usage">
      <template v-for="(entry, kind) in snapshot.usage" :key="kind">
        <dt>{{ copy.占用分类[kind] }}</dt>
        <dd>{{ entry.incomplete ? copy.至少(size(entry.bytes)) : size(entry.bytes) }}</dd>
      </template>
    </dl>
    <p class="muted">{{ copy.本次运行已移除(size(snapshot.removedBytes)) }}</p>
    <details v-for="workspace in snapshot.workspaces" :key="workspace.name" class="cleanup-storage-item">
      <summary>{{ workspace.name }} · {{ size(workspace.bytes) }} · {{ copy.状态[workspace.status] }}</summary>
      <p><code>{{ workspace.path }}</code></p>
      <p v-if="workspace.sessionId" class="muted">{{ copy.素材编号(workspace.sessionId) }}</p>
      <button v-if="workspace.canOpen" type="button" class="button small" :disabled="busy" @click="open(workspace)">{{ copy.打开位置 }}</button>
      <div v-for="file in workspace.files" :key="file.name" class="cleanup-row">
        <div>
          <code>{{ file.name }}</code>
          <small>{{ size(file.bytes) }} · {{ copy.状态[file.status] }}</small>
        </div>
        <button v-if="file.confirmation" type="button" class="button small danger" :disabled="busy"
          @click="selected = { workspace, file }">{{ copy.移除此文件 }}</button>
      </div>
      <div v-if="selected?.workspace === workspace" class="setting-info" role="group" :aria-label="copy.确认移除">
        <p>{{ copy.确认提示(selected.file.name, size(selected.file.bytes)) }}</p>
        <button type="button" class="button small" @click="selected = null">{{ ui.common.取消 }}</button>
        <button type="button" class="button small danger" :disabled="busy" @click="remove">{{ copy.确认移除 }}</button>
      </div>
    </details>
  </section>
  <div v-else-if="error" class="cleanup-storage directory-actions">
    <p role="alert" class="cleanup-error">{{ error }}</p>
    <button type="button" class="button small" @click="inspect()">{{ copy.重新检查 }}</button>
  </div>
</template>
