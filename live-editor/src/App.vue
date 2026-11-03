<script setup>
import { ui } from '../shared/ui-copy.js';

import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import DanmakuOverlay from './components/DanmakuOverlay.vue';
import GiftOverlay from './components/GiftOverlay.vue';
import GiftIcon from './components/GiftIcon.vue';
import VirtualMessageList from './components/VirtualMessageList.vue';
import MessageTimeNavigator from './components/MessageTimeNavigator.vue';
import {messageTime,messageWindow} from '../shared/message-navigation.js';
import {normalizedGiftStyle} from '../shared/gifts.js';
import {senderFilterFor} from '../shared/sender-filter.js';
import {applyMessageEdit} from '../shared/message-edits.js';
import MessageTextEditor from './components/MessageTextEditor.vue';
import LotteryPanel from './components/LotteryPanel.vue';
import {lotteryCountLabel} from '../shared/lottery-records.js';
import LinkmicOverlay from './components/LinkmicOverlay.vue';
import RecordingTimestamp from './components/RecordingTimestamp.vue';
import RecordingSettings from './components/RecordingSettings.vue';
import RecordingLayout from './components/RecordingLayout.vue';
import { CAMERA_POSITIONS, normalizedRecordingStyle } from '../shared/recording-style.js';
import { TIMESTAMP_STYLES, normalizedTimestampStyle, TIMESTAMP_POSITIONS, normalizedTimestampPosition } from '../shared/timestamp-style.js';
import UpdateSettings from './components/UpdateSettings.vue';
import PlatformCredentials from './components/PlatformCredentials.vue';
import UpdatePrompt from './components/UpdatePrompt.vue';
import CacheWarning from './components/CacheWarning.vue';
import MonitoredAnchors from './components/MonitoredAnchors.vue';
import PowerSettings from './components/PowerSettings.vue';
import DanmakuStyleSettings from './components/DanmakuStyleSettings.vue';
import { applyUpdate } from './desktop.js';
import TimelineSignals from './components/TimelineSignals.vue';
import TimelineNavigator from './components/TimelineNavigator.vue';
import TimelineMarker from './components/TimelineMarker.vue';
import TimelineScrubber from './components/TimelineScrubber.vue';
import { signalWindow, viewWindow, windowPercent, visibleRange, panWindow, zoomWindow,followWindow,signalFetchWindow } from './timeline-signals.js';
import { recordingCoverage } from './recording-coverage.js';
import { livePreparationView } from './preparation-state.js';
import DismissibleNotice from './components/DismissibleNotice.vue';
import appIcon from './assets/app-icon.png';
import { formatVideoTime as format, displayedSpan, markPreviewPosition } from './video-time.js';
import { recordingTimeAt, positionAtRecordingTime, toRecordingInput, parseRecordingInput, recordingTimeBounds } from './recording-time.js';
import { overlayWindow as makeOverlayWindow, containsOverlay } from './message-window.js';
import { isDesktop, isMacDesktop, openAuthorPage, openStudioPage, pickExportFolder } from './desktop.js';
import { api } from './api.js';
import { stateSync } from './state-sync.js';
import { previewStream } from './preview-stream.js';
import { Video, Radio, Film, Play, Pause, StepBack, StepForward, RotateCcw, Settings, Plus, Minus, Search, Trash2, Download, X, ChevronUp, ChevronDown, Check, AlertCircle, LoaderCircle, Target, Scissors, Pencil, Trophy, FolderOpen, Volume2, Volume1, VolumeX } from 'lucide-vue-next';

const state=ref({sessions:[],rooms:[],jobs:[],recorder:{online:false,error:''},dataPath:'',paths:{},preparation:{enabled:true,items:[]}} );
const recordingCameraEvents=ref([]);
const recordingStyleSummary=computed(()=>{const style=normalizedRecordingStyle(state.value.recordingStyle);return CAMERA_POSITIONS.find(p=>p.value===style.cameraPosition).label+(style.cameraPosition==='original'?'':ui.workbench.摄像头尺寸摘要(style.cameraSize));});
const timestampStyleSummary=computed(()=>TIMESTAMP_STYLES.find(style=>style.value===normalizedTimestampStyle(state.value.previewTimestampStyle)).label);
const timestampPositionSummary=computed(()=>TIMESTAMP_POSITIONS.find(position=>position.value===normalizedTimestampPosition(state.value.previewTimestampPosition)).label);
const coreStatus=computed(()=>{
  const core=state.value.recorder;
  if(core.biliOnline&&core.douyinOnline)return ui.workbench.录制服务就绪;
  if(core.douyinOnline)return core.error?ui.workbench.B站正在恢复抖音就绪:ui.workbench.B站连接中抖音就绪;
  return core.biliOnline?ui.workbench.B站服务就绪:ui.workbench.录制服务未连接;
});
const selected=ref(null),detail=ref(null),edit=ref({revision:0,ranges:[],excluded:[],undo:[]});
const roomUrl=ref(''),addingRoom=ref(false),notice=ref(''),noticeKind=ref('error'),saving=ref(false),connected=ref(false);
const noticeSequence=ref(0);
const recoveryNoticeKey=computed(()=>{const r=state.value.recovery||{};return JSON.stringify([!!r.safeMode,!!r.recovering,r.isolatedRecords||0,!!r.coreConfigRecovered,r.error||'']);});
const roomChoice=shallowRef(null),roomChoicePlatform=ref(''),roomChoiceError=ref('');
const video=ref(null),previewUrl=ref(''),position=ref(0),previewBase=ref(0),isPlaying=ref(false),loading=ref(false),previewEnded=ref(false),scrubbing=ref(false);
let previewTransport;
const previewClient=crypto.randomUUID();
const previewVolume=ref(1),previewMuted=ref(false);
try{const saved=JSON.parse(localStorage.getItem('preview-audio')||'null');if(saved&&Number.isFinite(saved.volume))previewVolume.value=Math.min(1,Math.max(0,saved.volume));if(saved&&typeof saved.muted==='boolean')previewMuted.value=saved.muted;}catch{}
let previewVolumeHold=previewVolume.value>0?previewVolume.value:1;
const previewSlider=computed(()=>previewMuted.value?0:previewVolume.value);
const giftRows=shallowRef([]),giftFeed=shallowRef([]),showGifts=ref(false),onlyGifts=ref(false),exportGifts=ref(false);
watch(showGifts,value=>{if(!value)onlyGifts.value=false;});
function changeOnlyGifts(){messageFollowPaused.value=false;if(onlyGifts.value&&senderFilter.value)clearSenderFilter();void loadMessages(true);}
watch(()=>state.value.giftStyle?.preview,value=>{showGifts.value=value===true;giftRows.value=[];lotteryRows.value=[];void loadMessages(true);});
async function changeGiftPreview(){try{const result=await api('settings',{giftStyle:{...normalizedGiftStyle(state.value.giftStyle),preview:showGifts.value}});state.value.giftStyle=result.giftStyle;void loadMessages(true);void loadGiftOverlay();}catch(e){showGifts.value=state.value.giftStyle?.preview===true;tell(e.message);}}
const startText=ref('00:00:00'),endText=ref('00:00:00'),startExact=ref(0),endExact=ref(0),query=ref(''),messages=shallowRef([]),showOverlay=ref(true),followMessages=ref(true),messageList=ref(null);
const messagePage=ref({hasBefore:false,hasAfter:false}),messageLoading=ref(false),messageFollowPaused=ref(false);
const feedKey=row=>`${row.type==='d'?'d':row.type==='lottery'?'l':'g'}:${row.id}`;
const roomBusyIds=ref([]);
const modal=ref(''),modalBusy=ref(false),exportMode=ref('dual'),materialDeleteError=ref('');
const startMarked=ref(false),endMarked=ref(false),sessionMenu=ref(null),confirmTarget=ref(null);
const messageMenu=ref(null),senderFilter=ref(null);
const messageEditTarget=ref(null);
const lotteryRows=shallowRef([]),lotteryTarget=ref(null),lotteryEditing=ref(false),lotteryLoading=ref(false),lotteryError=ref('');
let lotteryDetailRequest=0;
const senderWarning=computed(()=>senderFilter.value?.mode==='approx'?ui.workbench.打码昵称匹配提示:senderFilter.value?.mode==='name'?ui.workbench.同名用户提示:'');
const jobMenu=ref(null),jobDeleteTarget=ref(null),jobDeletePreview=shallowRef(null),jobPreviewLoading=ref(false),jobDeleteError=ref('');
const jobDeleteRecordOnly=ref(false);
const retrySaveTarget=ref(null),retrySaveDirectory=ref(''),retrySaveError=ref(''),retrySavingIds=ref([]),jobRetryErrors=ref({});
const cacheWarningGiBDraft=ref(null),cacheWarningBusy=ref(false),cacheWarningError=ref(''),cacheWarningDismissed=ref('');
const cacheWarningKey=computed(()=>`${state.value.preparation?.cache?.warningGiB}:${state.value.preparation?.cache?.warningCycle}`);
const cacheWarningVisible=computed(()=>connected.value&&state.value.preparation?.cache?.warningDue===true&&cacheWarningDismissed.value!==cacheWarningKey.value&&!modal.value&&!sessionMenu.value&&!jobMenu.value&&!messageMenu.value&&!timelineDragging.value&&!scrubbing.value);
const preparationBusyIds=ref([]),preparationErrors=ref({}),preparationSettingsBusy=ref(false),preparationSettingsError=ref(''),preparationEnabledDraft=ref(null),livePreparationEnabledDraft=ref(null);
const closeActionBusy=ref(false),closeActionError=ref(''),closeActionDraft=ref(null);
const positionMode=ref('video'),startDateText=ref(''),endDateText=ref('');
const panelBreakpoint=window.matchMedia('(max-width: 1100px)'),compactBreakpoint=window.matchMedia('(max-width: 1440px)');
const narrowLayout=ref(panelBreakpoint.matches),compactLayout=ref(compactBreakpoint.matches);
const libraryPreference=ref(null),danmakuPreference=ref(null),bottomTab=ref('clips');
const libraryVisible=computed(()=>libraryPreference.value??!narrowLayout.value);
const danmakuVisible=computed(()=>danmakuPreference.value??!compactLayout.value);
function updatePanelBreakpoint(){narrowLayout.value=panelBreakpoint.matches;compactLayout.value=compactBreakpoint.matches;}
const exportScope=ref('clips'),exportTarget=ref(null),exportRanges=ref([]),exportExcluded=ref(0);
const pendingCleanup=computed(()=>(state.value.pendingCleanup||[]).map(item=>({...item,task:state.value.deletions?.find(task=>task.id===item.id)})));
const requestedDeletions=new Map();
async function openCleanup(){openSettings();await nextTick();document.querySelector('.cleanup-settings')?.scrollIntoView({block:'center'});}
function cleanupLabel(item){const task=item.task;if(!task)return item.purge_error?ui.workbench.等待重试:ui.workbench.等待清理;const count=task.total?`（${task.completed}/${task.total}）`:'';return ({resources:ui.workbench.正在释放占用,checking:ui.workbench.正在核对文件,files:ui.workbench.正在清理文件,cache:ui.workbench.正在清理缓存,temporary:ui.workbench.正在清理临时文件,records:ui.workbench.正在清理记录,waiting:ui.workbench.等待占用释放随后自动重试})[task.phase]+count;}
const draftStart=computed(()=>markerTime('start',startMarked.value));
const draftEnd=computed(()=>markerTime('end',endMarked.value));
const draftDuration=computed(()=>draftStart.value!==null&&draftEnd.value!==null&&draftEnd.value>draftStart.value?draftEnd.value-draftStart.value:null);
const clockBounds=computed(()=>recordingTimeBounds(activeSession.value,detail.value?.sources||[],duration.value));
const selectionReady=computed(()=>!!selected.value&&detail.value?.id===selected.value);
const canUseRecordingTime=computed(()=>selectionReady.value&&activeSession.value?.room>0&&!!clockBounds.value);
const markerError=computed(()=>{for(const which of ['start','end']){if(!(which==='start'?startMarked.value:endMarked.value))continue;try{readMark(which);}catch(e){return (which==='start'?ui.workbench.起点:ui.workbench.终点)+e.message;}}return '';});
const confirmation=computed(()=>['remove-room','delete-session','delete-job'].includes(modal.value));
const jobMenuTarget=computed(()=>state.value.jobs.find(job=>job.id===jobMenu.value?.id));
const retrySaveJob=computed(()=>state.value.jobs.find(job=>job.id===retrySaveTarget.value?.id));
const retrySaveBlock=computed(()=>retrySaveReason(retrySaveJob.value));
const retrySaveCategory=computed(()=>retrySaveTarget.value?.scope==='full'?'完整素材':'导出片段');
const jobDeleteBlock=computed(()=>{
  if(modal.value!=='delete-job')return '';
  const blocked=jobRemovalBlock(state.value.jobs.find(job=>job.id===jobDeleteTarget.value?.id));if(blocked)return blocked;
  if(jobDeleteRecordOnly.value)return '';
  if(jobPreviewLoading.value)return ui.workbench.正在核对导出文件;
  if(!jobDeletePreview.value)return ui.workbench.请先核对该任务对应的导出文件;
  return jobDeletePreview.value.blocked?(jobDeletePreview.value.reason||ui.workbench.该任务暂时无法删除):'';
});
const deleteBlock=computed(()=>{
  if(modal.value!=='delete-session'||!confirmTarget.value)return '';
  const s=[...state.value.sessions,...pendingCleanup.value].find(s=>s.id===confirmTarget.value.id);
  if(!s)return ui.workbench.素材已被永久删除;
  if(s.status!=='finished')return ui.workbench.录制中禁止删除;
  if(state.value.jobs.some(j=>j.session===s.id&&j.status==='save_failed'))return ui.workbench.待保存成片阻止删除;
  if(s.archive_status==='running'||state.value.jobs.some(j=>j.session===s.id&&['queued','running','finalizing','saving','cancelling'].includes(j.status)))return ui.workbench.素材使用中禁止删除;
  return '';
});
const modalTitle=computed(()=>({settings:ui.workbench.设置,'edit-message':ui.workbench.编辑文本,lottery:lotteryEditing.value?ui.workbench.编辑奖品备注:ui.workbench.天选时刻中奖名单,'danmaku-style':ui.workbench.调整弹幕样式,'recording-style':ui.workbench.调整录制样式,'cookie-management':ui.common.Cookie管理,export:exportScope.value==='full'?ui.workbench.导出完整素材:ui.workbench.导出选段,'choose-room':ui.workbench.选择主播,'remove-room':ui.common.移除监控主播,'delete-session':ui.workbench.删除已录制素材,'delete-job':ui.workbench.删除导出任务,'retry-save':ui.workbench.更换保存位置})[modal.value]||'');
const activeSession=computed(()=>state.value.sessions.find(s=>s.id===selected.value)||detail.value);
const preparationEnabled=computed(()=>state.value.preparation?.enabled!==false);
const livePreparationEnabled=computed(()=>state.value.preparation?.liveEnabled===true);
const selectedPreparation=computed(()=>preparationFor(selected.value));
const selectedLivePreparation=computed(()=>livePreparationView(activeSession.value,state.value.preparation,selectedPreparation.value));
const selectedPreparationAction=computed(()=>preparationAction(selectedPreparation.value));
const selectedPreparationBlock=computed(()=>preparationActionBlock(activeSession.value));
const duration=computed(()=>activeSession.value?.duration||0);
const messageWindowAnchor=ref(0),messageBrowseTime=ref(0),messageNavigationPinned=ref(false);
const messageRange=computed(()=>messageWindow(duration.value,messageFollowPaused.value?messageWindowAnchor.value:position.value,followMessages.value));
const coverage=computed(()=>recordingCoverage(detail.value?.sources,duration.value));
const timelineAutoFollow=ref(true),activeMarker=ref(null);
const timelineWindow=ref(null),signals=shallowRef(null),signalsLoading=ref(false),signalsError=ref('');
const timelineDragging=ref(false);
const viewport=computed(()=>viewWindow(duration.value,timelineWindow.value));
const viewSpan=computed(()=>viewport.value.to-viewport.value.from);
const visibleRanges=computed(()=>edit.value.ranges.map((range,index)=>({range,index,view:visibleRange(range,viewport.value.from,viewport.value.to)})).filter(item=>item.view));
const visibleGaps=computed(()=>coverage.value.gaps.map(gap=>({gap,view:visibleRange(gap,viewport.value.from,viewport.value.to)})).filter(item=>item.view));
const draftView=computed(()=>draftStart.value!==null&&draftEnd.value!==null?visibleRange({start:draftStart.value,end:draftEnd.value},viewport.value.from,viewport.value.to):null);
const source=computed(()=>detail.value?.sources?.find(s=>position.value>=s.start-.02&&position.value<=s.start+s.duration+.1));
const fps=computed(()=>source.value?.metadata?.fps||30);
const excluded=computed(()=>new Set(edit.value.excluded));
const highlighted=computed(()=>new Set(edit.value.highlighted||[]));
const mergedMessages=computed(()=>[...(showGifts.value&&onlyGifts.value?[]:messages.value.map(m=>applyMessageEdit(m,edit.value.messageEdits))),...(showGifts.value?[...giftRows.value,...lotteryRows.value]:[])].sort((a,b)=>a.time-b.time||(feedKey(a)<feedKey(b)?-1:feedKey(a)>feedKey(b)?1:0)));
const visibleMessages=computed(()=>mergedMessages.value.filter(row=>Number.isFinite(row.time)&&row.time>=messageRange.value.from&&row.time<=messageRange.value.to));
const overlayFeed=shallowRef([]),exportDirectory=ref(''),savedExportDirectory=ref('');
let overlayBusy=false, overlayWindow=null;
const myJobs=computed(()=>state.value.jobs.filter(j=>j.session===selected.value));
const selectedRanges=computed(()=>edit.value.ranges.filter(r=>r.selected!==false));
const allRangesSelected=computed(()=>edit.value.ranges.length>0&&selectedRanges.value.length===edit.value.ranges.length);
const rangeDuration=computed(()=>selectedRanges.value.reduce((n,r)=>n+displayedSpan(r.start,r.end),0));
const versionDescription=computed(()=>({clean:ui.workbench.选项一个纯净版MP4,danmaku:ui.workbench.选项一个弹幕版MP4,dual:ui.workbench.纯净版和弹幕版两个MP4})[exportMode.value]);
const exportSession=computed(()=>state.value.sessions.find(s=>s.id===exportTarget.value?.id));
const exportCategory=computed(()=>exportScope.value==='full'?'完整素材':'导出片段');
const exportDuration=computed(()=>exportScope.value==='full'?displayedSpan(0,exportSession.value?.duration||0):exportRanges.value.reduce((total,r)=>total+displayedSpan(r.start,r.end),0));
const exportBlock=computed(()=>{
  if(!exportSession.value)return ui.workbench.素材已被删除无法导出;
  if(exportScope.value==='full')return fullExportBlock(exportSession.value);
  return exportRanges.value.length?'':ui.workbench.请先勾选至少一个选段;
});
const canPreview=computed(()=>selectionReady.value&&duration.value>0.1);
let messageTimer,signalsTimer,queryTimer,noticeTimer,detailBusy=false,detailRefreshedAt=0,dmBusy=false,lastMessageKey='',generation=0,selectionGeneration=0;
let messageRequest=0,overlayRequest=0,signalRequest=0,signalController=null,lastSignalKey='',lastSignalAt=0;
let windowSignalTimer=null,lastWindowRequestAt=0,disposing=false;
let jobPreviewRequest=0;


function parse(text){const values=String(text).split(':').map(Number);if(values.some(n=>!Number.isFinite(n)||n<0)||values.length>3)throw new Error(ui.workbench.视频时间格式错误);return values.reduce((a,b)=>a*60+b,0);}
function date(text){return new Date(text).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
function categoryPath(root,category){const raw=String(root||''),value=raw.replace(/[\\/]+$/,'');return raw?value+(raw.startsWith('/')?'/':'\\')+category:category;}
function formatBytes(bytes){const size=Math.max(0,Number(bytes)||0);if(size<1024)return size+ui.workbench.字节;const units=['KB','MB','GB','TB'],power=Math.min(4,Math.floor(Math.log(size)/Math.log(1024)));return (size/1024**power).toFixed(1)+' '+units[power-1];}
function closeModal(){if(modalBusy.value)return;if(['danmaku-style','recording-style','cookie-management'].includes(modal.value)){const selector=modal.value==='cookie-management'?'.open-cookie-management':modal.value==='danmaku-style'?'.open-danmaku-style':'.open-recording-style';modal.value='settings';void nextTick(()=>document.querySelector(selector)?.focus());return;}const kind=modal.value,messageId=kind==='edit-message'?messageEditTarget.value?.message.id:kind==='lottery'?lotteryTarget.value?.record.id:null,jobId=kind==='delete-job'?jobDeleteTarget.value?.id:kind==='retry-save'?retrySaveTarget.value?.id:null;modal.value='';if(kind==='choose-room'){roomChoice.value=null;roomChoicePlatform.value='';roomChoiceError.value='';void nextTick(()=>document.querySelector('.room-form input')?.focus());}if(kind==='delete-job'){jobPreviewRequest++;jobPreviewLoading.value=false;jobDeleteTarget.value=null;jobDeletePreview.value=null;}if(kind==='retry-save'){retrySaveTarget.value=null;retrySaveError.value='';}if(kind==='lottery'){lotteryDetailRequest++;lotteryLoading.value=false;lotteryTarget.value=null;lotteryError.value='';if(messageId)void nextTick(()=>document.getElementById('danmaku-'+messageId)?.querySelector('.message-more')?.focus());}if(kind==='edit-message'){messageEditTarget.value=null;if(messageId)void nextTick(()=>document.getElementById('danmaku-'+messageId)?.querySelector('.message-more')?.focus());}if(jobId)void nextTick(()=>focusJob(jobId));}
function fullExportBlock(session){return session.status!=='finished'?ui.workbench.录制或整理完成后才能导出完整素材:!(session.duration>0)?ui.workbench.这份素材暂时没有可导出的画面:'';}
function preparationFor(id){return state.value.preparation?.items?.find(item=>item.session===id);}
function preparationStatus(entry){return ({queued:ui.workbench.等待预处理,preparing:ui.workbench.正在后台预处理,waiting:ui.workbench.暂缓预处理,paused:ui.workbench.预处理已暂停,ready:ui.workbench.预处理已完成,exported:ui.workbench.完整弹幕版已导出,error:ui.workbench.预处理未完成})[entry?.status]||ui.workbench.尚未预处理;}
function preparationAction(entry){if(['space','disk','capacity','space-check'].includes(entry?.reason))return 'resume';return ['queued','preparing','waiting'].includes(entry?.status)?'pause':['ready','exported'].includes(entry?.status)?null:['paused','error'].includes(entry?.status)?'resume':'start';}
function preparationActionLabel(entry,context=false){const action=preparationAction(entry);return action==='pause'?(context?ui.workbench.暂停后台预处理:ui.workbench.暂停):action==='resume'?(entry?.status==='error'?(context?ui.workbench.重试后台预处理:ui.workbench.重试):(context?ui.workbench.继续后台预处理:ui.workbench.继续)):action==='start'?ui.workbench.开始后台预处理:ui.workbench.后台预处理已完成;}
function preparationProgress(entry){const total=Number(entry?.totalSeconds)||0;return total>0?Math.max(0,Math.min(1,(Number(entry?.preparedSeconds)||0)/total)):entry?.status==='ready'?1:0;}
function preparationReason(entry){
  if(entry?.status==='exported')return ui.workbench.整场已导出说明;
  if(entry?.status==='ready')return '';
  if(!preparationEnabled.value)return ui.workbench.自动预处理已关闭请在设置中开启;
  if(['space','disk','capacity','space-check'].includes(entry?.reason))return entry.error||ui.workbench.预处理空间检查未通过可重试;
  if(entry?.status==='error')return entry.error||ui.workbench.预处理暂未完成可稍后重试;
  if(entry?.status==='preparing')return ui.workbench.预处理可暂停说明;
  const reasons={recording:ui.workbench.正在录制空闲后继续,connection:ui.workbench.等待录制核心连接,preview:ui.workbench.播放优先预览结束后继续,export:ui.workbench.正在导出完成后继续,indexing:ui.workbench.素材正在整理完成后继续,compaction:ui.workbench.素材正在整理完成后继续,source:ui.workbench.素材尚未准备好稍后继续,space:ui.workbench.磁盘可用空间不足腾出空间后继续,disabled:ui.workbench.自动预处理已关闭请在设置中开启,foreground:ui.workbench.当前操作优先空闲后继续,idle:ui.workbench.等待空闲后开始,user:ui.workbench.已手动暂停可随时继续};
  return reasons[entry?.reason]||(['queued','waiting'].includes(entry?.status)?ui.workbench.等待后台空闲:entry?.status==='paused'?ui.workbench.已手动暂停可随时继续:'');
}
function preparationActionBlock(session){
  const current=state.value.sessions.find(item=>item.id===session?.id);if(!current)return ui.workbench.素材已被删除;
  if(current.status!=='finished')return ui.workbench.录制或整理完成后可开始后台预处理;if(!(current.duration>0))return ui.workbench.这份素材暂时没有可预处理的画面;
  if(preparationSettingsBusy.value||preparationBusyIds.value.includes(current.id))return ui.workbench.正在更新预处理状态;
  const action=preparationAction(preparationFor(current.id));if(!action)return ui.workbench.后台预处理已完成后台预处理已完成;
  return action!=='pause'&&!preparationEnabled.value?ui.workbench.请在设置中开启后台预处理:'';
}
function applyPreparation(value){if(value&&typeof value.enabled==='boolean'&&Array.isArray(value.items))state.value.preparation=value;}
async function updatePreparationSettings(values){
  if(preparationSettingsBusy.value)return;preparationSettingsBusy.value=true;preparationEnabledDraft.value=values.enabled??null;livePreparationEnabledDraft.value=values.liveEnabled??null;preparationSettingsError.value='';
  try{const result=await api('preparation/settings',values);if(disposing)return;applyPreparation(result);if(values.cacheWarningEnabled===true)cacheWarningDismissed.value='';await refresh();}
  catch(e){if(!disposing)preparationSettingsError.value=e.message;}
  finally{preparationSettingsBusy.value=false;preparationEnabledDraft.value=null;livePreparationEnabledDraft.value=null;}
}
async function acknowledgeCacheWarning(manage=false){
  if(cacheWarningBusy.value)return;cacheWarningBusy.value=true;cacheWarningError.value='';
  const {warningCycle:cycle,warningGiB:thresholdGiB}=state.value.preparation.cache;
  try{
    const result=await api('preparation/cache/acknowledge',{cycle,thresholdGiB});
    if(disposing)return;applyPreparation(result);
    if(result.cache?.warningAcknowledged&&result.cache.warningCycle===cycle&&result.cache.warningGiB===thresholdGiB)cacheWarningDismissed.value=`${thresholdGiB}:${cycle}`;
    await nextTick();
    if(manage){openSettings();await nextTick();const panel=document.querySelector('.cache-settings');panel?.scrollIntoView({block:'center'});panel?.querySelector('button')?.focus();}
  }catch(error){if(!disposing)cacheWarningError.value=error.message;}
  finally{cacheWarningBusy.value=false;}
}
async function clearPreparationCache(){
  if(preparationSettingsBusy.value)return;preparationSettingsBusy.value=true;preparationSettingsError.value='';
  try{applyPreparation(await api('preparation/cache/clear',{}));tell(ui.workbench.缓存清理成功,'success');}
  catch(e){preparationSettingsError.value=e.message;}finally{preparationSettingsBusy.value=false;}
}
function setPreparationEnabled(enabled){return updatePreparationSettings({enabled});}
function setLivePreparationEnabled(liveEnabled){return updatePreparationSettings({liveEnabled});}
async function actPreparation(session){
  const id=session?.id,current=state.value.sessions.find(item=>item.id===id),blocked=preparationActionBlock(current);if(blocked){tell(blocked);return;}
  const action=preparationAction(preparationFor(id));if(!action)return;closeContext();preparationBusyIds.value.push(id);delete preparationErrors.value[id];
  try{const result=await api(`sessions/${encodeURIComponent(id)}/preparation`,{action});if(disposing)return;applyPreparation(result);await refresh();}
  catch(e){if(!disposing){preparationErrors.value[id]=e.message;tell(e.message);}}
  finally{preparationBusyIds.value=preparationBusyIds.value.filter(value=>value!==id);}
}
function timelinePercent(time){return windowPercent(time,viewport.value.from,viewport.value.to);}
function inViewport(time){return time!==null&&Number.isFinite(time)&&time>=viewport.value.from-.001&&time<=viewport.value.to+.001;}
function rangeStyle(range){return {left:range.left+'%',width:range.width+'%'};}
function setTimelineWindow(window){if(window===null&&timelineWindow.value===null)return;if(window&&timelineWindow.value&&window.from===timelineWindow.value.from&&window.to===timelineWindow.value.to)return;timelineWindow.value=window;}
function focusTimeline(){if(canPreview.value){timelineAutoFollow.value=true;setTimelineWindow(followWindow(duration.value,signalWindow(duration.value,position.value),position.value,true));}}
function zoomTimeline(factor){if(canPreview.value)setTimelineWindow(zoomWindow(duration.value,timelineWindow.value,position.value,factor));}
function panTimeline(from){if(canPreview.value){timelineAutoFollow.value=false;setTimelineWindow(panWindow(duration.value,timelineWindow.value,from));}}
function returnToPosition(){timelineAutoFollow.value=true;if(canPreview.value&&timelineWindow.value)setTimelineWindow(followWindow(duration.value,timelineWindow.value,position.value,true));}
function queueWindowSignals(immediate=false){
  clearTimeout(windowSignalTimer);windowSignalTimer=null;
  if(disposing)return;
  const delay=immediate?0:Math.max(0,180-(Date.now()-lastWindowRequestAt));
  if(delay){windowSignalTimer=setTimeout(()=>queueWindowSignals(true),delay);return;}
  lastWindowRequestAt=Date.now();void loadSignals();
}
function endTimelineDrag(){activeMarker.value=null;scrubbing.value=false;timelineDragging.value=false;queueWindowSignals(true);}
function resetTimelineNavigation(){clearTimeout(windowSignalTimer);windowSignalTimer=null;timelineDragging.value=false;timelineAutoFollow.value=true;activeMarker.value=null;timelineWindow.value=null;}
function invalidateMessages(){messageRequest++;overlayRequest++;dmBusy=false;overlayBusy=false;lastMessageKey='';overlayWindow=null;}
let pendingSignalKey='';
function invalidateSignals(clear=false){signalRequest++;signalController?.abort();signalController=null;signalsLoading.value=false;lastSignalKey='';if(clear){pendingSignalKey='';signals.value=null;signalsError.value='';}}
async function loadSignals(force=false){
  if(disposing||!selectionReady.value||duration.value<=0||document.hidden||(!force&&timelineDragging.value))return;
  const id=selected.value,{from,to}=signalFetchWindow(duration.value,timelineWindow.value),key=`${id}:${from}:${to}`;
  const audio=signals.value?.audio,settled=audio&&audio.status!=='pending'&&audio.status!=='processing'&&!audio.bins?.some(bin=>bin.state==='pending')&&signals.value?.density?.status!=='building';
  if(signalsLoading.value&&key===pendingSignalKey)return;
  if(!force&&key===lastSignalKey&&settled&&(activeSession.value?.status==='finished'||Date.now()-lastSignalAt<2500))return;
  pendingSignalKey=key;
  invalidateSignals();const request=signalRequest,version=selectionGeneration,controller=new AbortController();signalController=controller;signalsLoading.value=true;
  try{const response=await fetch(`/api/sessions/${id}/signals?from=${from}&to=${to}&bins=600`,{signal:controller.signal});const result=await response.json();if(!response.ok)throw new Error(result.error||ui.workbench.读取时间轴信号失败);if(request!==signalRequest||version!==selectionGeneration||selected.value!==id)return;signals.value=result;signalsError.value='';lastSignalKey=key;lastSignalAt=Date.now();}
  catch(e){if(request===signalRequest&&e.name!=='AbortError')signalsError.value=e.message;}
  finally{if(request===signalRequest){signalsLoading.value=false;signalController=null;}}
}
function signalsVisibility(){if(document.hidden){clearTimeout(windowSignalTimer);windowSignalTimer=null;invalidateSignals();}else void loadSignals(true);}

function readMark(which){
  if(!selectionReady.value)throw new Error(ui.workbench.请等待素材加载完成);
  if(positionMode.value==='recording')return positionAtRecordingTime(parseRecordingInput(which==='start'?startDateText.value:endDateText.value),activeSession.value,detail.value?.sources||[],duration.value);
  const t=videoMark(which);if(t>duration.value+.000001)throw new Error(ui.workbench.超出已录制范围);return Math.min(t,duration.value);
}
function videoMark(which){
  const text=(which==='start'?startText.value:endText.value).trim();
  if(!text)throw new Error(ui.workbench.请填写视频时间);
  const exact=which==='start'?startExact.value:endExact.value;
  return Number.isFinite(exact)&&format(exact)===text?exact:parse(text);
}
function markerTime(which,marked){if(!marked||!selected.value)return null;try{return readMark(which);}catch{return null;}}
function markText(which,t){if(which==='start'){startExact.value=t;startText.value=format(t);}else{endExact.value=t;endText.value=format(t);}}
function syncRecordingTexts(){
  for(const which of ['start','end']){let t;try{t=videoMark(which);}catch{t=NaN;}
    const stamp=recordingTimeAt(t,activeSession.value,detail.value?.sources||[]),text=Number.isFinite(stamp)?toRecordingInput(stamp):'';
    if(which==='start')startDateText.value=text;else endDateText.value=text;
  }
}
function setPositionMode(mode){
  if(mode===positionMode.value||!selected.value)return;
  if(mode==='recording'){if(!canUseRecordingTime.value)return;syncRecordingTexts();}
  else for(const which of ['start','end']){try{markText(which,readMark(which));}catch{}}
  positionMode.value=mode;
}
function commitMark(which){
  if(which==='start')startMarked.value=true;else endMarked.value=true;
  try{const t=readMark(which);markText(which,t);void playFrom(markPreviewPosition(t,detail.value?.sources||[]),false);}catch(e){tell(e.message);}
}
function setMark(which){
  if(!canPreview.value)return;markText(which,position.value);
  const stamp=recordingTimeAt(position.value,activeSession.value,detail.value?.sources||[]),text=Number.isFinite(stamp)?toRecordingInput(stamp):'';
  if(which==='start'){startMarked.value=true;startDateText.value=text;}else{endMarked.value=true;endDateText.value=text;}
}
function dragMark(which,time){
  markText(which,time);
  const stamp=recordingTimeAt(time,activeSession.value,detail.value?.sources||[]),text=Number.isFinite(stamp)?toRecordingInput(stamp):'';
  if(which==='start'){startMarked.value=true;startDateText.value=text;}else{endMarked.value=true;endDateText.value=text;}
}
function previewMark(time){void playFrom(markPreviewPosition(time,detail.value?.sources||[]),false);}
function clearDraftMarks(){startMarked.value=false;endMarked.value=false;}
function resetSelection(){
  previewTransport?.dispose();selectionGeneration++;generation++;senderFilter.value=null;selected.value=null;detail.value=null;
  invalidateMessages();invalidateSignals(true);resetTimelineNavigation();pausePreview();
  previewUrl.value='';loading.value=false;previewEnded.value=false;previewBase.value=0;scrubbing.value=false;
  edit.value={revision:0,ranges:[],excluded:[],undo:[]};messages.value=[];giftRows.value=[];lotteryRows.value=[];giftFeed.value=[];overlayFeed.value=[];position.value=0;
  startMarked.value=false;endMarked.value=false;startExact.value=0;endExact.value=0;
  startText.value='00:00:00';endText.value='00:00:00';startDateText.value='';endDateText.value='';
}
function applyState(value){
  state.value=value;if(selected.value&&!value.sessions.some(s=>s.id===selected.value))resetSelection();
  for(const [id,title] of requestedDeletions){
    if(!value.sessions.some(s=>s.id===id)&&!value.pendingCleanup?.some(s=>s.id===id)&&!value.deletions?.some(s=>s.id===id)){
      requestedDeletions.delete(id);tell(ui.workbench.素材清理完成(title),'success');
    }
  }
}
function closeContext(){sessionMenu.value=null;jobMenu.value=null;messageMenu.value=null;}
async function showMessageContext(event,message){pauseMessageFollow();
  if(!['d','lottery'].includes(message.type)||modal.value)return;closeContext();const rect=event.currentTarget.getBoundingClientRect();
  messageMenu.value={message,x:event.clientX||rect.left,y:event.clientY||rect.bottom};await nextTick();const menu=document.querySelector('.message-context');if(!menu||!messageMenu.value)return;
  const bounds=menu.getBoundingClientRect();messageMenu.value.x=Math.max(8,Math.min(messageMenu.value.x,innerWidth-bounds.width-8));messageMenu.value.y=Math.max(8,Math.min(messageMenu.value.y,innerHeight-bounds.height-8));menu.querySelector('button:not(:disabled)')?.focus();
}
function filterSender(message){const filter=senderFilterFor(message);closeContext();if(!filter)return;senderFilter.value=filter;giftRows.value=[];lotteryRows.value=[];searchChanged();}
function clearSenderFilter(){senderFilter.value=null;searchChanged();}
async function toggleHighlight(message){if(saving.value||message.type!=='d')return;closeContext();const marked=new Set(edit.value.highlighted||[]);if(marked.has(message.id))marked.delete(message.id);else marked.add(message.id);edit.value.highlighted=[...marked];await save();}
async function openLottery(message,editing=false){
  if(!selectionReady.value||message.type!=='lottery')return;
  closeContext();lotteryTarget.value={session:selected.value,version:selectionGeneration,record:message};lotteryEditing.value=editing;lotteryError.value='';modal.value='lottery';
  if(!editing)void playFrom(message.time,false);
  await refreshLotteryDetail();
}
async function refreshLotteryDetail(){
  const target=lotteryTarget.value;if(!target||lotteryLoading.value)return;const request=++lotteryDetailRequest;lotteryLoading.value=true;lotteryError.value='';
  try{const record=await api(`sessions/${target.session}/lotteries/${target.record.id}`);
    if(request===lotteryDetailRequest&&target===lotteryTarget.value&&target.session===selected.value&&target.version===selectionGeneration)target.record=record;
  }catch(e){if(request===lotteryDetailRequest)lotteryError.value=e.message;}finally{if(request===lotteryDetailRequest)lotteryLoading.value=false;}
}
async function saveLotteryRemark(input){
  const target=lotteryTarget.value;if(!target||modalBusy.value||lotteryLoading.value)return;
  if(target.session!==selected.value||target.version!==selectionGeneration){lotteryError.value=ui.workbench.素材已切换请重新打开这条天选记录;return;}
  modalBusy.value=true;lotteryError.value='';
  try{const record=await api(`sessions/${target.session}/lotteries/${target.record.id}/note`,input);
    if(target===lotteryTarget.value&&target.session===selected.value&&target.version===selectionGeneration){target.record=record;lotteryEditing.value=false;invalidateMessages();await loadMessages(true);}
  }catch(e){lotteryError.value=e.message;}finally{modalBusy.value=false;}
}
function openMessageEditor(message){
  if(saving.value||!selectionReady.value||message.type!=='d')return;
  closeContext();messageEditTarget.value={session:selected.value,version:selectionGeneration,message:applyMessageEdit(message,edit.value.messageEdits)};modal.value='edit-message';
}
async function saveMessageText(patch){
  const target=messageEditTarget.value;
  if(!target||saving.value||modalBusy.value)return;
  if(selected.value!==target.session||selectionGeneration!==target.version){tell(ui.workbench.素材已切换请重新打开要编辑的弹幕);closeModal();return;}
  modalBusy.value=true;
  try{
    const patches={...(edit.value.messageEdits||{})};if(patch===null)delete patches[target.message.id];else patches[target.message.id]=patch;
    edit.value={...edit.value,messageEdits:patches};
    if(await save()){
      invalidateMessages();await Promise.all([loadMessages(true),loadOverlay()]);
      if(selected.value===target.session&&selectionGeneration===target.version){modalBusy.value=false;closeModal();tell(patch===null?ui.workbench.已恢复这条弹幕的原文:ui.workbench.已保存这条弹幕的昵称和内容,'success');}
    }
  }catch(e){tell(e.message);}finally{modalBusy.value=false;}
}
function messageMenuKey(event){const buttons=[...event.currentTarget.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);buttons[(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}
async function showContext(event,session){closeContext();const rect=event.currentTarget.getBoundingClientRect();sessionMenu.value={session,x:Math.max(8,Math.min(event.clientX||rect.left+30,window.innerWidth-248)),y:Math.max(8,event.clientY||rect.bottom)};await nextTick();const menu=document.querySelector('.session-context');if(menu&&sessionMenu.value)sessionMenu.value.y=Math.max(8,Math.min(sessionMenu.value.y,window.innerHeight-menu.offsetHeight-8));menu?.querySelector('button:not(:disabled)')?.focus();}
const cancellingJobIds=ref([]);
const retryExportIds=ref([]);
async function retryExportJob(job){
  if(!job?.canRetryExport||retryExportIds.value.includes(job.id))return;
  closeContext();retryExportIds.value.push(job.id);
  try{await api(`jobs/${encodeURIComponent(job.id)}/retry`,{});tell(ui.workbench.导出重试已安排,'success');await refresh();}
  catch(error){tell(error.message);}finally{retryExportIds.value=retryExportIds.value.filter(id=>id!==job.id);}
}
function jobCancellationBlock(job){return !job?ui.workbench.任务不存在:cancellingJobIds.value.includes(job.id)||job.status==='cancelling'?ui.workbench.正在取消请稍候:job.status==='saving'?ui.workbench.成片正在保存完成后可删除:!['queued','running','finalizing'].includes(job.status)?ui.workbench.该任务当前无法取消:'';}
async function cancelJob(job){
  const reason=jobCancellationBlock(job);if(reason){tell(reason);return;}
  closeContext();cancellingJobIds.value=[...cancellingJobIds.value,job.id];
  try{await api('jobs/'+encodeURIComponent(job.id)+'/cancel',{});tell(ui.workbench.导出已取消原始素材和已完成缓存保留,'success');await refresh();}
  catch(error){tell(error.message);}finally{cancellingJobIds.value=cancellingJobIds.value.filter(id=>id!==job.id);}
}
function jobRemovalBlock(job){return !job?ui.workbench.该导出任务已不存在:job.status==='save_failed'?ui.workbench.未保存成片禁止删除:['queued','running','finalizing','saving','cancelling'].includes(job.status)||retrySavingIds.value.includes(job.id)?ui.workbench.导出进行中禁止删除:!['done','failed','cancelled','canceled'].includes(job.status)?ui.workbench.该任务暂时无法删除:'';}
function jobStatusText(job){return ({queued:ui.workbench.等待导出,running:ui.workbench.正在导出,finalizing:ui.workbench.正在整理成片,saving:ui.workbench.正在保存,cancelling:ui.workbench.正在取消,interrupted:ui.workbench.待恢复,save_failed:ui.workbench.保存失败编码已完成,done:ui.workbench.导出完成,failed:ui.workbench.导出失败,cancelled:ui.workbench.已取消,canceled:ui.workbench.已取消})[job.status]||job.status;}
function jobDescription(job){return (job.scope==='full'?ui.workbench.完整素材:job.clipCount>1?ui.workbench.选段序号(job.clipIndex, job.clipCount):ui.workbench.选段)+' · '+(({clean:ui.workbench.纯净版,danmaku:ui.workbench.弹幕版,dual:ui.workbench.纯净弹幕双文件})[job.mode]||ui.workbench.视频)+' · '+date(job.created);}
function focusJob(id){bottomTab.value='jobs';void nextTick(()=>{const row=Array.from(document.querySelectorAll('.job-row')).find(element=>element.dataset.jobId===String(id));(row||document.querySelector('.jobs-panel'))?.focus({preventScroll:true});});}
function retrySaveReason(job){return !job?ui.workbench.该导出任务已不存在:retrySavingIds.value.includes(job.id)||job.status==='saving'?ui.workbench.正在提交或保存请稍候:job.status!=='save_failed'?ui.workbench.该任务当前不需要重试保存:job.canRetrySave!==true?ui.workbench.暂存成片暂不可用无法重试保存:'';}
async function openRetrySave(job){
  const blocked=retrySaveReason(job);if(blocked){tell(blocked);return;}closeContext();retrySaveTarget.value={id:job.id,scope:job.scope,description:jobDescription(job)};retrySaveDirectory.value=job.exportDirectory||'';retrySaveError.value='';modal.value='retry-save';await nextTick();document.querySelector('.retry-save-directory')?.focus();
}
async function browseRetryFolder(){
  if(modalBusy.value)return;const id=retrySaveTarget.value?.id;modalBusy.value=true;
  try{const value=await pickExportFolder(retrySaveDirectory.value);if(value&&modal.value==='retry-save'&&retrySaveTarget.value?.id===id)retrySaveDirectory.value=value;}
  catch(e){retrySaveError.value=e.message;}finally{modalBusy.value=false;}
}
async function retryJobSave(job,changeDirectory=false){
  const id=job?.id,current=state.value.jobs.find(item=>item.id===id),blocked=retrySaveReason(current);if(blocked){if(changeDirectory)retrySaveError.value=blocked;else tell(blocked);return;}
  if(changeDirectory&&(modal.value!=='retry-save'||retrySaveTarget.value?.id!==id||modalBusy.value))return;
  const directory=retrySaveDirectory.value.trim();if(changeDirectory&&!directory){retrySaveError.value=ui.workbench.请填写完整的保存文件夹路径;return;}
  retrySavingIds.value.push(id);delete jobRetryErrors.value[id];if(changeDirectory){modalBusy.value=true;retrySaveError.value='';}
  try{
    await api(`jobs/${encodeURIComponent(id)}/retry-save`,changeDirectory?{exportDirectory:directory}:{});
    if(disposing)return;
    const latest=state.value.jobs.find(item=>item.id===id);if(latest?.status==='save_failed'){latest.status='saving';latest.canRetrySave=false;latest.error='';}
    if(changeDirectory&&modal.value==='retry-save'&&retrySaveTarget.value?.id===id){modal.value='';retrySaveTarget.value=null;void nextTick(()=>focusJob(id));}
    tell(ui.workbench.已开始重试保存复用已编码的成片,'success');await refresh();
  }catch(e){if(disposing)return;jobRetryErrors.value[id]=e.message;if(changeDirectory&&modal.value==='retry-save'&&retrySaveTarget.value?.id===id)retrySaveError.value=e.message;else tell(e.message);await refresh();}
  finally{retrySavingIds.value=retrySavingIds.value.filter(value=>value!==id);if(changeDirectory)modalBusy.value=false;}
}
async function showJobContext(event,job){
  if(modal.value||modalBusy.value)return;closeContext();const rect=event.currentTarget.getBoundingClientRect(),keyboard=event.type==='keydown';
  jobMenu.value={id:job.id,x:Math.max(8,keyboard?rect.left+24:event.clientX),y:Math.max(8,keyboard?rect.bottom:event.clientY)};
  await nextTick();if(jobMenu.value?.id!==job.id)return;const menu=document.querySelector('.job-context');if(!menu)return;
  const bounds=menu.getBoundingClientRect();jobMenu.value.x=Math.max(8,Math.min(jobMenu.value.x,window.innerWidth-bounds.width-8));jobMenu.value.y=Math.max(8,Math.min(jobMenu.value.y,window.innerHeight-bounds.height-8));
  (menu.querySelector('button:not(:disabled)')||menu).focus({preventScroll:true});
}
async function loadJobDeletePreview(clearError=true){
  if(modal.value!=='delete-job'||!jobDeleteTarget.value)return;
  const id=jobDeleteTarget.value.id,request=++jobPreviewRequest;jobPreviewLoading.value=true;if(clearError)jobDeleteError.value='';
  try{const result=await api(`jobs/${encodeURIComponent(id)}/delete-preview`);if(request!==jobPreviewRequest||modal.value!=='delete-job'||jobDeleteTarget.value?.id!==id||disposing)return;if(result.id!==id||!Array.isArray(result.files)||(!result.blocked&&(typeof result.token!=='string'||!result.token.trim())))throw new Error(ui.workbench.无法核对该任务对应的导出文件请重试);jobDeletePreview.value=result;}
  catch(e){if(request===jobPreviewRequest&&modal.value==='delete-job'&&jobDeleteTarget.value?.id===id){jobDeletePreview.value=null;if(clearError||!jobDeleteError.value)jobDeleteError.value=e.message;}}
  finally{if(request===jobPreviewRequest)jobPreviewLoading.value=false;}
}
async function requestJobDelete(job){
  const blocked=jobRemovalBlock(job);if(blocked){tell(blocked);return;}closeContext();jobDeleteTarget.value={...job};jobDeletePreview.value=null;jobDeleteError.value='';jobDeleteRecordOnly.value=false;modal.value='delete-job';
  await nextTick();document.querySelector('.job-delete-cancel')?.focus();void loadJobDeletePreview();
}
async function confirmJobRemoval(){
  if(modal.value!=='delete-job'||modalBusy.value||jobDeleteBlock.value)return;
  const recordOnly=jobDeleteRecordOnly.value;
  if(!recordOnly&&(jobDeletePreview.value?.id!==jobDeleteTarget.value?.id||typeof jobDeletePreview.value?.token!=='string'||!jobDeletePreview.value.token.trim()))return;
  const id=jobDeleteTarget.value.id,token=jobDeletePreview.value?.token;modalBusy.value=true;jobDeleteError.value='';
  try{await api(`jobs/${encodeURIComponent(id)}/delete`,recordOnly?{confirmed:true,recordOnly:true}:{confirmed:true,token});state.value.jobs=state.value.jobs.filter(job=>job.id!==id);modal.value='';jobPreviewRequest++;jobDeleteTarget.value=null;jobDeletePreview.value=null;tell(recordOnly?ui.workbench.任务记录已移除现有文件保留:ui.workbench.导出任务删除成功,'success');await refresh();await nextTick();focusJob(id);}
  catch(e){jobDeleteError.value=e.message;if(!recordOnly)await loadJobDeletePreview(false);}
  finally{modalBusy.value=false;}
}
function requestDelete(session){closeContext();materialDeleteError.value='';confirmTarget.value={id:session.id,title:session.title,created:session.created,duration:session.duration};modal.value='delete-session';}
async function deleteRecording(id){
  // Only wait for acceptance; a disconnected page never cancels confirmed cleanup.
  return api('sessions/'+id+'/delete',{confirmed:true,background:true},{signal:AbortSignal.timeout(15000)});
}
function requestRemove(room){confirmTarget.value={...room};modal.value='remove-room';}
async function confirmRemoval(){if(!['remove-room','delete-session'].includes(modal.value)||!confirmTarget.value||modalBusy.value||deleteBlock.value)return;modalBusy.value=true;const kind=modal.value,target=confirmTarget.value;try{
  if(kind==='remove-room'){await api('anchors/'+target.key+'/remove',{confirmed:true});tell(ui.workbench.已移除监控主播已录制素材保留,'success');}
  else if(kind==='delete-session'){materialDeleteError.value='';await deleteRecording(target.id);requestedDeletions.set(target.id,target.title);if(selected.value===target.id)resetSelection();tell(ui.workbench.已开始后台清理可继续操作其他素材,'success');}
  modal.value='';void refresh();
}catch(e){if(kind==='delete-session'){materialDeleteError.value=e.name==='TimeoutError'?ui.workbench.清理确认超时:e.message;tell(materialDeleteError.value);void refresh();}else tell(e.message);}finally{modalBusy.value=false;}}
function statusText(s){return ({recording:ui.common.录制中,waiting:ui.common.等待重连,finishing:ui.workbench.整理中,finished:ui.workbench.已完成,importing:ui.workbench.整理中})[s]||s;}
function tell(text,kind='error'){noticeSequence.value++;notice.value=text;noticeKind.value=kind;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.value='',8000);}
const stateTransport=stateSync({read:signal=>api('state',undefined,{signal}),apply:applyState,connected:value=>connected.value=value,detail:()=>refreshDetail()});
async function refreshDetail(force=false){
  if(disposing||detailBusy||!selected.value||!selectionReady.value||(!force&&document.hidden))return;
  const id=selected.value,version=selectionGeneration,current=activeSession.value;
  const settled=detail.value?.id===id&&current?.status==='finished'&&detail.value.status==='finished'&&detail.value.duration===current.duration&&detail.value.sources.every(s=>s.metadata||!s.duration);
  if(!force&&settled&&Date.now()-detailRefreshedAt<30000)return;
  detailBusy=true;
  try{const result=await api(`sessions/${id}`,undefined,{signal:AbortSignal.timeout(8000)});if(!disposing&&selected.value===id&&version===selectionGeneration){detail.value=result;detailRefreshedAt=Date.now();if(previewEnded.value&&isPlaying.value)playNext();}}
  catch{}finally{detailBusy=false;}
}
async function refresh(){await stateTransport.refresh();await refreshDetail(true);}
async function choose(id){
  if(selected.value===id){closeContext();resetSelection();return;}
  const version=++selectionGeneration;senderFilter.value=null;
  detail.value=null;invalidateMessages();invalidateSignals(true);resetTimelineNavigation();
  previewTransport?.dispose();overlayWindow=null;closeContext();startMarked.value=false;endMarked.value=false;generation++;video.value?.pause();previewUrl.value='';isPlaying.value=false;loading.value=false;selected.value=id;detail.value=null;edit.value={revision:0,ranges:[],excluded:[],undo:[]};startExact.value=0;endExact.value=0;startText.value='00:00:00';endText.value='00:00:00';startDateText.value='';endDateText.value='';messages.value=[];giftRows.value=[];lotteryRows.value=[];giftFeed.value=[];overlayFeed.value=[];position.value=0;previewEnded.value=false;
  try{const result=await api(`sessions/${id}`);if(selected.value!==id||version!==selectionGeneration)return;detail.value=result;edit.value=result.edit;startExact.value=0;endExact.value=Math.min(10,result.duration);startText.value=format(0);endText.value=format(endExact.value);if(!canUseRecordingTime.value)positionMode.value='video';syncRecordingTexts();query.value='';lastMessageKey='';await Promise.all([loadMessages(true),loadOverlay()]);}
  catch(e){if(version===selectionGeneration)tell(e.message);}
}
async function save(){if(saving.value||!selectionReady.value)return false;const id=selected.value,version=selectionGeneration;saving.value=true;try{const result=await api(`sessions/${id}/edit`,{...edit.value,filterLottery:true});if(selected.value===id&&version===selectionGeneration){edit.value=result;return true;}return false;}catch(e){tell(e.message);if(selected.value===id&&version===selectionGeneration){const result=await api(`sessions/${id}`);if(selected.value===id&&version===selectionGeneration)edit.value=result.edit;}return false;}finally{saving.value=false;}}
async function addRoom(){
  if(addingRoom.value||modal.value||!roomUrl.value.trim())return;const entered=roomUrl.value.trim();addingRoom.value=true;
  try{
    const result=await api('anchors',{url:entered});if(disposing)return;
    if(result.needsSelection){roomChoice.value={...result,entered};roomChoicePlatform.value='';roomChoiceError.value='';modal.value='choose-room';await nextTick();document.querySelector('.room-choice-options input')?.focus();return;}
    if(roomUrl.value.trim()===entered)roomUrl.value='';tell(ui.workbench.主播已添加已开启自动监控,'success');await refresh();
  }catch(e){if(!disposing)tell(e.message);}finally{addingRoom.value=false;}
}
async function confirmRoomChoice(){
  const candidate=roomChoice.value?.candidates.find(room=>room.platform===roomChoicePlatform.value);if(modalBusy.value||!candidate)return;
  const entered=roomChoice.value.entered;modalBusy.value=true;roomChoiceError.value='';
  try{
    await api('anchors',{url:candidate.url});if(disposing)return;
    if(roomUrl.value.trim()===entered)roomUrl.value='';modal.value='';roomChoice.value=null;roomChoicePlatform.value='';tell(ui.workbench.主播已添加已开启自动监控,'success');await refresh();
  }catch(e){if(!disposing)roomChoiceError.value=e.message;}finally{modalBusy.value=false;}
}
async function roomAction(anchor,action,data={}){if(roomBusyIds.value.includes(anchor.key))return;roomBusyIds.value.push(anchor.key);try{await api(`anchors/${anchor.key}/${action}`,data);await refresh();}catch(e){tell(e.message);}finally{roomBusyIds.value=roomBusyIds.value.filter(id=>id!==anchor.key);}}
function containsTime(ranges,time){for(let i=0;i<ranges.length;i++)if(time>=ranges.start(i)&&time<ranges.end(i)-.05)return true;return false;}
async function playFrom(time,play=true){
  if(!canPreview.value)return;
  const available=detail.value?.sources||[];let target=Math.max(0,Math.min(time,Math.max(0,duration.value-.1)));
  let s=available.find(x=>x.start<=target+.02&&x.start+x.duration>=target-.02);
  if(!s){s=available.find(x=>x.start>target);if(!s){tell(ui.workbench.该位置暂时没有录制画面);return;}target=s.start;tell(ui.workbench.已跳过直播断流的空缺区间,'success');}
  const player=video.value,version=++generation;
  // Paused seeks must update the controls immediately, including while buffering.
  if(!play)pausePreview();
  const local=target-previewBase.value;
  // Growing fragmented MP4 can have buffered data but an empty seekable range.
  if(player&&previewUrl.value&&!previewEnded.value&&containsTime(player.buffered,local)&&containsTime(player.seekable,local)){
    player.currentTime=local;position.value=target;
    if(play){isPlaying.value=true;await player.play().catch(e=>{if(version===generation&&e.name!=='AbortError'){isPlaying.value=false;tell(e.message);}});}
    return;
  }
  previewBase.value=target;position.value=target;loading.value=true;previewEnded.value=false;isPlaying.value=play;void loadOverlay();
  previewTransport?.dispose();
  previewTransport=previewStream(`/api/sessions/${selected.value}/preview?start=${target.toFixed(4)}&v=${version}`,{client:previewClient,sequence:version,onError(error){if(version===generation){loading.value=false;isPlaying.value=false;previewEnded.value=true;tell(error.message);}}});
  previewUrl.value=previewTransport.url;
  await nextTick();if(version!==generation)return;
  video.value.load();applyPreviewAudio();previewTransport.start();
  if(play)await video.value.play().catch(e=>{if(version===generation&&e.name!=='AbortError'){isPlaying.value=false;loading.value=false;tell(ui.workbench.预览尚未就绪请稍后重试);}});
}
function applyPreviewAudio(){const player=video.value;if(!player)return;player.volume=previewVolume.value;player.muted=previewMuted.value||previewVolume.value===0;}
function rememberPreviewAudio(){const volume=previewVolume.value>0?previewVolume.value:previewVolumeHold;try{localStorage.setItem('preview-audio',JSON.stringify({volume,muted:previewMuted.value}));}catch{}}
function togglePreviewMute(){if(previewMuted.value||previewVolume.value===0){previewMuted.value=false;if(!(previewVolume.value>0))previewVolume.value=previewVolumeHold>0?previewVolumeHold:1;}else{previewVolumeHold=previewVolume.value;previewMuted.value=true;}applyPreviewAudio();rememberPreviewAudio();}
function setPreviewVolume(event){const value=Math.min(1,Math.max(0,Number(event.target.value)/100));if(value>0){previewVolume.value=value;previewVolumeHold=value;previewMuted.value=false;}else{previewVolumeHold=previewVolumeDragging&&previewVolumeAtDrag>0?previewVolumeAtDrag:previewVolume.value>0?previewVolume.value:previewVolumeHold;previewVolume.value=previewVolumeHold>0?previewVolumeHold:1;previewMuted.value=true;}applyPreviewAudio();rememberPreviewAudio();}
const previewVolumeOpen=ref(false);
let previewVolumeInside=false,previewVolumeDragging=false,previewVolumeAtDrag=1;
function openPreviewVolume(){previewVolumeInside=true;previewVolumeOpen.value=true;}
function leavePreviewVolume(){previewVolumeInside=false;if(!previewVolumeDragging)closePreviewVolume();}
function closePreviewVolume(){previewVolumeOpen.value=false;const active=document.activeElement;if(active instanceof HTMLElement&&active.closest('.preview-volume'))active.blur();}
function previewVolumeDown(){previewVolumeDragging=true;previewVolumeAtDrag=previewVolume.value>0?previewVolume.value:previewVolumeHold;}
function previewVolumeUp(){if(!previewVolumeDragging)return;previewVolumeDragging=false;if(!previewVolumeInside)closePreviewVolume();}
function pausePreview(){isPlaying.value=false;video.value?.pause();}
function releasePagePreview(){previewTransport?.dispose();generation++;pausePreview();loading.value=false;previewEnded.value=true;}
async function togglePlay(){if(isPlaying.value){pausePreview();return;}if(!previewUrl.value||previewEnded.value){await playFrom(position.value,true);return;}const version=generation;isPlaying.value=true;await video.value.play().catch(e=>{if(version===generation&&e.name!=='AbortError'){isPlaying.value=false;tell(ui.workbench.暂时无法播放请重新定位后重试);}});}
function played(){isPlaying.value=!!video.value&&!video.value.paused;}
function loaded(){loading.value=false;applyPreviewAudio();if(!isPlaying.value)video.value?.pause();}
function paused(){if(video.value?.paused&&!loading.value&&!video.value.ended)isPlaying.value=false;}
function updateTime(){if(video.value&&!scrubbing.value)position.value=Math.min(duration.value,previewBase.value+video.value.currentTime);}
function step(direction){pausePreview();void playFrom(position.value+direction/fps.value,false);}
function playNext(){const available=detail.value?.sources||[];const same=available.find(s=>s.start<=position.value&&s.start+s.duration>position.value+.15);if(same){void playFrom(position.value+1/fps.value,true);return;}const next=available.find(s=>s.start>previewBase.value+.1&&s.start>=position.value-.3&&s.duration>0);if(next)void playFrom(next.start,true);}
function ended(){previewEnded.value=true;loading.value=false;if(isPlaying.value)playNext();}
async function addRange(){if(saving.value||!selectionReady.value)return;const id=selected.value,version=selectionGeneration;try{const start=readMark('start'),end=readMark('end');if(start<0||end<=start||end>duration.value+.05)throw new Error(ui.workbench.请选择已录制范围内的起点和终点);edit.value.ranges.push({start,end:Math.min(end,duration.value),selected:true});if(await save()&&selected.value===id&&version===selectionGeneration)clearDraftMarks();}catch(e){tell(e.message);}}
async function selectRange(index,value){edit.value.ranges[index].selected=value;await save();}
async function selectAllRanges(value){for(const range of edit.value.ranges)range.selected=value;await save();}
async function removeRange(index){edit.value.ranges.splice(index,1);await save();}
async function moveRange(index,direction){const list=edit.value.ranges,[item]=list.splice(index,1);list.splice(index+direction,0,item);await save();}
async function toggleMessage(message){if(message.type==='lottery')return;const id=selected.value,version=selectionGeneration;if(excluded.value.has(message.id))edit.value.excluded=edit.value.excluded.filter(x=>x!==message.id);else {edit.value.excluded.push(message.id);edit.value.undo.push(message.id);}await save();if(id===selected.value&&version===selectionGeneration)void loadSignals(true);}
async function undoMessage(){const sessionId=selected.value,version=selectionGeneration,id=edit.value.undo.pop();if(!id)return;edit.value.excluded=edit.value.excluded.filter(x=>x!==id);await save();if(sessionId===selected.value&&version===selectionGeneration)void loadSignals(true);}
let automaticMessageRequest=false;
function pauseMessageFollow(){if(followMessages.value&&!messageFollowPaused.value){messageWindowAnchor.value=position.value;messageFollowPaused.value=true;}if(automaticMessageRequest&&dmBusy){messageRequest++;dmBusy=false;messageLoading.value=false;}}
// Keep the user's rail target through async loading and virtual-row measurement.
// Only an explicit list gesture or resuming follow can hand control back.
function startMessageNavigation(){messageNavigationPinned.value=true;pauseMessageFollow();}
function manualMessageScroll(){messageNavigationPinned.value=false;pauseMessageFollow();}
function syncMessageBrowseTime(time){if(!messageNavigationPinned.value)messageBrowseTime.value=time;}
function jumpMessages(time){startMessageNavigation();const target=messageTime(time,duration.value);messageBrowseTime.value=target;void loadMessages(true,undefined,target);}
function resumeMessageFollow(){messageNavigationPinned.value=false;messageFollowPaused.value=false;void loadMessages(true);}
function assignFeed(rows){messages.value=rows.filter(row=>row.type==='d');giftRows.value=rows.filter(row=>row.type!=='d'&&row.type!=='lottery');lotteryRows.value=rows.filter(row=>row.type==='lottery');}
async function loadMessages(force=false,direction,at){
  if(!selectionReady.value||!danmakuVisible.value||document.hidden)return;
  if(dmBusy){if(!force)return;messageRequest++;dmBusy=false;}
  const scope={...messageRange.value},target=at!==undefined?Math.max(scope.from,Math.min(scope.to,at)):followMessages.value?messageTime(position.value,duration.value):undefined;
  if(!force&&!direction&&(messageFollowPaused.value||messageMenu.value||modal.value))return;
  const id=selected.value,version=selectionGeneration,key=`${id}:${followMessages.value?Math.floor(position.value/5):'all'}:${query.value}:${showGifts.value}:${onlyGifts.value}:${JSON.stringify(senderFilter.value)}`;
  if(!force&&!direction&&key===lastMessageKey)return;
  const request=++messageRequest;dmBusy=true;messageLoading.value=true;automaticMessageRequest=!force&&!direction;
  const anchor=messageList.value?.capture(),current=()=>request===messageRequest&&version===selectionGeneration&&id===selected.value;
  try{
    const params=new URLSearchParams({q:query.value,gifts:showGifts.value?'1':'0',onlyGifts:onlyGifts.value?'1':'0',from:String(scope.from),to:String(scope.to)});
    if(senderFilter.value)params.set('sender',JSON.stringify(senderFilter.value));
    if(direction){const row=direction==='before'?visibleMessages.value[0]:visibleMessages.value.at(-1);if(row)params.set('cursor',JSON.stringify({time:row.time,key:feedKey(row)}));params.set('direction',direction);}
    else if(target!==undefined)params.set('at',String(target));
    const result=await api(`sessions/${id}/feed?${params}`);if(!current())return;
    let rows=result.rows;
    if(!direction&&followMessages.value){
      // Follow mode queries only the current +/- 60 second window.
      // Dense windows stay paginated; no chat timestamp sets media duration.
      while(result.hasBefore&&rows.length<2400&&rows[0]?.time>scope.from){
        params.delete('at');params.set('direction','before');params.set('cursor',JSON.stringify(result.before));
        const previous=await api(`sessions/${id}/feed?${params}`);if(!current())return;
        rows=[...previous.rows,...rows];result.before=previous.before;result.hasBefore=previous.hasBefore;if(!previous.rows.length)break;
      }
    }
    if(!direction&&followMessages.value){
      while(result.hasAfter&&rows.length+300<=3000&&rows.at(-1)?.time<scope.to){
        params.delete('at');params.set('direction','after');params.set('cursor',JSON.stringify(result.after));
        const next=await api(`sessions/${id}/feed?${params}`);if(!current())return;
        rows=[...rows,...next.rows];result.after=next.after;result.hasAfter=next.hasAfter;if(!next.rows.length)break;
      }
    }
    if(direction){
      const merged=new Map([...visibleMessages.value,...rows].map(row=>[feedKey(row),row]));
      rows=[...merged.values()].sort((a,b)=>a.time-b.time||(feedKey(a)<feedKey(b)?-1:1));
      const page={...messagePage.value};
      if(direction==='before'){page.before=result.before||page.before;page.hasBefore=result.hasBefore;if(rows.length>3000){rows=rows.slice(0,3000);page.hasAfter=true;}}
      else {page.after=result.after||page.after;page.hasAfter=result.hasAfter;if(rows.length>3000){rows=rows.slice(-3000);page.hasBefore=true;}}
      const cursor=row=>row?{time:row.time,key:`${row.type==='d'?'d':row.type==='lottery'?'l':'g'}:${row.id}`}:null;
      page.before=cursor(rows[0]);page.after=cursor(rows.at(-1));messagePage.value=page;
    }else messagePage.value={before:result.before,after:result.after,hasBefore:result.hasBefore,hasAfter:result.hasAfter};
    assignFeed(rows);lastMessageKey=key;
    await nextTick();if(!current())return;
    if(at!==undefined){messageList.value?.scrollToTime(target);}else if(direction||messageFollowPaused.value)await messageList.value?.restore(anchor);else if(followMessages.value)followMessagePosition();else messageList.value?.reset();
    const lottery=lotteryTarget.value,summary=lottery&&lotteryRows.value.find(x=>x.id===lottery.record.id);
    if(modal.value==='lottery'&&!lotteryEditing.value&&!modalBusy.value&&summary&&(summary.state!==lottery.record.state||summary.winnerCount!==lottery.record.winnerCount||summary.revision!==lottery.record.revision))void refreshLotteryDetail();
  }catch(e){if(current())tell(e.message);}finally{if(request===messageRequest){dmBusy=false;messageLoading.value=false;}}
}
function loadMessagePage(direction){pauseMessageFollow();return loadMessages(false,direction);}
function sameMessages(a,b){return a.length===b.length&&a.every((m,i)=>m.id===b[i].id&&m.time===b[i].time&&m.text===b[i].text&&m.color===b[i].color&&m.user===b[i].user&&m.senderId===b[i].senderId&&m.senderPlatform===b[i].senderPlatform&&m.edited===b[i].edited&&m.originalUser===b[i].originalUser&&m.originalText===b[i].originalText);}
function followMessagePosition(){
  if(!followMessages.value||messageFollowPaused.value||messageMenu.value||modal.value||!danmakuVisible.value)return;
  syncMessageBrowseTime(position.value);messageList.value?.scrollToTime(position.value);
}
watch([position,followMessages,danmakuVisible],followMessagePosition,{flush:'post'});
watch(danmakuVisible,value=>{if(value)void loadMessages(true);});
watch(selected,()=>{messageFollowPaused.value=false;messageWindowAnchor.value=0;messageBrowseTime.value=0;messageNavigationPinned.value=false;messagePage.value={hasBefore:false,hasAfter:false};});
let giftFeedBusy=false;
async function loadGiftOverlay(){
  if(!showGifts.value||!selectionReady.value||giftFeedBusy){if(!showGifts.value)giftFeed.value=[];return;}
  const id=selected.value,version=selectionGeneration,from=Math.max(0,position.value-10);giftFeedBusy=true;
  try{const events=await api(`sessions/${id}/gifts?from=${from}&to=${from+60}`);if(version===selectionGeneration&&id===selected.value&&showGifts.value)giftFeed.value=events;}catch{}finally{giftFeedBusy=false;}
}
async function loadOverlay(){
  if(document.hidden)return;
  void loadGiftOverlay();if(!showOverlay.value)return;
  if(!selectionReady.value||overlayBusy)return;const id=selected.value,t=position.value,version=selectionGeneration;
  if(containsOverlay(overlayWindow,id,t))return;
  const from=Math.max(0,t-45),to=t+35,recordedDuration=duration.value,finished=activeSession.value?.status==='finished',request=++overlayRequest;overlayBusy=true;
  try{const result=await api(`sessions/${id}/messages?from=${from}&to=${to}&overlay=1`);if(request===overlayRequest&&version===selectionGeneration&&id===selected.value){if(!sameMessages(overlayFeed.value,result))overlayFeed.value=result;overlayWindow=makeOverlayWindow(id,from,to,recordedDuration,finished,result);}}
  catch{}finally{if(request===overlayRequest)overlayBusy=false;}
}
let applyingUpdate=false;
watch(()=>[state.value.updates?.status,state.value.updates?.autoInstall,state.value.updates?.installBlocked],async()=>{
  const update=state.value.updates;
  if(!isDesktop||applyingUpdate||update?.status!=='ready'||!update.autoInstall||update.installBlocked)return;
  applyingUpdate=true;
  try{tell(ui.workbench.正在准备更新完成后自动重新打开);await applyUpdate();}
  catch(error){tell(error.message);if(!/已有任务|等待当前|有录制任务/.test(error.message))await api('updates/cancel',{}).catch(()=>{});}
  finally{applyingUpdate=false;}
});
async function openUpdateSettings(){openSettings();await nextTick();document.querySelector('.update-settings')?.scrollIntoView({block:'center'});}
function openSettings(){const current=state.value.paths?.exports||'';savedExportDirectory.value=current;exportDirectory.value=current;closeActionError.value='';modal.value='settings';}
async function applyDanmakuSettings(result){const rateChanged=state.value.danmakuPerSecond!==result.danmakuPerSecond;state.value={...state.value,highlightStyle:result.highlightStyle,danmakuStyle:result.danmakuStyle,danmakuPerSecond:result.danmakuPerSecond,danmakuFont:result.danmakuFont};if(rateChanged){invalidateMessages();invalidateSignals(true);await Promise.all([loadMessages(true),loadOverlay()]);}}
async function setCloseAction(value){if(closeActionBusy.value)return;closeActionBusy.value=true;closeActionDraft.value=value;closeActionError.value='';try{const result=await api('settings',{closeAction:value});state.value={...state.value,closeAction:result.closeAction};await refresh();}catch(e){closeActionError.value=e.message;}finally{closeActionDraft.value=null;closeActionBusy.value=false;}}
function openExport(){if(!selected.value||!selectedRanges.value.length){tell(ui.workbench.请先勾选至少一个选段);return;}exportScope.value='clips';exportTarget.value={id:selected.value,title:activeSession.value?.title};exportRanges.value=selectedRanges.value.map(r=>({start:r.start,end:r.end}));exportExcluded.value=edit.value.excluded.length;exportMode.value='dual';exportGifts.value=state.value.giftStyle?.export===true;exportDirectory.value=state.value.paths?.exports||'';modal.value='export';}
function openFullExport(session){const latest=state.value.sessions.find(s=>s.id===session.id),blocked=latest?fullExportBlock(latest):ui.workbench.素材已被删除;if(blocked){tell(blocked);return;}closeContext();exportScope.value='full';exportTarget.value={id:latest.id,title:latest.title};exportRanges.value=[];exportExcluded.value=0;exportMode.value='dual';exportGifts.value=state.value.giftStyle?.export===true;exportDirectory.value=state.value.paths?.exports||'';modal.value='export';}
async function browseFolder(){try{const value=await pickExportFolder(exportDirectory.value);if(!value)return;exportDirectory.value=value;if(modal.value==='settings')await commitExportDirectory();}catch(e){tell(e.message);}}
async function commitExportDirectory(){if(modal.value!=='settings'||modalBusy.value)return;const value=exportDirectory.value.trim();if(!value){if(exportDirectory.value!==savedExportDirectory.value)tell(ui.workbench.请填写导出文件夹的完整路径);return;}if(value===savedExportDirectory.value)return;modalBusy.value=true;try{const result=await api('settings',{exportDirectory:value});const saved=result.paths?.exports||value;savedExportDirectory.value=saved;exportDirectory.value=saved;await refresh();tell(ui.workbench.默认导出文件夹已保存,'success');}catch(e){tell(e.message);}finally{modalBusy.value=false;}}
async function openFolder(input){try{await api('folders/open',input);}catch(e){tell(e.message);}}
function searchChanged(){messageNavigationPinned.value=false;messageBrowseTime.value=followMessages.value?position.value:0;lastMessageKey='';messageFollowPaused.value=false;messageRequest++;dmBusy=false;clearTimeout(queryTimer);queryTimer=setTimeout(()=>loadMessages(true),250);}
async function exportClip(){if(modalBusy.value)return;if(exportBlock.value){tell(exportBlock.value);return;}modalBusy.value=true;const target=exportTarget.value.id,scope=exportScope.value;try{const result=await api(`sessions/${target}/export`,{scope,mode:exportMode.value,giftsEnabled:exportMode.value!=='clean'&&exportGifts.value,...(scope==='clips'?{ranges:exportRanges.value}:{}),exportDirectory:exportDirectory.value});modal.value='';tell(scope==='full'?ui.workbench.完整素材已加入导出队列:ui.workbench.导出任务已创建(result.jobs?.length??1),'success');await refresh();}catch(e){tell(e.message);}finally{modalBusy.value=false;}}
function onKey(e){if(e.key==='Escape'){const jobId=jobMenu.value?.id;closeContext();closeModal();if(jobId)focusJob(jobId);return;}if(sessionMenu.value||jobMenu.value||messageMenu.value)return;if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)||modal.value)return;if(e.code==='Space'){e.preventDefault();void togglePlay();}else if(e.code==='ArrowLeft'){e.preventDefault();step(-1);}else if(e.code==='ArrowRight'){e.preventDefault();step(1);}else if(e.key.toLowerCase()==='i')setMark('start');else if(e.key.toLowerCase()==='o')setMark('end');}
watch([selectionReady,selected],()=>{invalidateSignals(true);void loadSignals(true);});
watch(()=>[selected.value,previewUrl.value],()=>{recordingCameraEvents.value=[];});
watch(timelineWindow,()=>{signalsError.value='';queueWindowSignals(false);},{flush:'sync'});
watch(position,value=>{if(timelineAutoFollow.value&&!timelineDragging.value&&!scrubbing.value&&timelineWindow.value)setTimelineWindow(followWindow(duration.value,timelineWindow.value,value));});
let lastInteraction=0;
function interactivePriority(){if(Date.now()-lastInteraction<1000||!state.value.preparation?.items?.some(item=>item.status==='preparing'))return;lastInteraction=Date.now();void api('interaction',{}).catch(()=>{});}
onMounted(()=>{window.addEventListener('pointerdown',interactivePriority,{passive:true});window.addEventListener('wheel',interactivePriority,{passive:true});stateTransport.start();messageTimer=setInterval(()=>{void loadMessages(false);void loadOverlay();},1500);signalsTimer=setInterval(()=>void loadSignals(),3000);document.addEventListener('visibilitychange',signalsVisibility);window.addEventListener('keydown',onKey);window.addEventListener('pointerdown',closeContext);window.addEventListener('pointerup',previewVolumeUp);window.addEventListener('pointercancel',previewVolumeUp);window.addEventListener('blur',closeContext);});
onMounted(()=>window.addEventListener('pagehide',releasePagePreview));
onBeforeUnmount(()=>window.removeEventListener('pagehide',releasePagePreview));
onBeforeUnmount(()=>{window.removeEventListener('pointerdown',interactivePriority);window.removeEventListener('wheel',interactivePriority);previewTransport?.dispose();disposing=true;clearTimeout(windowSignalTimer);invalidateSignals();invalidateMessages();stateTransport.close();clearInterval(messageTimer);clearInterval(signalsTimer);clearTimeout(queryTimer);clearTimeout(noticeTimer);document.removeEventListener('visibilitychange',signalsVisibility);window.removeEventListener('keydown',onKey);window.removeEventListener('pointerdown',closeContext);window.removeEventListener('pointerup',previewVolumeUp);window.removeEventListener('pointercancel',previewVolumeUp);window.removeEventListener('blur',closeContext);});
onMounted(()=>{panelBreakpoint.addEventListener('change',updatePanelBreakpoint);compactBreakpoint.addEventListener('change',updatePanelBreakpoint);});
onBeforeUnmount(()=>{panelBreakpoint.removeEventListener('change',updatePanelBreakpoint);compactBreakpoint.removeEventListener('change',updatePanelBreakpoint);});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><img class="brand-icon" :src="appIcon" alt="" width="30" height="30"/><strong>{{ ui.workbench.菜播录包机 }}</strong></div>
      <div class="top-actions"><button class="button subtle panel-toggle" :aria-label="ui.workbench.切换素材栏" @keydown.stop :aria-expanded="libraryVisible" aria-controls="library-panel" :title="ui.workbench.展开或收起主播与素材栏" @click="libraryPreference=!libraryVisible"><Film :size="16"/><span>{{ ui.workbench.素材 }}</span></button><button class="button subtle panel-toggle" :aria-label="ui.workbench.切换弹幕栏" @keydown.stop :aria-expanded="danmakuVisible" aria-controls="danmaku-panel" :title="ui.workbench.展开或收起弹幕列表" @click="danmakuPreference=!danmakuVisible"><Radio :size="16"/><span>{{ ui.workbench.弹幕 }}</span></button><span class="core-status" :title="state.recorder.error"><i :class="{online:state.recorder.online}"/>{{ coreStatus }}</span><button class="button subtle" @click="openSettings"><Settings :size="16"/><span>{{ ui.workbench.设置 }}</span></button></div>
    </header>
    <div class="notification-stack">
    <DismissibleNotice v-if="state.updates?.candidate&&(state.updates.status==='downloading'||state.updates.autoInstall)" v-show="!modal" class="update-reminder" :aria-label="ui.workbench.更新进度" :close-label="ui.workbench.关闭更新进度" :key="state.updates.candidate.key"><div><strong>{{ state.updates.status==='downloading'?ui.workbench.正在下载更新:ui.workbench.更新已准备好 }}</strong><p>{{ state.updates.candidate.version }} · {{ state.updates.status==='downloading'?ui.workbench.下载完成并校验后再安装:state.updates.installBlocked||ui.workbench.将在空闲时更新并重新打开 }}</p></div><button class="button small" @click="openUpdateSettings">{{ ui.workbench.查看进度 }}</button></DismissibleNotice>
    <DismissibleNotice v-if="state.recovery?.safeMode||state.recovery?.recovering||state.recovery?.isolatedRecords||state.recovery?.coreConfigRecovered||state.recovery?.error" class="update-reminder" :aria-label="ui.workbench.数据恢复" :close-label="ui.workbench.关闭数据恢复提示" :key="recoveryNoticeKey" role="status"><div><strong>{{ state.recovery.safeMode?ui.workbench.已启用安全数据区:state.recovery.recovering?ui.workbench.正在恢复上次任务:ui.workbench.旧数据异常已隔离 }}</strong><p>{{ state.recovery.safeMode?ui.workbench.安全数据区说明:state.recovery.error|| (state.recovery.recovering?ui.workbench.界面已打开任务恢复完成后可继续操作:state.recovery.coreConfigRecovered?ui.workbench.配置恢复说明:ui.workbench.异常数据恢复说明) }}</p></div><button v-if="state.recovery.safeMode" class="button small" @click="openFolder({kind:'retained'})"><FolderOpen :size="16"/>{{ ui.workbench.查看旧录像 }}</button></DismissibleNotice>
    </div>
    <div class="workspace" :class="{'library-collapsed':!libraryVisible,'danmaku-collapsed':!danmakuVisible}">
      <aside id="library-panel" v-show="libraryVisible" class="library">
        <button v-if="pendingCleanup.length" class="button subtle" @click="openCleanup">{{ ui.workbench.素材清理进度查看 }}</button>
        <section class="room-section" :aria-label="ui.workbench.监控主播"><h2><Radio :size="17"/>{{ ui.workbench.监控主播 }}</h2>
          <form class="room-form" @submit.prevent="addRoom"><input v-model="roomUrl" :aria-label="ui.workbench.主播直播间或抖音名片分享内容" :placeholder="ui.workbench.链接或分享内容" :disabled="addingRoom"/><button class="button primary small" type="submit" :disabled="addingRoom||!state.recorder.online||!roomUrl.trim()"><LoaderCircle v-if="addingRoom" class="spin" :size="15"/><span v-else>{{ ui.workbench.添加 }}</span></button></form>
          <p v-if="!state.recorder.online||!state.recorder.biliOnline&&state.recorder.error" class="room-offline" role="status">{{ state.recorder.error || ui.workbench.正在连接录制服务 }}</p>
          <MonitoredAnchors :anchors="state.anchors||[]" :recorder="state.recorder" :busy="roomBusyIds" @action="roomAction" @remove="requestRemove"/>
        </section>
        <section class="recording-section"><div class="section-heading"><h2><Film :size="17"/>{{ ui.workbench.录像素材 }}</h2></div>
          <div v-if="!state.sessions.length" class="rail-empty">{{ ui.workbench.暂无录像素材 }}</div>
          <button v-for="session in state.sessions" :key="session.id" class="session-item" :class="{selected:selected===session.id}" :aria-pressed="selected===session.id" @click="choose(session.id)" @contextmenu.prevent="showContext($event,session)" @keydown.shift.f10.prevent="showContext($event,session)" @keydown.context-menu.prevent="showContext($event,session)" :title="selected===session.id?ui.workbench.再次点击取消选中右键管理素材:ui.workbench.点击选择素材右键管理素材"><Film :size="20"/><span><strong>{{ session.hostName||session.title }}</strong><span v-if="session.captureKinds?.length" class="capture-badges"><span v-for="kind in session.captureKinds" :key="kind" class="capture-badge">{{ kind==='guest'?ui.workbench.连麦:ui.workbench.直播 }}</span></span><small v-if="session.hostName&&session.hostName!==session.title">{{ session.title }}</small><small v-for="entry in session.monitoring?.filter(item=>item.kind==='guest')||[]" :key="entry.uid+'-'+entry.host">{{ entry.name }} {{ ui.workbench.在 }} {{ entry.host }} {{ ui.workbench.的直播间连麦 }}</small><small>{{ date(session.created) }}</small><span class="session-meta"><i v-if="session.status==='recording'" class="live-dot online"/>{{ statusText(session.status) }} · {{ format(session.duration) }}</span></span></button>
        </section>
        <footer class="library-credit"><p>{{ ui.workbench.软件作者瞌睡小菜包 }}</p><p>{{ ui.workbench.技术支持藤椒麦旋风 }}</p><p>{{ ui.workbench.菜包宇宙 }}<a href="https://www.caibao.media/" @click.prevent="openStudioPage">www.caibao.media</a></p><p><a href="https://space.bilibili.com/5162836" @click.prevent="openAuthorPage">{{ ui.workbench.联系我们 }}</a></p></footer>
      </aside>
      <main class="editor">
        <div class="editor-heading"><div><Film :size="21"/><h1>{{ activeSession?.hostName||activeSession?.title||ui.workbench.直播剪辑工作台 }}</h1><span v-if="activeSession?.status==='recording'" class="recording-label"><i class="live-dot online"/>{{ ui.common.录制中 }}</span></div></div>
        <div v-if="activeSession?.error" class="inline-warning"><AlertCircle :size="16"/><span>{{ activeSession.error }}</span></div>
        <div class="video-stage" :class="{'preview-selected':!!selected}">
          <video v-if="previewUrl" ref="video" :src="previewUrl" playsinline preload="auto" @loadeddata="loaded" @canplay="loaded" @timeupdate="updateTime" @play="played" @pause="paused" @waiting="loading=true" @playing="loading=false" @ended="ended" @error="loading=false;tell(ui.workbench.预览读取错误)" @click="togglePlay"/>
          <div v-if="!previewUrl" class="preview-empty"><button class="preview-start" :disabled="!canPreview" @click="togglePlay"><Play v-if="canPreview" :size="42"/><Video v-else :size="42"/></button><strong>{{ canPreview?ui.workbench.播放预览:selected?ui.workbench.等待录制画面:ui.workbench.选择一段录像 }}</strong></div>
          <div v-if="loading" class="video-loading"><LoaderCircle :size="30" class="spin"/><span>{{ ui.workbench.正在读取画面 }}</span></div>
          <RecordingLayout v-if="previewUrl" :video="video" :events="recordingCameraEvents" :style="state.recordingStyle" :base="previewBase" :loading="loading"/>
          <DanmakuOverlay v-if="previewUrl" @font-error="tell(ui.workbench.字体未能加载请在设置中重新导入)" :font="state.danmakuFont" :style="state.danmakuStyle" :video="video" :base="previewBase" :messages="overlayFeed" :highlighted="highlighted" :highlight-style="state.highlightStyle" :message-edits="edit.messageEdits" :excluded="excluded" :enabled="showOverlay" :loading="loading"/>
          <LinkmicOverlay v-if="previewUrl" @cameras="recordingCameraEvents=$event" :session="selected" :video="video" :base="previewBase" :loading="loading"/>
          <GiftOverlay :events="giftFeed.filter(g=>!excluded.has(g.id))" :time="position" :enabled="showGifts" :video="video" :loading="loading"/>
          <RecordingTimestamp v-if="previewUrl&&state.previewTimestamp===true&&selectionReady" :video="video" :base="previewBase" :session="activeSession" :sources="detail?.sources" :loading="loading" :timestamp-style="state.previewTimestampStyle" :timestamp-position="state.previewTimestampPosition"/>
        </div>
        <div class="playback-toolbar"><div class="playback-left"><button class="icon-button" :aria-label="ui.workbench.上一帧" :title="ui.workbench.上一帧左方向键" :disabled="!canPreview" @click="step(-1)"><StepBack :size="21"/></button><button class="icon-button play" :disabled="!canPreview" :aria-label="isPlaying?ui.workbench.暂停:ui.workbench.播放" @click="togglePlay"><Pause v-if="isPlaying" :size="25"/><Play v-else :size="25"/></button><button class="icon-button" :aria-label="ui.workbench.下一帧" :title="ui.workbench.下一帧右方向键" :disabled="!canPreview" @click="step(1)"><StepForward :size="21"/></button><div class="preview-volume" :class="{open:previewVolumeOpen}" @pointerenter="openPreviewVolume" @pointerleave="leavePreviewVolume" @pointerdown="previewVolumeDown"><button type="button" class="icon-button" :disabled="!canPreview" :aria-pressed="previewMuted||previewVolume===0" :aria-label="previewMuted||previewVolume===0?ui.workbench.恢复预览声音:ui.workbench.静音预览" :title="(previewMuted||previewVolume===0?ui.workbench.预览已静音点击恢复声音:ui.workbench.点击静音预览)+ui.workbench.只改变这里的播放导出视频的声音不变" @click="togglePreviewMute"><VolumeX v-if="previewMuted||previewVolume===0" :size="18"/><Volume1 v-else-if="previewVolume<0.5" :size="18"/><Volume2 v-else :size="18"/></button><div class="preview-volume-pop"><div class="preview-volume-rotator"><input type="range" min="0" max="100" step="1" :value="Math.round(previewSlider*100)" :disabled="!canPreview" :aria-label="ui.workbench.预览音量" :title="ui.workbench.预览音量预览音量+Math.round(previewSlider*100)+'%'" @input="setPreviewVolume"/></div></div></div><span class="playback-time">{{ format(position) }} <span>/ {{ format(duration) }}</span></span></div><div class="playback-right"><button class="button subtle" :disabled="!canPreview" @click="playFrom(Math.max(0,duration-3),true)"><RotateCcw :size="16"/>{{ ui.workbench.回到最新 }}</button><label class="checkbox"><input v-model="showOverlay" type="checkbox"/>{{ ui.workbench.弹幕预览 }}</label><label class="checkbox"><input v-model="showGifts" type="checkbox" @change="changeGiftPreview"/>{{ ui.common.展示礼物 }}</label></div></div>
        <section class="timeline-section" :aria-label="ui.workbench.连续录像时间轴" :data-view-from="viewport.from" :data-view-to="viewport.to">
          <div v-if="coverage.gaps.length" class="recording-gap-notice" role="status"><AlertCircle :size="15"/><div><strong>{{ ui.workbench.有 }} {{ coverage.gaps.length }} {{ ui.workbench.处录制空档共 }} {{ format(coverage.missing) }}</strong><span>{{ ui.workbench.时间跨度 }} {{ format(duration) }} {{ ui.workbench.可用片段 }} {{ format(coverage.available) }}{{ ui.workbench.空档定位说明 }}</span></div></div>
          <div class="timeline-view-controls"><span class="timeline-window-label">{{ timelineWindow?(timelineAutoFollow?ui.workbench.跟随播放:ui.workbench.手动查看):ui.workbench.全场 }} · {{ format(viewSpan) }}</span><div class="timeline-zoom" role="group" :aria-label="ui.workbench.时间轴查看范围" @keydown.stop>
            <button class="timeline-zoom-icon" type="button" :aria-label="ui.workbench.缩小时间轴" :title="ui.workbench.缩小时间轴显示更长范围" :disabled="!canPreview||viewSpan>=duration-.001" @click="zoomTimeline(2)"><Minus :size="14"/></button>
            <button class="timeline-zoom-icon" type="button" :aria-label="ui.workbench.放大时间轴" :title="ui.workbench.放大时间轴最小查看10秒" :disabled="!canPreview||viewSpan<=Math.min(10,duration)+.001" @click="zoomTimeline(.5)"><Plus :size="14"/></button>
            <button type="button" :disabled="!canPreview" :aria-pressed="!!timelineWindow&&Math.abs(viewSpan-Math.min(120,duration))<.001" :title="ui.workbench.以当前播放位置为中心查看两分钟" @click="focusTimeline">{{ ui.workbench.选项2分钟 }}</button>
            <button type="button" :disabled="!canPreview" :aria-pressed="!timelineWindow" @click="setTimelineWindow(null)">{{ ui.workbench.全场 }}</button>
            <button type="button" :disabled="!canPreview||!timelineWindow" :title="ui.workbench.回到播放位置并恢复时间轴自动跟随" :aria-pressed="timelineAutoFollow" @click="returnToPosition"><Target :size="12"/>{{ ui.workbench.回到播放位置 }}</button>
          </div></div>
          <div class="ruler"><span v-for="n in 5" :key="n" :class="{'ruler-quarter':n===2||n===4}">{{ format(viewport.from+(viewport.to-viewport.from)*(n-1)/4) }}</span></div>
          <div id="timeline-tracks" class="timeline-tracks"><div class="timeline"><div class="timeline-track"/>
            <TimelineSignals kind="audio" :audio="signals?.audio" :from="viewport.from" :to="viewport.to" :data-from="signals?.from??viewport.from" :data-to="signals?.to??viewport.to" :selected="selectionReady" :loading="signalsLoading" :error="signalsError"/>
            <div v-for="{gap,view} in visibleGaps" :key="gap.start" class="recording-gap" :style="rangeStyle(view)" :aria-label="ui.workbench.录制空档+format(gap.start)+ui.workbench.至+format(gap.end)"/>
            <div v-if="draftView" class="draft-range" :style="rangeStyle(draftView)"/>
            <TimelineMarker v-if="inViewport(draftStart)||activeMarker==='start'" kind="start" :duration="duration" @pan="panTimeline" :time="draftStart" :from="viewport.from" :to="viewport.to" :min="0" :max="draftEnd!==null&&draftEnd>0?draftEnd-.001:duration" :fps="fps" :disabled="!canPreview||saving" @change="dragMark('start',$event)" @commit="previewMark" @start="timelineDragging=true;activeMarker='start';timelineAutoFollow=false" @end="endTimelineDrag"/>
            <TimelineMarker v-if="inViewport(draftEnd)||activeMarker==='end'" kind="end" :duration="duration" @pan="panTimeline" :time="draftEnd" :from="viewport.from" :to="viewport.to" :min="draftStart!==null&&draftStart<duration?draftStart+.001:0" :max="duration" :fps="fps" :disabled="!canPreview||saving" @change="dragMark('end',$event)" @commit="previewMark" @start="timelineDragging=true;activeMarker='end';timelineAutoFollow=false" @end="endTimelineDrag"/>
            <div v-for="{range,index,view} in visibleRanges" :key="index" class="range-highlight" :class="{unselected:range.selected===false}" :title="ui.workbench.选段选段+(index+1)+'：'+format(range.start)+' → '+format(range.end)" :style="rangeStyle(view)"/>
            <div v-if="inViewport(position)" class="playhead" :style="{left:timelinePercent(position)+'%'}"/>
            <TimelineScrubber :from="viewport.from" :to="viewport.to" :duration="duration" :time="position" :disabled="!canPreview" @start="scrubbing=true;timelineDragging=true;timelineAutoFollow=false" @change="position=$event" @commit="playFrom($event,isPlaying)" @pan="panTimeline" @end="endTimelineDrag"/>
          </div>
          <TimelineSignals kind="density" :density="signals?.density" :from="viewport.from" :to="viewport.to" :data-from="signals?.from??viewport.from" :data-to="signals?.to??viewport.to" :position="position" :selected="selectionReady" :loading="signalsLoading" :error="signalsError" :disabled="!canPreview" @seek="playFrom($event,isPlaying)"/>
          </div>
          <TimelineNavigator :key="selected||'empty'" :duration="duration" :from="viewport.from" :to="viewport.to" :disabled="!canPreview" @pan="panTimeline" @start="timelineDragging=true" @end="endTimelineDrag"/>
          <div v-if="startMarked||endMarked" class="marker-summary" aria-live="polite"><span class="start-color">{{ draftStart===null?ui.workbench.起点未标记或超出范围:ui.workbench.I起点+format(draftStart) }}</span><span class="end-color">{{ draftEnd===null?ui.workbench.终点未标记或超出范围:ui.workbench.O终点+format(draftEnd) }}</span><span v-if="draftDuration!==null" class="selection-duration">{{ ui.workbench.片段时长 }} {{ format(displayedSpan(draftStart,draftEnd)) }}</span><span v-if="draftStart!==null&&draftEnd!==null&&draftEnd<=draftStart" class="invalid-range">{{ ui.workbench.终点需要晚于起点 }}</span></div>
          <div class="selection-controls" :class="{'recording-time-controls':positionMode==='recording'}">
            <div class="selection-start">
              <div class="position-mode" role="group" :aria-label="ui.workbench.定位方式" @keydown.stop><button type="button" :aria-pressed="positionMode==='video'" :disabled="!selected" @click="setPositionMode('video')">{{ ui.workbench.视频时间 }}</button><button type="button" :aria-pressed="positionMode==='recording'" :disabled="!canUseRecordingTime" :title="canUseRecordingTime?ui.workbench.按录制日期和时刻定位:ui.workbench.这份素材没有可靠的开录时间" @click="setPositionMode('recording')">{{ ui.workbench.录制时间 }}</button></div>
              <label v-if="positionMode==='video'">{{ ui.common.起点 }}<input v-model="startText" @input="startMarked=true" @change="commitMark('start')" @keydown.enter.prevent="$event.target.blur()" :aria-label="ui.workbench.选段起点" :disabled="!selectionReady"/></label>
              <label v-else>{{ ui.common.起点 }}<input v-model="startDateText" type="datetime-local" step="0.001" :min="clockBounds?toRecordingInput(clockBounds.min):undefined" :max="clockBounds?toRecordingInput(clockBounds.max):undefined" @input="startMarked=true" @change="commitMark('start')" @keydown.enter.prevent="$event.target.blur()" :aria-label="ui.workbench.起点录制时间" :aria-invalid="startMarked&&draftStart===null" :disabled="!canUseRecordingTime"/></label>
            </div>
            <label v-if="positionMode==='video'">{{ ui.common.终点 }}<input v-model="endText" @input="endMarked=true" @change="commitMark('end')" @keydown.enter.prevent="$event.target.blur()" :aria-label="ui.workbench.选段终点" :disabled="!selectionReady"/></label>
            <label v-else>{{ ui.common.终点 }}<input v-model="endDateText" type="datetime-local" step="0.001" :min="clockBounds?toRecordingInput(clockBounds.min):undefined" :max="clockBounds?toRecordingInput(clockBounds.max):undefined" @input="endMarked=true" @change="commitMark('end')" @keydown.enter.prevent="$event.target.blur()" :aria-label="ui.workbench.终点录制时间" :aria-invalid="endMarked&&draftEnd===null" :disabled="!canUseRecordingTime"/></label>
            <div class="selection-markers"><button class="button" :disabled="!canPreview" :title="ui.workbench.快捷键I" @click="setMark('start')">{{ ui.workbench.设置起点 }}</button><button class="button" :disabled="!canPreview" :title="ui.workbench.快捷键O" @click="setMark('end')">{{ ui.workbench.设置终点 }}</button></div>
            <div class="selection-actions"><button class="button primary" :disabled="!canPreview||saving||!!markerError" @click="addRange"><Plus :size="16"/>{{ ui.workbench.添加选段 }}</button><button class="button accent export-selected" :disabled="!selectedRanges.length||saving||!selected" @click="openExport"><Download :size="17"/>{{ ui.workbench.导出选段 }}<span v-if="selectedRanges.length">（{{ selectedRanges.length }}）</span></button></div>
          </div>
          <p v-if="markerError" class="position-error" role="status">{{ markerError }}</p>
        </section>
        <div class="bottom-panels" :data-tab="bottomTab"><div class="bottom-switch" role="tablist" :aria-label="ui.workbench.选段与导出"><button type="button" role="tab" :aria-selected="bottomTab==='clips'" @click="bottomTab='clips'">{{ ui.workbench.选段 }} <span>({{ edit.ranges.length }})</span></button><button type="button" role="tab" :aria-selected="bottomTab==='jobs'" @click="bottomTab='jobs'">{{ ui.workbench.导出 }} <span>({{ myJobs.length }})</span></button></div><section class="clips-panel"><h2><Scissors :size="16"/>{{ ui.workbench.待导出选段 }} <span>({{ edit.ranges.length }})</span><small v-if="edit.ranges.length">{{ ui.workbench.已选 }} {{ selectedRanges.length }}/{{ edit.ranges.length }} · {{ format(rangeDuration) }}</small></h2><div v-if="edit.ranges.length" class="clip-selection-toolbar"><label><input type="checkbox" :aria-label="ui.workbench.全选选段" :checked="allRangesSelected" :indeterminate="selectedRanges.length>0&&!allRangesSelected" :disabled="saving" @change="selectAllRanges($event.target.checked)"/>{{ ui.workbench.全选 }}</label><span>{{ ui.workbench.每个选段独立导出 }}</span></div><div v-if="!edit.ranges.length" class="panel-empty">{{ ui.workbench.暂无选段 }}</div><div class="clip-list"><div v-for="(range,index) in edit.ranges" :key="index" class="clip-row" :class="{unselected:range.selected===false}"><input class="clip-checkbox" type="checkbox" :aria-label="ui.workbench.选择第+(index+1)+ui.workbench.个选段" :checked="range.selected!==false" :disabled="saving" @change="selectRange(index,$event.target.checked)"/><button class="clip-time" @click="playFrom(range.start,true)">{{ format(range.start) }} <span>→</span> {{ format(range.end) }}</button><div><button class="icon-button" :aria-label="ui.workbench.上移选段" :disabled="index===0||saving" @click="moveRange(index,-1)"><ChevronUp :size="15"/></button><button class="icon-button" :aria-label="ui.workbench.下移选段" :disabled="index===edit.ranges.length-1||saving" @click="moveRange(index,1)"><ChevronDown :size="15"/></button><button class="icon-button" :aria-label="ui.workbench.移除选段" :disabled="saving" @click="removeRange(index)"><X :size="16"/></button></div></div></div></section>
          <section class="jobs-panel" tabindex="-1"><h2><Download :size="16"/>{{ ui.workbench.导出任务 }} <span>({{ myJobs.length }})</span></h2><div v-if="!myJobs.length" class="panel-empty">{{ ui.workbench.暂无导出任务 }}</div>
            <div v-for="job in myJobs" :key="job.id" class="job-row" tabindex="0" role="group" aria-haspopup="menu" :aria-label="ui.workbench.导出任务导出任务+jobDescription(job)" :data-job-id="job.id" :title="ui.workbench.右键管理导出任务" @contextmenu.prevent.stop="showJobContext($event,job)" @keydown.shift.f10.prevent.stop="showJobContext($event,job)" @keydown.context-menu.prevent.stop="showJobContext($event,job)">
              <div><LoaderCircle v-if="['running','queued','finalizing','saving','cancelling'].includes(job.status)" class="spin job-ok" :size="15"/><Check v-else-if="job.status==='done'" class="job-ok" :size="15"/><AlertCircle v-else class="job-bad" :size="15"/><span><template v-if="job.clipCount>1">{{ ui.workbench.选段 }} {{ job.clipIndex }}/{{ job.clipCount }} · </template>{{ jobStatusText(job) }}</span><small>{{ date(job.created) }}</small></div>
              <progress v-if="job.status==='running'" :value="job.progress" max="1"/><p v-if="job.status==='running'" class="job-progress-text">{{ ui.workbench.处理进度 }} {{ Math.round(job.progress*100) }}%</p>
              <p v-if="job.status==='saving'" class="job-save-hint">{{ ui.workbench.成片已编码正在写入目标文件夹 }}</p><p v-else-if="job.status==='save_failed'&&job.canRetrySave" class="job-save-hint">{{ ui.workbench.成片已暂存重试保存无需重新编码 }}</p>
              <p v-if="job.error" class="job-error">{{ job.error }}</p><p v-if="jobRetryErrors[job.id]&&jobRetryErrors[job.id]!==job.error&&job.status==='save_failed'" class="job-error" role="alert">{{ jobRetryErrors[job.id] }}</p>
              <p v-if="job.file" class="output-path" :title="job.file">{{ job.mode==='danmaku'?ui.workbench.弹幕版弹幕版:ui.workbench.纯净版纯净版 }}{{ job.file }}</p><p v-if="job.mode==='dual'" class="output-path" :title="job.danmaku_file">{{ ui.workbench.弹幕版弹幕版 }}{{ job.danmaku_file }}</p>
              <div v-if="job.status==='save_failed'" class="job-save-actions" @keydown.stop><button class="text-button" :disabled="!!retrySaveReason(job)" @click="retryJobSave(job)"><LoaderCircle v-if="retrySavingIds.includes(job.id)" class="spin" :size="14"/><RotateCcw v-else :size="14"/>{{ ui.workbench.重试保存 }}</button><button class="text-button" :disabled="!!retrySaveReason(job)" @click="openRetrySave(job)"><FolderOpen :size="14"/>{{ ui.workbench.更换保存位置更换保存位置 }}</button></div>
              <p v-if="job.status==='save_failed'&&job.canRetrySave!==true" class="job-save-hint">{{ retrySaveReason(job) }}</p>
              <p v-if="job.hasProcessingRecovery&&['failed','interrupted'].includes(job.status)" class="job-save-hint">{{ job.savedExportSteps>0?ui.workbench.导出步骤可复用(job.savedExportSteps):ui.workbench.导出恢复说明 }}</p>
              <div v-if="job.canRetryExport" class="job-save-actions" @keydown.stop><button class="text-button" :disabled="retryExportIds.includes(job.id)" @click="retryExportJob(job)"><RotateCcw :size="14"/>{{ job.hasProcessingRecovery?ui.workbench.继续导出:ui.workbench.重试导出 }}</button></div>
              <p v-if="job.automaticRetries>0&&job.status==='running'" class="job-save-hint">{{ ui.workbench.已尝试自动恢复 }} {{ job.automaticRetries }} {{ ui.workbench.次 }}</p>
              <div v-if="job.hasRetainedFiles&&['failed','interrupted','save_failed'].includes(job.status)" class="job-save-actions" @keydown.stop><button class="text-button" @click="openFolder({recoveryJobId:job.id})"><FolderOpen :size="14"/>{{ ui.workbench.查看暂存文件 }}</button></div>
              <div v-if="job.status==='done'" class="download-links" @keydown.stop><button class="text-button" @click="openFolder({jobId:job.id})"><FolderOpen :size="14"/>{{ ui.workbench.打开文件夹 }}</button></div>
            </div>
          </section></div>
        <div v-if="activeSession" class="archive-line"><button class="text-button" :title="ui.workbench.打开完整素材导出目录" @click="openFolder({kind:'full'})"><FolderOpen :size="16"/>{{ ui.workbench.完整素材 }}</button></div>
        <section v-if="activeSession" class="preparation-panel" :aria-label="ui.workbench.后台预处理" :data-preparation-status="selectedPreparation?.status||'none'">
          <div class="preparation-summary"><span class="preparation-state" role="status"><LoaderCircle v-if="selectedLivePreparation?.active||activeSession.status==='finished'&&selectedPreparation?.status==='preparing'" class="spin" :size="14"/><Check v-else-if="selectedPreparation?.status==='ready'" :size="14"/><span>{{ selectedLivePreparation?.label||(activeSession.status==='finished'?preparationStatus(selectedPreparation):ui.workbench.录制完成后可预处理) }}</span></span><span v-if="selectedPreparation?.totalSeconds>0&&selectedPreparation?.status!=='exported'" class="preparation-duration">{{ format(Math.min(selectedPreparation.preparedSeconds||0,selectedPreparation.totalSeconds)) }} / {{ format(selectedPreparation.totalSeconds) }}</span><span v-if="selectedPreparation?.bytes>0" class="preparation-space">{{ ui.workbench.缓存 }} {{ formatBytes(selectedPreparation.bytes) }}</span><div v-if="selectedPreparationAction&&activeSession.status==='finished'" class="preparation-actions" @keydown.stop><button class="text-button" :disabled="!!selectedPreparationBlock" :title="selectedPreparationBlock" @click="actPreparation(activeSession)"><LoaderCircle v-if="preparationBusyIds.includes(activeSession.id)" class="spin" :size="14"/><Pause v-else-if="selectedPreparationAction==='pause'" :size="14"/><RotateCcw v-else-if="selectedPreparation?.status==='error'" :size="14"/><Play v-else :size="14"/>{{ preparationActionLabel(selectedPreparation) }}</button></div></div>
          <progress v-if="selectedPreparation&&selectedPreparation.totalSeconds>0&&!['ready','exported'].includes(selectedPreparation.status)" :aria-label="ui.workbench.后台预处理进度" :value="preparationProgress(selectedPreparation)" max="1"/>
          <p v-if="preparationErrors[activeSession.id]" class="preparation-note preparation-error" role="alert">{{ preparationErrors[activeSession.id] }}</p><p v-else-if="activeSession.status==='finished'&&preparationReason(selectedPreparation)" class="preparation-note" :class="{'preparation-error':selectedPreparation?.status==='error'}">{{ preparationReason(selectedPreparation) }}</p>
        </section>
      </main>
      <aside id="danmaku-panel" v-show="danmakuVisible" class="danmaku-panel"><div class="danmaku-heading"><h2>{{ showGifts?ui.workbench.弹幕与礼物:ui.workbench.弹幕 }}</h2><button class="icon-button" :title="ui.workbench.撤销最近一次排除" :aria-label="ui.workbench.撤销弹幕删除" :disabled="!edit.undo.length||saving" @click="undoMessage"><RotateCcw :size="17"/></button></div><div class="search-input"><Search :size="17"/><input v-model="query" :aria-label="ui.workbench.搜索弹幕" :placeholder="ui.workbench.搜索弹幕或发送者" @input="searchChanged"/></div><div class="danmaku-options"><div class="message-follow-control"><label><input v-model="followMessages" type="checkbox" @change="searchChanged"/>{{ ui.workbench.跟随播放位置 }}</label><button type="button" class="icon-button message-follow-resume" :style="{visibility:followMessages&&messageFollowPaused?'visible':'hidden'}" :disabled="!followMessages||!messageFollowPaused" :aria-label="ui.workbench.恢复跟随" :title="ui.workbench.恢复跟随" @click="resumeMessageFollow"><RotateCcw :size="14"/></button></div><label v-if="showGifts"><input v-model="onlyGifts" type="checkbox" @change="changeOnlyGifts"/>{{ ui.workbench.仅显示礼物 }}</label></div><div v-if="senderFilter" class="sender-filter"><span>{{ ui.workbench.只看 }}{{ senderFilter.name }}</span><button type="button" class="text-button" :aria-label="ui.workbench.清除发送者筛选" @click="clearSenderFilter">{{ ui.workbench.清除筛选 }}</button><small v-if="senderWarning" role="status">{{ senderWarning }}</small></div><div class="message-browser"><VirtualMessageList ref="messageList" :rows="visibleMessages" :automatic="followMessages&&!messageFollowPaused" :busy="messageLoading" :has-before="messagePage.hasBefore" :has-after="messagePage.hasAfter||!followMessages&&['recording','waiting'].includes(activeSession?.status)" :bounded="followMessages" @time="syncMessageBrowseTime" @manual="manualMessageScroll" @page="loadMessagePage"><template #empty><div class="danmaku-empty"><Radio :size="28"/><strong>{{ query?ui.workbench.没有匹配记录:showGifts&&onlyGifts?ui.workbench.暂无礼物:ui.workbench.暂无弹幕 }}</strong></div></template><template #default="{message}"><div :id="'danmaku-'+message.id" class="danmaku-row" :class="{excluded:excluded.has(message.id),current:Math.abs(message.time-position)<1,highlighted:highlighted.has(message.id),lottery:message.type==='lottery'}" @contextmenu.prevent.stop="showMessageContext($event,message)" @keydown.shift.f10.prevent.stop="showMessageContext($event,message)" @keydown.context-menu.prevent.stop="showMessageContext($event,message)"><button class="message-content" @click="message.type==='lottery'?openLottery(message):playFrom(message.time,false)"><span class="message-meta"><time>{{ format(message.time) }}</time><span>{{ message.user }}</span></span><span class="message-text"><span v-if="highlighted.has(message.id)" class="highlight-mark" :title="ui.workbench.已突出显示">✦ </span><Trophy v-if="message.type==='lottery'" class="lottery-icon" :size="19"/><GiftIcon v-else-if="message.type!=='d'" :gift="message"/>{{ message.text }}</span><span v-if="message.type==='lottery'" class="lottery-summary">{{ lotteryCountLabel(message) }} {{ ui.workbench.仅记录不导出 }}</span></button><button v-if="message.type==='d'||message.type==='lottery'" type="button" class="icon-button message-more" :aria-label="(message.type==='lottery'?ui.workbench.天选操作:ui.workbench.弹幕操作)+message.text" :title="ui.workbench.弹幕操作也可右键" :aria-haspopup="'menu'" @click="showMessageContext($event,message)">⋯</button><button v-if="message.type!=='lottery'" class="icon-button" :aria-label="ui.workbench.弹幕操作标签(excluded.has(message.id)?ui.workbench.恢复:ui.workbench.删除, message.text)" :title="excluded.has(message.id)?ui.workbench.恢复到剪辑:ui.workbench.从剪辑中排除保留原始弹幕" :disabled="saving" @click="toggleMessage(message)"><RotateCcw v-if="excluded.has(message.id)" :size="15"/><Trash2 v-else :size="15"/></button></div></template></VirtualMessageList><MessageTimeNavigator :from="messageRange.from" :to="messageRange.to" :time="messageBrowseTime" :disabled="!selectionReady||duration<=0" @start="startMessageNavigation" @seek="jumpMessages"/></div><div v-if="edit.excluded.length" class="danmaku-footer">{{ ui.workbench.已排除 }} {{ edit.excluded.length }} {{ ui.common.条 }}</div></aside>
    </div>
    <footer class="statusbar"><span><i :class="['live-dot',{online:connected}]"/>{{ ui.workbench.剪辑不改动原始录像和弹幕 }}</span><span>{{ saving?ui.workbench.正在保存剪辑:selected?ui.workbench.剪辑自动保存:ui.workbench.支持B站抖音 }}</span></footer>
    <DismissibleNotice v-if="notice" :key="noticeSequence" class="toast" @dismiss="notice=''" :class="noticeKind" role="status"><Check v-if="noticeKind==='success'" :size="18"/><AlertCircle v-else :size="18"/><span>{{ notice }}</span></DismissibleNotice>
    <div v-if="messageMenu" class="session-context message-context" role="menu" :aria-label="messageMenu.message.type==='lottery'?ui.workbench.天选操作天选操作:ui.workbench.弹幕操作弹幕操作" :style="{left:messageMenu.x+'px',top:messageMenu.y+'px'}" @pointerdown.stop @keydown.up.prevent="messageMenuKey" @keydown.down.prevent="messageMenuKey"><template v-if="messageMenu.message.type==='lottery'"><button role="menuitem" @click="openLottery(messageMenu.message)"><Trophy :size="16"/>{{ ui.workbench.查看中奖名单 }}</button><button role="menuitem" @click="openLottery(messageMenu.message,true)"><Pencil :size="16"/>{{ ui.workbench.编辑奖品备注 }}</button></template><template v-else><button role="menuitem" :disabled="!senderFilterFor(messageMenu.message)" :title="senderFilterFor(messageMenu.message)?'':ui.workbench.这条弹幕没有可区分的发送者信息" @click="filterSender(messageMenu.message)"><Search :size="16"/>{{ ui.workbench.只看此人弹幕 }}</button><button role="menuitem" :disabled="saving" @click="openMessageEditor(messageMenu.message)"><Pencil :size="16"/>{{ ui.workbench.编辑文本 }}</button><button role="menuitem" :disabled="saving" @click="toggleHighlight(messageMenu.message)"><span aria-hidden="true">✦</span>{{ highlighted.has(messageMenu.message.id)?ui.workbench.取消突出显示:ui.workbench.突出显示此条弹幕 }}</button><button role="menuitem" :disabled="saving" @click="toggleMessage(messageMenu.message);closeContext()"><Trash2 :size="16"/>{{ excluded.has(messageMenu.message.id)?ui.workbench.恢复此条弹幕:ui.workbench.从剪辑中排除此条 }}</button></template></div>
    <div v-if="sessionMenu" class="session-context" role="menu" :aria-label="ui.workbench.素材操作" :style="{left:sessionMenu.x+'px',top:sessionMenu.y+'px'}" @pointerdown.stop><button role="menuitem" :disabled="!!fullExportBlock(sessionMenu.session)" :title="fullExportBlock(sessionMenu.session)" @click="openFullExport(sessionMenu.session)"><Download :size="16"/>{{ ui.workbench.导出完整素材 }}</button><p v-if="fullExportBlock(sessionMenu.session)" class="context-hint">{{ fullExportBlock(sessionMenu.session) }}</p><button role="menuitem" :disabled="!!preparationActionBlock(sessionMenu.session)" :title="preparationActionBlock(sessionMenu.session)" @click="actPreparation(sessionMenu.session)"><Pause v-if="preparationAction(preparationFor(sessionMenu.session.id))==='pause'" :size="16"/><Check v-else-if="preparationFor(sessionMenu.session.id)?.status==='ready'" :size="16"/><Play v-else :size="16"/>{{ preparationActionLabel(preparationFor(sessionMenu.session.id),true) }}</button><p v-if="!preparationEnabled&&preparationAction(preparationFor(sessionMenu.session.id))!=='pause'" class="context-hint">{{ ui.workbench.请在设置中开启后台预处理 }}</p><button role="menuitem" class="context-danger" @click="requestDelete(sessionMenu.session)"><Trash2 :size="16"/>{{ ui.workbench.删除素材 }}</button></div>
    <div v-if="jobMenu" class="session-context job-context" role="menu" :aria-label="ui.workbench.导出任务操作" tabindex="-1" :style="{left:jobMenu.x+'px',top:jobMenu.y+'px'}" @pointerdown.stop>
      <button v-if="['queued','running','finalizing','cancelling','saving'].includes(jobMenuTarget?.status)" role="menuitem" :disabled="!!jobCancellationBlock(jobMenuTarget)" :title="jobCancellationBlock(jobMenuTarget)" @click="cancelJob(jobMenuTarget)"><X :size="16"/>{{ ui.workbench.取消导出 }}</button>
      <button role="menuitem" class="context-danger" :disabled="!!jobRemovalBlock(jobMenuTarget)" @click="requestJobDelete(jobMenuTarget)"><Trash2 :size="16"/>{{ ui.workbench.删除导出任务删除导出任务 }}</button>
      <p v-if="jobRemovalBlock(jobMenuTarget)" class="context-hint">{{ jobRemovalBlock(jobMenuTarget) }}</p>
    </div>
    <CacheWarning v-if="cacheWarningVisible" :usage="formatBytes(state.preparation.cache.usedBytes)" :threshold="state.preparation.cache.warningGiB" :busy="cacheWarningBusy" :error="cacheWarningError" @acknowledge="acknowledgeCacheWarning"/>
    <UpdatePrompt :state="state.updates" :blocked="!!modal||!!sessionMenu||!!jobMenu||cacheWarningVisible" @changed="state.updates=$event" @started="tell($event,'success')" @manage="openUpdateSettings"/>
    <div v-if="modal" class="modal-backdrop" @click.self="closeModal"><section class="modal" :class="{'danmaku-style-modal':modal==='danmaku-style'}" :role="confirmation?'alertdialog':'dialog'" aria-modal="true" :aria-label="modalTitle"><button class="icon-button close-modal" :aria-label="ui.workbench.关闭窗口" :disabled="modalBusy" @click="closeModal"><X :size="20"/></button>
      <template v-if="confirmation"><h2><Trash2 :size="22"/>{{ modalTitle }}</h2>
        <template v-if="modal==='remove-room'"><p>{{ ui.workbench.确认移除 }}{{ confirmTarget.name||ui.workbench.这位主播 }}{{ ui.workbench.的监控 }}</p><p>{{ ui.workbench.移除主播影响 }}</p></template>
        <template v-else-if="modal==='delete-job'">
          <p class="confirm-meta">{{ jobDeleteTarget?jobDescription(jobDeleteTarget):'' }}</p>
          <label class="checkbox"><input type="checkbox" v-model="jobDeleteRecordOnly" :disabled="modalBusy"/>{{ ui.workbench.仅移除任务记录保留现有文件 }}</label>
          <p v-if="jobDeleteRecordOnly">{{ ui.workbench.移除导出记录确认 }}</p><p v-else>{{ ui.workbench.永久删除导出确认 }}</p><p class="muted">{{ ui.workbench.原始录像原始弹幕和剪辑选段保留 }}</p>
          <p v-if="jobPreviewLoading&&!jobDeleteRecordOnly" class="job-delete-loading" role="status"><LoaderCircle class="spin" :size="16"/>{{ ui.workbench.正在核对导出文件 }}</p>
          <template v-if="jobDeletePreview&&!jobDeleteRecordOnly"><ul v-if="jobDeletePreview.files.length" class="job-delete-files" :aria-label="ui.workbench.将删除的导出文件"><li v-for="file in jobDeletePreview.files" :key="file.path"><code>{{ file.path }}</code><span>{{ file.exists===false?ui.workbench.文件已不存在仅清理对应记录:Number.isFinite(file.size)?formatBytes(file.size):ui.workbench.将永久删除 }}</span></li></ul><p v-else-if="!jobDeletePreview.blocked" class="muted">{{ ui.workbench.无成片仅清理记录 }}</p></template>
          <p v-if="jobDeleteError" class="inline-warning" role="alert">{{ jobDeleteError }}</p>
          <p v-if="jobDeletePreview?.preserved?.length&&!jobDeleteRecordOnly" class="muted">{{ ui.workbench.保留其他任务文件 }}</p>
          <p v-if="jobDeleteBlock&&!jobPreviewLoading" class="inline-warning">{{ jobDeleteBlock }}</p>
          <button v-if="!jobDeleteRecordOnly&&!jobPreviewLoading&&!modalBusy&&(!jobDeletePreview||jobDeletePreview.blocked)" class="button small" @click="loadJobDeletePreview()">{{ ui.workbench.重新核对文件 }}</button>
        </template>
        <template v-else-if="modal==='delete-session'"><p>{{ ui.workbench.确认删除 }}{{ confirmTarget.title }}」？</p><p class="confirm-meta">{{ date(confirmTarget.created) }} · {{ format(confirmTarget.duration) }}</p><p>{{ ui.workbench.永久删除素材确认 }}</p><p class="muted">{{ ui.workbench.已导出的成片保留 }}</p><p v-if="materialDeleteError" class="inline-warning" role="alert">{{ materialDeleteError }}</p><p v-if="deleteBlock" class="inline-warning">{{ deleteBlock }}</p></template>
        <div class="confirm-actions"><button class="button" :class="{'job-delete-cancel':modal==='delete-job'}" :disabled="modalBusy" @click="closeModal">{{ ui.common.取消 }}</button><button class="button danger" :disabled="modalBusy||!!(modal==='delete-job'?jobDeleteBlock:deleteBlock)" @click="modal==='delete-job'?confirmJobRemoval():confirmRemoval()"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>{{ modal==='delete-job'&&jobDeleteRecordOnly?ui.workbench.确认移除记录:modal==='remove-room'?ui.common.确认移除:ui.workbench.确认永久删除 }}</button></div>
      </template>
      <template v-else-if="modal==='choose-room'"><h2><Radio :size="22"/>{{ ui.workbench.选择主播 }}</h2>
        <p v-if="roomChoice.candidates.length>1">{{ ui.workbench.找到同号房间请选择主播 }}</p><p v-else>{{ ui.workbench.请确认要添加的主播 }}</p>
        <p v-if="roomChoice.unavailable?.length" class="inline-warning">{{ roomChoice.unavailable.map(platform=>platform==='bilibili'?ui.common.B站:ui.common.抖音).join('、') }}{{ ui.workbench.暂时无法查询可重试或使用完整链接 }}</p>
        <div class="room-choice-options" role="radiogroup" :aria-label="ui.workbench.选择直播间"><label v-for="room in roomChoice.candidates" :key="room.platform" class="room-choice-option" :class="{chosen:roomChoicePlatform===room.platform}"><input v-model="roomChoicePlatform" type="radio" name="room-platform" :value="room.platform" :disabled="modalBusy" :aria-label="(room.platform==='bilibili'?ui.common.B站:ui.common.抖音)+' · '+room.name"/><span><strong>{{ room.name }}</strong><small>{{ room.platform==='bilibili'?ui.common.B站:ui.common.抖音 }} · {{ room.roomNumber }} · {{ room.streaming?ui.workbench.直播中:ui.workbench.未开播 }}</small><small v-if="room.title" class="room-choice-title" :title="room.title">{{ room.title }}</small></span></label></div>
        <p v-if="roomChoiceError" class="inline-warning" role="alert">{{ roomChoiceError }}</p>
        <div class="confirm-actions"><button class="button" :disabled="modalBusy" @click="closeModal">{{ ui.common.取消 }}</button><button class="button primary" :disabled="modalBusy||!roomChoicePlatform" @click="confirmRoomChoice"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>{{ ui.workbench.确认添加 }}</button></div>
      </template>
      <template v-else-if="modal==='lottery' && lotteryTarget"><h2><Trophy :size="23"/>{{ lotteryEditing?ui.workbench.编辑奖品备注:ui.workbench.天选时刻中奖名单 }}</h2><LotteryPanel :record="lotteryTarget.record" :editing="lotteryEditing" :busy="modalBusy" :loading="lotteryLoading" :error="lotteryError" @save="saveLotteryRemark" @edit="lotteryEditing=true;lotteryError=''" @refresh="refreshLotteryDetail" @close="closeModal"/></template>
      <template v-else-if="modal==='edit-message' && messageEditTarget"><h2>{{ ui.workbench.编辑文本 }}</h2><MessageTextEditor :message="messageEditTarget.message" :busy="modalBusy" @save="saveMessageText" @close="closeModal"/></template>
      <template v-else-if="modal==='danmaku-style'"><h2><Settings :size="23"/>{{ ui.workbench.调整弹幕样式 }}</h2><DanmakuStyleSettings :style="state.danmakuStyle" :highlight-style="state.highlightStyle" :font="state.danmakuFont" :rate="state.danmakuPerSecond??50" @changed="applyDanmakuSettings" @busy="modalBusy=$event" @close="closeModal"/></template>
      <template v-else-if="modal==='recording-style'"><h2><Settings :size="23"/>{{ ui.workbench.调整录制样式 }}</h2><RecordingSettings :preview-timestamp="state.previewTimestamp===true" :preview-timestamp-style="state.previewTimestampStyle" :preview-timestamp-position="state.previewTimestampPosition" :recording-style="state.recordingStyle" :gift-style="state.giftStyle" @changed="state.previewTimestamp=$event.previewTimestamp;state.previewTimestampStyle=$event.previewTimestampStyle;state.previewTimestampPosition=$event.previewTimestampPosition;state.recordingStyle=$event.recordingStyle;state.giftStyle=$event.giftStyle" @busy="modalBusy=$event" @close="closeModal"/></template>
      <template v-else-if="modal==='cookie-management'"><h2><Settings :size="23"/>{{ ui.common.Cookie管理 }}</h2><PlatformCredentials @busy="modalBusy=$event" @close="closeModal"/></template>
      <template v-else-if="modal==='settings'"><h2><Settings :size="23"/>{{ ui.workbench.设置 }}</h2>
        <section class="danmaku-style-entry"><div><strong>{{ ui.workbench.弹幕样式 }}</strong><p>{{ state.danmakuFont?.family||ui.common.默认字体 }} {{ ui.workbench.字号 }} {{ state.danmakuStyle?.size??0.6 }} {{ ui.workbench.不透明度 }} {{ state.danmakuStyle?.opacity??100 }}{{ ui.workbench.速度 }} {{ (state.danmakuStyle?.speed??1).toFixed(1) }} {{ ui.workbench.倍 }} {{ state.danmakuStyle?.fps??60 }} {{ ui.workbench.帧 }}</p></div><button class="button open-danmaku-style" :disabled="modalBusy" @click="modal='danmaku-style'"><Settings :size="16"/>{{ ui.workbench.调整弹幕样式 }}</button></section>
        <section class="danmaku-style-entry"><div><strong>{{ ui.common.录制样式 }}</strong><p>{{ ui.workbench.独立摄像头 }}{{ recordingStyleSummary }} {{ ui.workbench.时间戳 }}{{ state.previewTimestamp?timestampStyleSummary+' · '+timestampPositionSummary:ui.common.关闭 }}</p></div><button class="button open-recording-style" :disabled="modalBusy" @click="modal='recording-style'"><Settings :size="16"/>{{ ui.workbench.调整录制样式 }}</button></section>
        <PowerSettings v-if="isMacDesktop"/>
        <fieldset v-if="isDesktop" class="export-versions" :aria-label="ui.workbench.关闭窗口时"><legend>{{ ui.workbench.关闭窗口时 }}</legend><label v-for="choice in [{value:'ask',label:ui.workbench.每次询问},{value:'exit',label:ui.workbench.退出},{value:'background',label:ui.workbench.后台运行}]" :key="choice.value" class="checkbox"><input type="radio" name="close-action" :value="choice.value" :checked="(closeActionDraft??state.closeAction??'ask')===choice.value" :disabled="closeActionBusy||modalBusy" @change="setCloseAction(choice.value)"/>{{ choice.label }}</label><p v-if="closeActionError" class="inline-warning" role="alert">{{ closeActionError }}</p></fieldset>
        <section class="preparation-settings" :aria-label="ui.workbench.自动预处理设置">
          <label class="checkbox"><input type="checkbox" :checked="preparationEnabledDraft??preparationEnabled" :disabled="preparationSettingsBusy||modalBusy" @change="setPreparationEnabled($event.target.checked)"/>{{ ui.workbench.录制完成后自动预处理 }}<LoaderCircle v-if="preparationSettingsBusy" class="spin" :size="14"/></label>
          <p class="muted">{{ ui.workbench.预处理用途 }}</p>
          <label class="checkbox"><input type="checkbox" :checked="livePreparationEnabledDraft??livePreparationEnabled" :disabled="!preparationEnabled||preparationSettingsBusy||modalBusy" @change="setLivePreparationEnabled($event.target.checked)"/>{{ ui.workbench.录制时自动提前处理 }}</label>
          <p class="muted">{{ ui.workbench.录制预处理说明 }}</p>
          <p v-if="!preparationEnabled" class="muted">{{ ui.workbench.请先开启录制完成后的自动预处理 }}</p>
          <div v-if="state.preparation?.cache" class="cache-settings">
            <p>{{ ui.workbench.预处理缓存 }}{{ formatBytes(state.preparation.cache.usedBytes) }}<span v-if="state.preparation.cache.reservedBytes"> {{ ui.workbench.正在使用 }} {{ formatBytes(state.preparation.cache.reservedBytes) }}</span></p>
            <label class="checkbox"><input type="checkbox" :checked="state.preparation.cache.warningEnabled" :disabled="preparationSettingsBusy" @change="updatePreparationSettings({cacheWarningEnabled:$event.target.checked})"/>{{ ui.cacheWarning.开关 }}</label>
            <label>{{ ui.cacheWarning.阈值 }}<input type="number" min="1" max="1048576" step="1" :value="cacheWarningGiBDraft??state.preparation.cache.warningGiB" @input="cacheWarningGiBDraft=$event.target.value" :disabled="preparationSettingsBusy||!state.preparation.cache.warningEnabled" @change="updatePreparationSettings({cacheWarningGiB:Number($event.target.value)});cacheWarningGiBDraft=null"/></label>
            <p class="muted">{{ ui.cacheWarning.设置说明 }}</p>
            <p class="muted cache-path">{{ state.preparation.cache.path }}</p>
            <p v-if="state.preparation.cache.availableBytes!==undefined" class="muted">{{ ui.workbench.该位置可用 }} {{ formatBytes(state.preparation.cache.availableBytes) }}{{ ui.workbench.另预留 }} {{ formatBytes(state.preparation.cache.minFreeBytes) }} {{ ui.workbench.供录制使用 }}</p>
            <button type="button" class="button" :disabled="preparationSettingsBusy" @click="clearPreparationCache">{{ ui.workbench.清理可重建缓存 }}</button><p class="muted">{{ ui.workbench.清理缓存影响 }}</p>
          </div>
          <p v-if="preparationSettingsError" class="inline-warning" role="alert">{{ preparationSettingsError }}</p>
        </section>
        <div class="directory-settings"><label class="field-label">{{ ui.workbench.默认导出根目录 }}<div class="path-picker"><input v-model="exportDirectory" :aria-label="ui.workbench.默认导出文件夹" :placeholder="ui.workbench.填写完整的文件夹路径" :disabled="modalBusy" @change="commitExportDirectory" @keydown.enter.prevent="commitExportDirectory"/><button v-if="isDesktop" type="button" class="button" :disabled="modalBusy" @click="browseFolder"><FolderOpen :size="16"/>{{ ui.workbench.选择 }}</button></div></label><p class="muted">{{ ui.workbench.导出目录说明 }}</p><div class="export-destinations"><span>{{ ui.workbench.完整素材 }}</span><code>{{ categoryPath(exportDirectory,'完整素材') }}</code><span>{{ ui.workbench.导出片段 }}</span><code>{{ categoryPath(exportDirectory,'导出片段') }}</code></div><div class="directory-actions"><button class="button" type="button" @click="openFolder({kind:'exports'})"><FolderOpen :size="16"/>{{ ui.workbench.打开文件目录 }}</button></div></div>
        <div v-if="state.recovery?.safeMode" class="setting-info"><span>{{ ui.workbench.安全启动前的旧录像已保留 }}</span><code>{{ state.paths?.retained }}</code><button class="button" @click="openFolder({kind:'retained'})"><FolderOpen :size="16"/>{{ ui.workbench.查看旧录像 }}</button><p class="muted">{{ ui.workbench.旧素材索引异常 }}</p></div>
        <div class="setting-info"><span>{{ ui.workbench.完整原始录像与弹幕 }}</span><code>{{ state.paths?.originals }}</code><button class="text-button" @click="openFolder({kind:'originals'})">{{ ui.workbench.打开原始素材文件夹 }}</button></div>
        <div class="setting-info"><span>{{ ui.workbench.运行日志北京时间每天一份TXT }}</span><code>{{ state.paths?.logs }}</code><button class="button" @click="openFolder({kind:'logs'})"><FolderOpen :size="16"/>{{ ui.workbench.点击查看日志文件 }}</button><p class="muted">{{ ui.workbench.日志保留说明 }}</p><p v-if="state.diagnostics?.error" class="inline-warning">{{ ui.workbench.日志暂时无法保存 }}{{ state.diagnostics.error }}</p></div>
        <section v-if="pendingCleanup.length" class="cleanup-settings" :aria-label="ui.workbench.素材清理进度"><strong>{{ ui.workbench.素材清理进度素材清理进度 }}{{ pendingCleanup.length }}）</strong><p class="muted">{{ ui.workbench.文件占用释放后自动重试 }}</p><div v-for="item in pendingCleanup" :key="item.id" class="cleanup-row"><div><strong>{{ item.title }}</strong><small>{{ date(item.created) }} · {{ format(item.duration) }}</small><p role="status">{{ cleanupLabel(item) }}</p><small v-if="item.task?.detail">{{ item.task.detail }}</small><p v-if="item.purge_error&&!item.task" class="cleanup-error">{{ item.purge_error }}</p></div><button class="button small danger" :disabled="modalBusy||!!item.task" @click="requestDelete(item)">{{ item.task?ui.workbench.清理中:ui.workbench.重试清理 }}</button></div></section>
        <UpdateSettings :state="state.updates" @changed="state.updates=$event"/>
        <section class="danmaku-style-entry cookie-management-entry"><strong>{{ ui.common.Cookie管理 }}</strong><button class="button open-cookie-management" :disabled="modalBusy" @click="modal='cookie-management'">{{ ui.workbench.管理Cookie }}</button></section>
      </template>
      <template v-else-if="modal==='retry-save'"><h2><FolderOpen :size="23"/>{{ ui.workbench.更换保存位置 }}</h2><p class="export-target">{{ retrySaveTarget?.description }}</p><p>{{ ui.workbench.重试保存说明 }}</p><form @submit.prevent="retryJobSave(retrySaveJob,true)"><label class="field-label">{{ ui.workbench.本次保存根目录 }}<div class="path-picker"><input v-model="retrySaveDirectory" class="retry-save-directory" :aria-label="ui.workbench.重试保存文件夹" :placeholder="ui.workbench.填写完整的文件夹路径" :disabled="modalBusy" required/><button v-if="isDesktop" type="button" class="button" :disabled="modalBusy" @click="browseRetryFolder"><FolderOpen :size="16"/>{{ ui.workbench.选择 }}</button></div></label><div class="export-destinations"><span>{{ ui.workbench.保存到 }}{{ retrySaveCategory }}」</span><code>{{ categoryPath(retrySaveDirectory,retrySaveCategory) }}</code></div><p class="muted">{{ ui.workbench.单次保存位置说明 }}</p><p v-if="retrySaveError" class="inline-warning" role="alert">{{ retrySaveError }}</p><p v-else-if="retrySaveBlock" class="inline-warning">{{ retrySaveBlock }}</p><div class="confirm-actions"><button type="button" class="button" :disabled="modalBusy" @click="closeModal">{{ ui.common.取消 }}</button><button class="button primary" :disabled="modalBusy||!!retrySaveBlock||!retrySaveDirectory.trim()"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>{{ ui.workbench.保存到此位置 }}</button></div></form></template>
      <template v-else><h2><Download :size="23"/>{{ modalTitle }}</h2><p class="export-target">{{ exportTarget?.title }}</p><p v-if="exportScope==='full'">{{ ui.workbench.整场导出摘要(format(exportDuration), versionDescription) }}</p><p v-else>{{ ui.workbench.选段导出摘要(exportRanges.length, format(exportDuration), versionDescription) }}</p><label class="field-label">{{ ui.workbench.本次导出根目录 }}<div class="path-picker"><input v-model="exportDirectory" :aria-label="ui.workbench.本次导出文件夹" :placeholder="ui.workbench.填写完整的文件夹路径"/><button v-if="isDesktop" class="button" :disabled="modalBusy" @click="browseFolder"><FolderOpen :size="16"/>{{ ui.workbench.选择 }}</button></div></label><div class="export-destinations"><span>{{ ui.workbench.本次保存到 }}{{ exportCategory }}」</span><code>{{ categoryPath(exportDirectory,exportCategory) }}</code></div><fieldset class="export-versions"><legend>{{ ui.workbench.导出版本 }}</legend>
          <label class="export-mode" :class="{chosen:exportMode==='clean'}"><input v-model="exportMode" type="radio" name="export-mode" value="clean"/><span><strong>{{ ui.workbench.纯净版本 }}</strong><small>{{ ui.workbench.无弹幕的MP4 }}</small></span></label>
          <label class="export-mode" :class="{chosen:exportMode==='danmaku'}"><input v-model="exportMode" type="radio" name="export-mode" value="danmaku"/><span><strong>{{ ui.workbench.弹幕版本 }}</strong><small>{{ ui.workbench.叠加弹幕的MP4 }}</small></span></label>
          <label class="export-mode" :class="{chosen:exportMode==='dual'}"><input v-model="exportMode" type="radio" name="export-mode" value="dual"/><span><strong>{{ ui.workbench.纯净弹幕双文件版本 }}</strong><small>{{ ui.workbench.分别生成两份MP4 }}</small></span></label>
        </fieldset><label class="checkbox"><input v-model="exportGifts" type="checkbox" :disabled="exportMode==='clean'"/>{{ ui.workbench.本次弹幕版展示礼物 }}</label><p class="muted">{{ ui.workbench.导出礼物筛选说明 }}</p><p v-if="exportMode!=='clean'&&(exportScope==='full'||exportExcluded>0)" class="muted"><template v-if="exportScope==='full'">{{ ui.workbench.弹幕版沿用这份素材的弹幕排除设置 }}</template><template v-else>{{ ui.workbench.已排除的 }} {{ exportExcluded }} {{ ui.workbench.条弹幕不会进入弹幕版 }}</template></p><p v-if="exportBlock" class="inline-warning">{{ exportBlock }}</p><button class="button primary wide" :disabled="modalBusy||saving||!!exportBlock" @click="exportClip"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>{{ ui.workbench.开始导出 }}</button></template>
    </section></div>
  </div>
</template>
