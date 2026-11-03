<script setup>
import { ui } from '../../shared/ui-copy.js';

import {ref,computed,watch,nextTick,onMounted} from 'vue';
import {Trophy,LoaderCircle,Pencil} from 'lucide-vue-next';
import {MAX_LOTTERY_NOTE,lotteryCountLabel} from '../../shared/lottery-records.js';
const props=defineProps({record:{type:Object,required:true},editing:Boolean,busy:Boolean,loading:Boolean,error:String});
const emit=defineEmits(['save','edit','close','refresh']);
const note=ref(props.record.note||''),noteInput=ref(null),page=ref(0),pageSize=50;
const winners=computed(()=>props.record.winners||[]),pages=computed(()=>Math.max(1,Math.ceil(winners.value.length/pageSize)));
const visibleWinners=computed(()=>winners.value.slice(page.value*pageSize,(page.value+1)*pageSize));
watch(()=>props.record.revision,()=>{note.value=props.record.note||'';});
watch(pages,()=>{page.value=Math.min(page.value,pages.value-1);});
watch(()=>props.editing,async value=>{if(value){note.value=props.record.note||'';await nextTick();noteInput.value?.focus();}});
onMounted(()=>{if(props.editing)noteInput.value?.focus();});
</script>

<template>
  <div class="lottery-panel">
    <p class="lottery-record-only"><Trophy :size="16"/>{{ ui.lottery.仅作记录始终不进入视频或导出 }}</p>
    <form v-if="editing" @submit.prevent="emit('save',{revision:record.revision,note})">
      <p class="muted">{{ ui.lottery.奖品备注范围 }}</p>
      <label class="field-label">{{ ui.lottery.奖品备注 }}<input ref="noteInput" v-model="note" :aria-label="ui.lottery.奖品备注" :maxlength="MAX_LOTTERY_NOTE" :placeholder="record.phrase||ui.lottery.填写实际发放的产品或奖品" :disabled="busy||loading"/></label>
      <p class="muted">{{ ui.lottery.留空显示原参与口令 }}</p>
      <p v-if="record.phrase" class="lottery-original">{{ ui.lottery.原参与口令 }}{{ record.phrase }}</p>
      <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
      <div class="confirm-actions"><button type="button" class="button" :disabled="busy" @click="emit('close')">{{ ui.common.取消 }}</button><button class="button primary" :disabled="busy||loading"><LoaderCircle v-if="busy" class="spin" :size="16"/>{{ ui.lottery.保存备注 }}</button></div>
    </form>
    <template v-else>
      <h3 class="lottery-product">{{ record.text }}</h3>
      <p v-if="record.note&&record.phrase" class="lottery-original">{{ ui.lottery.原参与口令 }}{{ record.phrase }}</p>
      <p class="lottery-count" role="status">{{ lotteryCountLabel(record) }}<span v-if="record.participants"> · {{ record.participants }} {{ ui.lottery.人参与 }}</span></p>
      <p v-if="record.timeKind==='observed'" class="muted">{{ ui.lottery.开奖定位时间说明 }}</p>
      <p v-if="loading"><LoaderCircle class="spin" :size="16"/> {{ ui.lottery.正在读取名单 }}</p>
      <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
      <div v-if="winners.length" class="lottery-winners"><table :aria-label="ui.lottery.天选中奖名单"><thead><tr><th>{{ ui.lottery.中奖用户 }}</th><th>UID</th></tr></thead><tbody><tr v-for="(winner,index) in visibleWinners" :key="winner.uid||page*pageSize+index"><td>{{ winner.name }}</td><td><code>{{ winner.uid||ui.lottery.平台未公开 }}</code></td></tr></tbody></table></div>
      <p v-else-if="!loading" class="muted">{{ ui.lottery.等待平台返回名单 }}</p>
      <div v-if="pages>1" class="lottery-pages"><button class="button" :disabled="page===0" @click="page--">{{ ui.lottery.上一页 }}</button><span>{{ page+1 }} / {{ pages }}</span><button class="button" :disabled="page+1>=pages" @click="page++">{{ ui.lottery.下一页 }}</button></div>
      <div class="confirm-actions"><button class="button" :disabled="busy||loading" @click="emit('refresh')">{{ ui.lottery.刷新名单 }}</button><button class="button" :disabled="busy||loading" @click="emit('edit')"><Pencil :size="15"/>{{ ui.lottery.编辑备注 }}</button><button class="button primary" @click="emit('close')">{{ ui.common.关闭 }}</button></div>
    </template>
  </div>
</template>
