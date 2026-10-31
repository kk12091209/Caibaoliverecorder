<script setup>
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
    <p class="lottery-record-only"><Trophy :size="16"/>仅作记录，始终不进入视频或导出</p>
    <form v-if="editing" @submit.prevent="emit('save',{revision:record.revision,note})">
      <p class="muted">只修改这条记录的奖品备注，中奖昵称、UID 和参与口令保留原始信息。</p>
      <label class="field-label">奖品备注<input ref="noteInput" v-model="note" aria-label="奖品备注" :maxlength="MAX_LOTTERY_NOTE" :placeholder="record.phrase||'填写实际发放的产品或奖品'" :disabled="busy||loading"/></label>
      <p class="muted">留空恢复显示参与口令。</p>
      <p v-if="record.phrase" class="lottery-original">原参与口令：{{ record.phrase }}</p>
      <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
      <div class="confirm-actions"><button type="button" class="button" :disabled="busy" @click="emit('close')">取消</button><button class="button primary" :disabled="busy||loading"><LoaderCircle v-if="busy" class="spin" :size="16"/>保存备注</button></div>
    </form>
    <template v-else>
      <h3 class="lottery-product">{{ record.text }}</h3>
      <p v-if="record.note&&record.phrase" class="lottery-original">原参与口令：{{ record.phrase }}</p>
      <p class="lottery-count" role="status">{{ lotteryCountLabel(record) }}<span v-if="record.participants"> · {{ record.participants }} 人参与</span></p>
      <p v-if="record.timeKind==='observed'" class="muted">定位到首次发现这份结果的位置，可能晚于实际开奖。</p>
      <p v-if="loading"><LoaderCircle class="spin" :size="16"/> 正在读取名单…</p>
      <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
      <div v-if="winners.length" class="lottery-winners"><table aria-label="天选中奖名单"><thead><tr><th>中奖用户</th><th>UID</th></tr></thead><tbody><tr v-for="(winner,index) in visibleWinners" :key="winner.uid||page*pageSize+index"><td>{{ winner.name }}</td><td><code>{{ winner.uid||'平台未公开' }}</code></td></tr></tbody></table></div>
      <p v-else-if="!loading" class="muted">平台尚未返回中奖名单，将在采集到后补全。</p>
      <div v-if="pages>1" class="lottery-pages"><button class="button" :disabled="page===0" @click="page--">上一页</button><span>{{ page+1 }} / {{ pages }}</span><button class="button" :disabled="page+1>=pages" @click="page++">下一页</button></div>
      <div class="confirm-actions"><button class="button" :disabled="busy||loading" @click="emit('refresh')">刷新名单</button><button class="button" :disabled="busy||loading" @click="emit('edit')"><Pencil :size="15"/>编辑备注</button><button class="button primary" @click="emit('close')">关闭</button></div>
    </template>
  </div>
</template>
