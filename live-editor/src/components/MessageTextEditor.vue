<script setup>
import {ref, onMounted} from 'vue';
import {LoaderCircle} from 'lucide-vue-next';
import {MAX_EDITED_NICKNAME, MAX_EDITED_TEXT, validateMessageEdits} from '../../shared/message-edits.js';
const props = defineProps({message: {type: Object, required: true}, busy: Boolean});
const emit = defineEmits(['save', 'close']);
const nickname = ref(props.message.user), text = ref(props.message.text), error = ref(''), nicknameInput = ref(null);
onMounted(() => nicknameInput.value?.focus());
function submit() {
  try {const patch = validateMessageEdits({[props.message.id]: {user: nickname.value, text: text.value}});error.value = '';emit('save', patch[props.message.id]);}
  catch (e) {error.value = e.message;}
}
</script>

<template>
  <form class="message-text-editor" @submit.prevent="submit">
    <p class="muted">仅修改这条弹幕的显示。原始记录和该用户的其他弹幕保留。</p>
    <label class="field-label">发送者昵称<input ref="nicknameInput" v-model="nickname" aria-label="发送者昵称" :maxlength="MAX_EDITED_NICKNAME" :disabled="busy" required/></label>
    <label class="field-label">弹幕内容<textarea v-model="text" aria-label="弹幕内容" :maxlength="MAX_EDITED_TEXT" :disabled="busy" rows="3" required/></label>
    <div class="message-edit-preview"><span class="muted">突出显示并开启昵称时</span><p>{{ nickname }}：{{ text }}</p></div>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <div class="confirm-actions"><button v-if="message.edited" type="button" class="button" :disabled="busy" @click="emit('save', null)">恢复原文</button><button type="button" class="button" :disabled="busy" @click="emit('close')">取消</button><button class="button primary" :disabled="busy || !nickname.trim() || !text.trim()"><LoaderCircle v-if="busy" class="spin" :size="16"/>保存修改</button></div>
  </form>
</template>
