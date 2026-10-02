<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import DanmakuOverlay from './components/DanmakuOverlay.vue';
import TimelineSignals from './components/TimelineSignals.vue';
import TimelineNavigator from './components/TimelineNavigator.vue';
import TimelineMarker from './components/TimelineMarker.vue';
import { signalWindow, viewWindow, windowPercent, visibleRange, panWindow, zoomWindow } from './timeline-signals.js';
import appIcon from './assets/app-icon.png';
import { roomAvailable, roomRecordEnabled, roomStatus } from './room-status.js';
import { formatVideoTime as format, displayedSpan, markPreviewPosition } from './video-time.js';
import { recordingTimeAt, positionAtRecordingTime, toRecordingInput, parseRecordingInput, recordingTimeBounds } from './recording-time.js';
import { overlayWindow as makeOverlayWindow, containsOverlay } from './message-window.js';
import { isDesktop, openAuthorPage, pickExportFolder } from './desktop.js';
import { api } from './api.js';
import { previewStream } from './preview-stream.js';
import { Video, Radio, Film, Play, Pause, StepBack, StepForward, RotateCcw, Settings, Plus, Minus, Search, Trash2, Download, X, ChevronUp, ChevronDown, Check, AlertCircle, LoaderCircle, Target, Scissors, FolderOpen, Volume2, Volume1, VolumeX } from 'lucide-vue-next';

const state=ref({sessions:[],rooms:[],jobs:[],recorder:{online:false,error:''},dataPath:'',paths:{},preparation:{enabled:true,items:[]}} );
const selected=ref(null),detail=ref(null),edit=ref({revision:0,ranges:[],excluded:[],undo:[]});
const roomUrl=ref(''),addingRoom=ref(false),notice=ref(''),noticeKind=ref('error'),saving=ref(false),connected=ref(false);
const roomChoice=shallowRef(null),roomChoicePlatform=ref(''),roomChoiceError=ref('');
const video=ref(null),previewUrl=ref(''),position=ref(0),previewBase=ref(0),isPlaying=ref(false),loading=ref(false),previewEnded=ref(false),scrubbing=ref(false);
let previewTransport;
const previewVolume=ref(1),previewMuted=ref(false);
try{const saved=JSON.parse(localStorage.getItem('preview-audio')||'null');if(saved&&Number.isFinite(saved.volume))previewVolume.value=Math.min(1,Math.max(0,saved.volume));if(saved&&typeof saved.muted==='boolean')previewMuted.value=saved.muted;}catch{}
let previewVolumeHold=previewVolume.value>0?previewVolume.value:1;
const previewSlider=computed(()=>previewMuted.value?0:previewVolume.value);
const startText=ref('00:00:00'),endText=ref('00:00:00'),startExact=ref(0),endExact=ref(0),query=ref(''),messages=shallowRef([]),showOverlay=ref(true),followMessages=ref(true);
const roomBusyIds=ref([]);
const modal=ref(''),modalBusy=ref(false),exportMode=ref('dual'),materialDeleteError=ref('');
const startMarked=ref(false),endMarked=ref(false),sessionMenu=ref(null),confirmTarget=ref(null);
const jobMenu=ref(null),jobDeleteTarget=ref(null),jobDeletePreview=shallowRef(null),jobPreviewLoading=ref(false),jobDeleteError=ref('');
const jobDeleteRecordOnly=ref(false);
const retrySaveTarget=ref(null),retrySaveDirectory=ref(''),retrySaveError=ref(''),retrySavingIds=ref([]),jobRetryErrors=ref({});
const preparationBusyIds=ref([]),preparationErrors=ref({}),preparationSettingsBusy=ref(false),preparationSettingsError=ref(''),preparationEnabledDraft=ref(null);
const closeActionBusy=ref(false),closeActionError=ref(''),closeActionDraft=ref(null);
const chatRateBusy=ref(false),chatRateError=ref(''),chatRateDraft=ref(null);
const chatRateValue=computed(()=>chatRateDraft.value??state.value.danmakuPerSecond??50);
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
function cleanupLabel(item){const task=item.task;if(!task)return item.purge_error?'等待重试':'等待清理';const count=task.total?`（${task.completed}/${task.total}）`:'';return ({resources:'正在释放占用',checking:'正在核对文件',files:'正在清理文件',cache:'正在清理缓存',temporary:'正在清理临时文件',records:'正在清理记录',waiting:'等待占用释放，随后自动重试'})[task.phase]+count;}
const draftStart=computed(()=>markerTime('start',startMarked.value));
const draftEnd=computed(()=>markerTime('end',endMarked.value));
const draftDuration=computed(()=>draftStart.value!==null&&draftEnd.value!==null&&draftEnd.value>draftStart.value?draftEnd.value-draftStart.value:null);
const clockBounds=computed(()=>recordingTimeBounds(activeSession.value,detail.value?.sources||[],duration.value));
const selectionReady=computed(()=>!!selected.value&&detail.value?.id===selected.value);
const canUseRecordingTime=computed(()=>selectionReady.value&&activeSession.value?.room>0&&!!clockBounds.value);
const markerError=computed(()=>{for(const which of ['start','end']){if(!(which==='start'?startMarked.value:endMarked.value))continue;try{readMark(which);}catch(e){return (which==='start'?'起点：':'终点：')+e.message;}}return '';});
const confirmation=computed(()=>['remove-room','delete-session','delete-job'].includes(modal.value));
const jobMenuTarget=computed(()=>state.value.jobs.find(job=>job.id===jobMenu.value?.id));
const retrySaveJob=computed(()=>state.value.jobs.find(job=>job.id===retrySaveTarget.value?.id));
const retrySaveBlock=computed(()=>retrySaveReason(retrySaveJob.value));
const retrySaveCategory=computed(()=>retrySaveTarget.value?.scope==='full'?'完整素材':'导出片段');
const jobDeleteBlock=computed(()=>{
  if(modal.value!=='delete-job')return '';
  const blocked=jobRemovalBlock(state.value.jobs.find(job=>job.id===jobDeleteTarget.value?.id));if(blocked)return blocked;
  if(jobDeleteRecordOnly.value)return '';
  if(jobPreviewLoading.value)return '正在核对导出文件…';
  if(!jobDeletePreview.value)return '请先核对该任务对应的导出文件。';
  return jobDeletePreview.value.blocked?(jobDeletePreview.value.reason||'该任务暂时无法删除。'):'';
});
const deleteBlock=computed(()=>{
  if(modal.value!=='delete-session'||!confirmTarget.value)return '';
  const s=[...state.value.sessions,...pendingCleanup.value].find(s=>s.id===confirmTarget.value.id);
  if(!s)return '素材已被永久删除。';
  if(s.status!=='finished')return '这份素材仍在录制或整理中，请结束后再删除。';
  if(state.value.jobs.some(j=>j.session===s.id&&j.status==='save_failed'))return '这份素材还有保存失败的导出任务，请先重试保存。';
  if(s.archive_status==='running'||state.value.jobs.some(j=>j.session===s.id&&['queued','running','finalizing','saving','cancelling'].includes(j.status)))return '这份素材正在归档、导出或保存，请完成后再删除。';
  return '';
});
const modalTitle=computed(()=>({settings:'设置',export:exportScope.value==='full'?'导出完整素材':'导出选段','choose-room':'选择主播','remove-room':'移除监控房间','delete-session':'删除已录制素材','delete-job':'删除导出任务','retry-save':'更换保存位置'})[modal.value]||'');
const activeSession=computed(()=>state.value.sessions.find(s=>s.id===selected.value)||detail.value);
const preparationEnabled=computed(()=>state.value.preparation?.enabled!==false);
const selectedPreparation=computed(()=>preparationFor(selected.value));
const selectedPreparationAction=computed(()=>preparationAction(selectedPreparation.value));
const selectedPreparationBlock=computed(()=>preparationActionBlock(activeSession.value));
const duration=computed(()=>activeSession.value?.duration||0);
const timelineWindow=ref(null),signals=shallowRef(null),signalsLoading=ref(false),signalsError=ref('');
const timelineDragging=ref(false);
const viewport=computed(()=>viewWindow(duration.value,timelineWindow.value));
const viewSpan=computed(()=>viewport.value.to-viewport.value.from);
const visibleRanges=computed(()=>edit.value.ranges.map((range,index)=>({range,index,view:visibleRange(range,viewport.value.from,viewport.value.to)})).filter(item=>item.view));
const draftView=computed(()=>draftStart.value!==null&&draftEnd.value!==null?visibleRange({start:draftStart.value,end:draftEnd.value},viewport.value.from,viewport.value.to):null);
const sliderPosition=computed(()=>Math.min(viewport.value.to,Math.max(viewport.value.from,position.value)));
const source=computed(()=>detail.value?.sources?.find(s=>position.value>=s.start-.02&&position.value<=s.start+s.duration+.1));
const fps=computed(()=>source.value?.metadata?.fps||30);
const excluded=computed(()=>new Set(edit.value.excluded));
const visibleMessages=computed(()=>messages.value);
const overlayFeed=shallowRef([]),exportDirectory=ref(''),savedExportDirectory=ref('');
let overlayBusy=false, overlayWindow=null;
const myJobs=computed(()=>state.value.jobs.filter(j=>j.session===selected.value));
const selectedRanges=computed(()=>edit.value.ranges.filter(r=>r.selected!==false));
const allRangesSelected=computed(()=>edit.value.ranges.length>0&&selectedRanges.value.length===edit.value.ranges.length);
const rangeDuration=computed(()=>selectedRanges.value.reduce((n,r)=>n+displayedSpan(r.start,r.end),0));
const versionDescription=computed(()=>({clean:'一个纯净版 MP4',danmaku:'一个弹幕版 MP4',dual:'纯净版和弹幕版两个 MP4'})[exportMode.value]);
const exportSession=computed(()=>state.value.sessions.find(s=>s.id===exportTarget.value?.id));
const exportCategory=computed(()=>exportScope.value==='full'?'完整素材':'导出片段');
const exportDuration=computed(()=>exportScope.value==='full'?displayedSpan(0,exportSession.value?.duration||0):exportRanges.value.reduce((total,r)=>total+displayedSpan(r.start,r.end),0));
const exportBlock=computed(()=>{
  if(!exportSession.value)return '素材已被删除，无法导出。';
  if(exportScope.value==='full')return fullExportBlock(exportSession.value);
  return exportRanges.value.length?'':'请先勾选至少一个选段。';
});
const canPreview=computed(()=>selectionReady.value&&duration.value>0.1);
let eventSource,timer,messageTimer,signalsTimer,queryTimer,noticeTimer,refreshBusy=false,dmBusy=false,lastMessageKey='',generation=0,selectionGeneration=0;
let messageRequest=0,overlayRequest=0,signalRequest=0,signalController=null,lastSignalKey='',lastSignalAt=0;
let windowSignalTimer=null,lastWindowRequestAt=0,disposing=false;
let jobPreviewRequest=0;


function parse(text){const values=String(text).split(':').map(Number);if(values.some(n=>!Number.isFinite(n)||n<0)||values.length>3)throw new Error('时间格式应为 时:分:秒，也可以直接填写秒数。');return values.reduce((a,b)=>a*60+b,0);}
function date(text){return new Date(text).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
function categoryPath(root,category){const raw=String(root||''),value=raw.replace(/[\\/]+$/,'');return raw?value+(raw.startsWith('/')?'/':'\\')+category:category;}
function formatBytes(bytes){const size=Math.max(0,Number(bytes)||0);if(size<1024)return size+' 字节';const units=['KB','MB','GB','TB'],power=Math.min(4,Math.floor(Math.log(size)/Math.log(1024)));return (size/1024**power).toFixed(1)+' '+units[power-1];}
function closeModal(){if(modalBusy.value)return;const kind=modal.value,jobId=kind==='delete-job'?jobDeleteTarget.value?.id:kind==='retry-save'?retrySaveTarget.value?.id:null;modal.value='';if(kind==='choose-room'){roomChoice.value=null;roomChoicePlatform.value='';roomChoiceError.value='';void nextTick(()=>document.querySelector('.room-form input')?.focus());}if(kind==='delete-job'){jobPreviewRequest++;jobPreviewLoading.value=false;jobDeleteTarget.value=null;jobDeletePreview.value=null;}if(kind==='retry-save'){retrySaveTarget.value=null;retrySaveError.value='';}if(jobId)void nextTick(()=>focusJob(jobId));}
function fullExportBlock(session){return session.status!=='finished'?'录制或整理完成后才能导出完整素材。':!(session.duration>0)?'这份素材暂时没有可导出的画面。':'';}
function preparationFor(id){return state.value.preparation?.items?.find(item=>item.session===id);}
function preparationStatus(entry){return ({queued:'等待预处理',preparing:'正在后台预处理',waiting:'暂缓预处理',paused:'预处理已暂停',ready:'预处理已完成',exported:'完整弹幕版已导出',error:'预处理未完成'})[entry?.status]||'尚未预处理';}
function preparationAction(entry){return ['queued','preparing','waiting'].includes(entry?.status)?'pause':['ready','exported'].includes(entry?.status)?null:['paused','error'].includes(entry?.status)?'resume':'start';}
function preparationActionLabel(entry,context=false){const action=preparationAction(entry);return action==='pause'?(context?'暂停后台预处理':'暂停'):action==='resume'?(entry?.status==='error'?(context?'重试后台预处理':'重试'):(context?'继续后台预处理':'继续')):action==='start'?'开始后台预处理':'后台预处理已完成';}
function preparationProgress(entry){const total=Number(entry?.totalSeconds)||0;return total>0?Math.max(0,Math.min(1,(Number(entry?.preparedSeconds)||0)/total)):entry?.status==='ready'?1:0;}
function preparationReason(entry){
  if(entry?.status==='exported')return '无需继续预处理，已有缓存保留供后续剪辑使用。';
  if(entry?.status==='ready')return '';
  if(!preparationEnabled.value)return '自动预处理已关闭，请在设置中开启。';
  if(entry?.status==='error')return entry.error||'预处理暂未完成，可稍后重试。';
  if(entry?.status==='preparing')return '预览和选段可同时进行，正式导出时暂缓，可随时暂停。';
  const reasons={recording:'正在录制，空闲后继续。',connection:'等待录制核心连接。',preview:'播放优先，预览结束后继续。',export:'正在导出，完成后继续。',indexing:'素材正在整理，完成后继续。',compaction:'素材正在整理，完成后继续。',source:'素材尚未准备好，稍后继续。',space:'磁盘可用空间不足，腾出空间后继续。',disabled:'自动预处理已关闭，请在设置中开启。',foreground:'当前操作优先，空闲后继续。',idle:'等待空闲后开始。',user:'已手动暂停，可随时继续。'};
  return reasons[entry?.reason]||(['queued','waiting'].includes(entry?.status)?'等待后台空闲。':entry?.status==='paused'?'已手动暂停，可随时继续。':'');
}
function preparationActionBlock(session){
  const current=state.value.sessions.find(item=>item.id===session?.id);if(!current)return '素材已被删除。';
  if(current.status!=='finished')return '录制或整理完成后可开始后台预处理。';if(!(current.duration>0))return '这份素材暂时没有可预处理的画面。';
  if(preparationSettingsBusy.value||preparationBusyIds.value.includes(current.id))return '正在更新预处理状态…';
  const action=preparationAction(preparationFor(current.id));if(!action)return '后台预处理已完成。';
  return action!=='pause'&&!preparationEnabled.value?'请在设置中开启后台预处理。':'';
}
function applyPreparation(value){if(value&&typeof value.enabled==='boolean'&&Array.isArray(value.items))state.value.preparation=value;}
async function setPreparationEnabled(enabled){
  if(preparationSettingsBusy.value)return;preparationSettingsBusy.value=true;preparationEnabledDraft.value=enabled;preparationSettingsError.value='';
  try{const result=await api('preparation/settings',{enabled});if(disposing)return;applyPreparation(result);await refresh();}
  catch(e){if(!disposing)preparationSettingsError.value=e.message;}
  finally{preparationSettingsBusy.value=false;preparationEnabledDraft.value=null;}
}
async function actPreparation(session){
  const id=session?.id,current=state.value.sessions.find(item=>item.id===id),blocked=preparationActionBlock(current);if(blocked){tell(blocked);return;}
  const action=preparationAction(preparationFor(id));if(!action)return;closeContext();preparationBusyIds.value.push(id);delete preparationErrors.value[id];
  try{const result=await api(`sessions/${encodeURIComponent(id)}/preparation`,{action});if(disposing)return;applyPreparation(result);await refresh();}
  catch(e){if(!disposing){preparationErrors.value[id]=e.message;tell(e.message);}}
  finally{preparationBusyIds.value=preparationBusyIds.value.filter(value=>value!==id);}
}
function timelinePercent(time){return windowPercent(time,viewport.value.from,viewport.value.to);}
function inViewport(time){return time!==null&&Number.isFinite(time)&&time>=viewport.value.from&&time<=viewport.value.to;}
function rangeStyle(range){return {left:range.left+'%',width:range.width+'%'};}
function setTimelineWindow(window){if(window===null&&timelineWindow.value===null)return;if(window&&timelineWindow.value&&window.from===timelineWindow.value.from&&window.to===timelineWindow.value.to)return;timelineWindow.value=window;}
function focusTimeline(){if(canPreview.value)setTimelineWindow(signalWindow(duration.value,position.value));}
function zoomTimeline(factor){if(canPreview.value)setTimelineWindow(zoomWindow(duration.value,timelineWindow.value,position.value,factor));}
function panTimeline(from){if(canPreview.value)setTimelineWindow(panWindow(duration.value,timelineWindow.value,from));}
function returnToPosition(){if(canPreview.value&&timelineWindow.value)panTimeline(position.value-viewSpan.value/2);}
function queueWindowSignals(immediate=false){
  clearTimeout(windowSignalTimer);windowSignalTimer=null;
  if(disposing)return;
  const delay=immediate?0:Math.max(0,180-(Date.now()-lastWindowRequestAt));
  if(delay){windowSignalTimer=setTimeout(()=>queueWindowSignals(true),delay);return;}
  lastWindowRequestAt=Date.now();void loadSignals(true);
}
function endTimelineDrag(){timelineDragging.value=false;queueWindowSignals(true);}
function resetTimelineNavigation(){clearTimeout(windowSignalTimer);windowSignalTimer=null;timelineDragging.value=false;timelineWindow.value=null;}
function invalidateMessages(){messageRequest++;overlayRequest++;dmBusy=false;overlayBusy=false;lastMessageKey='';overlayWindow=null;}
function invalidateSignals(clear=false){signalRequest++;signalController?.abort();signalController=null;signalsLoading.value=false;lastSignalKey='';if(clear){signals.value=null;signalsError.value='';}}
async function loadSignals(force=false){
  if(disposing||!selectionReady.value||duration.value<=0||document.hidden||(!force&&timelineDragging.value))return;
  const id=selected.value,{from,to}=viewport.value,key=`${id}:${from}:${to}`;
  const audio=signals.value?.audio,settled=audio&&audio.status!=='pending'&&audio.status!=='processing'&&!audio.bins?.some(bin=>bin.state==='pending')&&signals.value?.density?.status!=='building';
  if(!force&&(signalsLoading.value||(key===lastSignalKey&&activeSession.value?.status==='finished'&&settled&&Date.now()-lastSignalAt<10000)))return;
  invalidateSignals();const request=signalRequest,version=selectionGeneration,controller=new AbortController();signalController=controller;signalsLoading.value=true;
  try{const response=await fetch(`/api/sessions/${id}/signals?from=${from}&to=${to}&bins=600`,{signal:controller.signal});const result=await response.json();if(!response.ok)throw new Error(result.error||'读取时间轴信号失败。');if(request!==signalRequest||version!==selectionGeneration||selected.value!==id)return;signals.value=result;signalsError.value='';lastSignalKey=key;lastSignalAt=Date.now();}
  catch(e){if(request===signalRequest&&e.name!=='AbortError')signalsError.value=e.message;}
  finally{if(request===signalRequest){signalsLoading.value=false;signalController=null;}}
}
function signalsVisibility(){if(document.hidden){clearTimeout(windowSignalTimer);windowSignalTimer=null;invalidateSignals();}else void loadSignals(true);}

function readMark(which){
  if(!selectionReady.value)throw new Error('请等待素材加载完成。');
  if(positionMode.value==='recording')return positionAtRecordingTime(parseRecordingInput(which==='start'?startDateText.value:endDateText.value),activeSession.value,detail.value?.sources||[],duration.value);
  const t=videoMark(which);if(t>duration.value+.000001)throw new Error('超出已录制范围。');return Math.min(t,duration.value);
}
function videoMark(which){
  const text=(which==='start'?startText.value:endText.value).trim();
  if(!text)throw new Error('请填写视频时间。');
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
function resetSelection(){previewTransport?.dispose();selectionGeneration++;generation++;selected.value=null;detail.value=null;invalidateMessages();invalidateSignals(true);resetTimelineNavigation();pausePreview();previewUrl.value='';loading.value=false;edit.value={revision:0,ranges:[],excluded:[],undo:[]};messages.value=[];overlayFeed.value=[];position.value=0;startMarked.value=false;endMarked.value=false;}
function applyState(value){
  state.value=value;if(selected.value&&!value.sessions.some(s=>s.id===selected.value))resetSelection();
  for(const [id,title] of requestedDeletions){
    if(!value.sessions.some(s=>s.id===id)&&!value.pendingCleanup?.some(s=>s.id===id)&&!value.deletions?.some(s=>s.id===id)){
      requestedDeletions.delete(id);tell(`「${title}」已清理完成，已导出的成片保留。`,'success');
    }
  }
}
function closeContext(){sessionMenu.value=null;jobMenu.value=null;}
async function showContext(event,session){closeContext();const rect=event.currentTarget.getBoundingClientRect();sessionMenu.value={session,x:Math.max(8,Math.min(event.clientX||rect.left+30,window.innerWidth-248)),y:Math.max(8,event.clientY||rect.bottom)};await nextTick();const menu=document.querySelector('.session-context');if(menu&&sessionMenu.value)sessionMenu.value.y=Math.max(8,Math.min(sessionMenu.value.y,window.innerHeight-menu.offsetHeight-8));menu?.querySelector('button:not(:disabled)')?.focus();}
const cancellingJobIds=ref([]);
function jobCancellationBlock(job){return !job?'任务不存在。':cancellingJobIds.value.includes(job.id)||job.status==='cancelling'?'正在取消，请稍候。':job.status==='saving'?'成片正在保存，完成后可删除。':!['queued','running','finalizing'].includes(job.status)?'该任务当前无法取消。':'';}
async function cancelJob(job){
  const reason=jobCancellationBlock(job);if(reason){tell(reason);return;}
  closeContext();cancellingJobIds.value=[...cancellingJobIds.value,job.id];
  try{await api('jobs/'+encodeURIComponent(job.id)+'/cancel',{});tell('导出已取消，原始素材和已完成缓存保留。','success');await refresh();}
  catch(error){tell(error.message);}finally{cancellingJobIds.value=cancellingJobIds.value.filter(id=>id!==job.id);}
}
function jobRemovalBlock(job){return !job?'该导出任务已不存在。':job.status==='save_failed'?'成片已编码但尚未保存，请先重试保存后再删除任务。':['queued','running','finalizing','saving','cancelling'].includes(job.status)||retrySavingIds.value.includes(job.id)?'任务正在排队、导出或保存，完成后才能删除。':!['done','failed','cancelled','canceled'].includes(job.status)?'该任务暂时无法删除。':'';}
function jobStatusText(job){return ({queued:'等待导出',running:'正在导出',finalizing:'正在整理成片',saving:'正在保存',cancelling:'正在取消',interrupted:'待恢复',save_failed:'保存失败（编码已完成）',done:'导出完成',failed:'导出失败',cancelled:'已取消',canceled:'已取消'})[job.status]||job.status;}
function jobDescription(job){return (job.scope==='full'?'完整素材':job.clipCount>1?`选段 ${job.clipIndex}/${job.clipCount}`:'选段')+' · '+(({clean:'纯净版',danmaku:'弹幕版',dual:'纯净 + 弹幕双文件'})[job.mode]||'视频')+' · '+date(job.created);}
function focusJob(id){bottomTab.value='jobs';void nextTick(()=>{const row=Array.from(document.querySelectorAll('.job-row')).find(element=>element.dataset.jobId===String(id));(row||document.querySelector('.jobs-panel'))?.focus({preventScroll:true});});}
function retrySaveReason(job){return !job?'该导出任务已不存在。':retrySavingIds.value.includes(job.id)||job.status==='saving'?'正在提交或保存，请稍候。':job.status!=='save_failed'?'该任务当前不需要重试保存。':job.canRetrySave!==true?'暂存成片暂不可用，无法重试保存。':'';}
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
  const directory=retrySaveDirectory.value.trim();if(changeDirectory&&!directory){retrySaveError.value='请填写完整的保存文件夹路径。';return;}
  retrySavingIds.value.push(id);delete jobRetryErrors.value[id];if(changeDirectory){modalBusy.value=true;retrySaveError.value='';}
  try{
    await api(`jobs/${encodeURIComponent(id)}/retry-save`,changeDirectory?{exportDirectory:directory}:{});
    if(disposing)return;
    const latest=state.value.jobs.find(item=>item.id===id);if(latest?.status==='save_failed'){latest.status='saving';latest.canRetrySave=false;latest.error='';}
    if(changeDirectory&&modal.value==='retry-save'&&retrySaveTarget.value?.id===id){modal.value='';retrySaveTarget.value=null;void nextTick(()=>focusJob(id));}
    tell('已开始重试保存，复用已编码的成片。','success');await refresh();
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
  try{const result=await api(`jobs/${encodeURIComponent(id)}/delete-preview`);if(request!==jobPreviewRequest||modal.value!=='delete-job'||jobDeleteTarget.value?.id!==id||disposing)return;if(result.id!==id||!Array.isArray(result.files)||(!result.blocked&&(typeof result.token!=='string'||!result.token.trim())))throw new Error('无法核对该任务对应的导出文件，请重试。');jobDeletePreview.value=result;}
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
  try{await api(`jobs/${encodeURIComponent(id)}/delete`,recordOnly?{confirmed:true,recordOnly:true}:{confirmed:true,token});state.value.jobs=state.value.jobs.filter(job=>job.id!==id);modal.value='';jobPreviewRequest++;jobDeleteTarget.value=null;jobDeletePreview.value=null;tell(recordOnly?'任务记录已移除，现有文件保留。':'该导出任务及对应成片已删除，原始素材和剪辑选段保留。','success');await refresh();await nextTick();focusJob(id);}
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
  if(kind==='remove-room'){await api('rooms/'+target.roomId+'/remove',{confirmed:true});tell('已移除监控房间，已录制素材保留。','success');}
  else if(kind==='delete-session'){materialDeleteError.value='';await deleteRecording(target.id);requestedDeletions.set(target.id,target.title);if(selected.value===target.id)resetSelection();tell('已开始后台清理，可继续操作其他素材。','success');}
  modal.value='';void refresh();
}catch(e){if(kind==='delete-session'){materialDeleteError.value=e.name==='TimeoutError'?'请求确认超时，可查看清理进度或重试；已受理的清理会继续。':e.message;tell(materialDeleteError.value);void refresh();}else tell(e.message);}finally{modalBusy.value=false;}}
function statusText(s){return ({recording:'录制中',waiting:'等待重连',finishing:'整理中',finished:'已完成',importing:'整理中'})[s]||s;}
function tell(text,kind='error'){notice.value=text;noticeKind.value=kind;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.value='',8000);}
async function refresh(){if(refreshBusy)return;refreshBusy=true;try{
  applyState(await api('state'));connected.value=true;
  if(selected.value&&selectionReady.value){const id=selected.value,version=selectionGeneration,result=await api(`sessions/${id}`);if(selected.value===id&&version===selectionGeneration){detail.value=result;if(previewEnded.value&&isPlaying.value)playNext();}}
}catch(e){connected.value=false;}finally{refreshBusy=false;}}
async function choose(id){
  const version=++selectionGeneration;
  detail.value=null;invalidateMessages();invalidateSignals(true);resetTimelineNavigation();
  previewTransport?.dispose();overlayWindow=null;closeContext();startMarked.value=false;endMarked.value=false;generation++;video.value?.pause();previewUrl.value='';isPlaying.value=false;loading.value=false;selected.value=id;detail.value=null;edit.value={revision:0,ranges:[],excluded:[],undo:[]};startExact.value=0;endExact.value=0;startText.value='00:00:00';endText.value='00:00:00';startDateText.value='';endDateText.value='';messages.value=[];overlayFeed.value=[];position.value=0;previewEnded.value=false;
  try{const result=await api(`sessions/${id}`);if(selected.value!==id||version!==selectionGeneration)return;detail.value=result;edit.value=result.edit;startExact.value=0;endExact.value=Math.min(10,result.duration);startText.value=format(0);endText.value=format(endExact.value);if(!canUseRecordingTime.value)positionMode.value='video';syncRecordingTexts();query.value='';lastMessageKey='';await Promise.all([loadMessages(true),loadOverlay()]);}
  catch(e){if(version===selectionGeneration)tell(e.message);}
}
async function save(){if(saving.value||!selectionReady.value)return false;const id=selected.value,version=selectionGeneration;saving.value=true;try{const result=await api(`sessions/${id}/edit`,{...edit.value,filterLottery:true});if(selected.value===id&&version===selectionGeneration){edit.value=result;return true;}return false;}catch(e){tell(e.message);if(selected.value===id&&version===selectionGeneration){const result=await api(`sessions/${id}`);if(selected.value===id&&version===selectionGeneration)edit.value=result.edit;}return false;}finally{saving.value=false;}}
async function addRoom(){
  if(addingRoom.value||modal.value||!roomUrl.value.trim())return;const entered=roomUrl.value.trim();addingRoom.value=true;
  try{
    const result=await api('rooms',{url:entered});if(disposing)return;
    if(result.needsSelection){roomChoice.value={...result,entered};roomChoicePlatform.value='';roomChoiceError.value='';modal.value='choose-room';await nextTick();document.querySelector('.room-choice-options input')?.focus();return;}
    if(roomUrl.value.trim()===entered)roomUrl.value='';tell('直播间已添加，开播后自动录制。','success');await refresh();
  }catch(e){if(!disposing)tell(e.message);}finally{addingRoom.value=false;}
}
async function confirmRoomChoice(){
  const candidate=roomChoice.value?.candidates.find(room=>room.platform===roomChoicePlatform.value);if(modalBusy.value||!candidate)return;
  const entered=roomChoice.value.entered;modalBusy.value=true;roomChoiceError.value='';
  try{
    await api('rooms',{url:candidate.url});if(disposing)return;
    if(roomUrl.value.trim()===entered)roomUrl.value='';modal.value='';roomChoice.value=null;roomChoicePlatform.value='';tell('直播间已添加，开播后自动录制。','success');await refresh();
  }catch(e){if(!disposing)roomChoiceError.value=e.message;}finally{modalBusy.value=false;}
}
async function roomAction(room,action,data={}){if(roomBusyIds.value.includes(room.roomId))return;roomBusyIds.value.push(room.roomId);try{await api(`rooms/${room.roomId}/${action}`,data);await refresh();}catch(e){tell(e.message);}finally{roomBusyIds.value=roomBusyIds.value.filter(id=>id!==room.roomId);}}
function containsTime(ranges,time){for(let i=0;i<ranges.length;i++)if(time>=ranges.start(i)&&time<ranges.end(i)-.05)return true;return false;}
async function playFrom(time,play=true){
  if(!canPreview.value)return;
  const available=detail.value?.sources||[];let target=Math.max(0,Math.min(time,Math.max(0,duration.value-.1)));
  let s=available.find(x=>x.start<=target+.02&&x.start+x.duration>=target-.02);
  if(!s){s=available.find(x=>x.start>target);if(!s){tell('该位置暂时没有录制画面。');return;}target=s.start;tell('已跳过直播断流的空缺区间。','success');}
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
  previewTransport=previewStream(`/api/sessions/${selected.value}/preview?start=${target.toFixed(4)}&v=${version}`,{onError(error){if(version===generation){loading.value=false;isPlaying.value=false;previewEnded.value=true;tell(error.message);}}});
  previewUrl.value=previewTransport.url;
  await nextTick();if(version!==generation)return;
  video.value.load();applyPreviewAudio();previewTransport.start();
  if(play)await video.value.play().catch(e=>{if(version===generation&&e.name!=='AbortError'){isPlaying.value=false;loading.value=false;tell('预览尚未就绪，请稍后重试。');}});
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
async function togglePlay(){if(isPlaying.value){pausePreview();return;}if(!previewUrl.value||previewEnded.value){await playFrom(position.value,true);return;}const version=generation;isPlaying.value=true;await video.value.play().catch(e=>{if(version===generation&&e.name!=='AbortError'){isPlaying.value=false;tell('暂时无法播放，请重新定位后重试。');}});}
function played(){isPlaying.value=!!video.value&&!video.value.paused;}
function loaded(){loading.value=false;applyPreviewAudio();if(!isPlaying.value)video.value?.pause();}
function paused(){if(video.value?.paused&&!loading.value&&!video.value.ended)isPlaying.value=false;}
function updateTime(){if(video.value&&!scrubbing.value)position.value=Math.min(duration.value,previewBase.value+video.value.currentTime);}
function seekFromSlider(event){scrubbing.value=false;void playFrom(Number(event.target.value),isPlaying.value);}
function step(direction){pausePreview();void playFrom(position.value+direction/fps.value,false);}
function playNext(){const available=detail.value?.sources||[];const same=available.find(s=>s.start<=position.value&&s.start+s.duration>position.value+.15);if(same){void playFrom(position.value+1/fps.value,true);return;}const next=available.find(s=>s.start>previewBase.value+.1&&s.start>=position.value-.3&&s.duration>0);if(next)void playFrom(next.start,true);}
function ended(){previewEnded.value=true;loading.value=false;if(isPlaying.value)playNext();}
async function addRange(){if(saving.value||!selectionReady.value)return;const id=selected.value,version=selectionGeneration;try{const start=readMark('start'),end=readMark('end');if(start<0||end<=start||end>duration.value+.05)throw new Error('请选择已录制范围内的起点和终点。');edit.value.ranges.push({start,end:Math.min(end,duration.value),selected:true});if(await save()&&selected.value===id&&version===selectionGeneration)clearDraftMarks();}catch(e){tell(e.message);}}
async function selectRange(index,value){edit.value.ranges[index].selected=value;await save();}
async function selectAllRanges(value){for(const range of edit.value.ranges)range.selected=value;await save();}
async function removeRange(index){edit.value.ranges.splice(index,1);await save();}
async function moveRange(index,direction){const list=edit.value.ranges,[item]=list.splice(index,1);list.splice(index+direction,0,item);await save();}
async function toggleMessage(message){const id=selected.value,version=selectionGeneration;if(excluded.value.has(message.id))edit.value.excluded=edit.value.excluded.filter(x=>x!==message.id);else {edit.value.excluded.push(message.id);edit.value.undo.push(message.id);}await save();if(id===selected.value&&version===selectionGeneration)void loadSignals(true);}
async function undoMessage(){const sessionId=selected.value,version=selectionGeneration,id=edit.value.undo.pop();if(!id)return;edit.value.excluded=edit.value.excluded.filter(x=>x!==id);await save();if(sessionId===selected.value&&version===selectionGeneration)void loadSignals(true);}
async function loadMessages(force=false){
  if(!selectionReady.value||dmBusy)return;const id=selected.value,version=selectionGeneration;const key=`${id}:${Math.floor(position.value/10)}:${query.value}:${followMessages.value}`;if(!force&&key===lastMessageKey)return;const request=++messageRequest;dmBusy=true;
  try{let from=0,to=Math.max(duration.value,1);if(followMessages.value&&!query.value){from=Math.max(0,position.value-20);to=position.value+40;}const result=await api(`sessions/${id}/messages?from=${from}&to=${to}&q=${encodeURIComponent(query.value)}`);if(request===messageRequest&&version===selectionGeneration&&id===selected.value){if(!sameMessages(messages.value,result))messages.value=result;lastMessageKey=key;}}
  catch(e){if(request===messageRequest&&version===selectionGeneration)tell(e.message);}finally{if(request===messageRequest)dmBusy=false;}
}
function sameMessages(a,b){return a.length===b.length&&a.every((m,i)=>m.id===b[i].id&&m.time===b[i].time&&m.text===b[i].text&&m.color===b[i].color&&m.user===b[i].user);}
async function loadOverlay(){
  if(!selectionReady.value||overlayBusy)return;const id=selected.value,t=position.value,version=selectionGeneration;
  if(containsOverlay(overlayWindow,id,t))return;
  const from=Math.max(0,t-45),to=t+35,window=makeOverlayWindow(id,from,to,duration.value,activeSession.value?.status==='finished'),request=++overlayRequest;overlayBusy=true;
  try{const result=await api(`sessions/${id}/messages?from=${from}&to=${to}&overlay=1`);if(request===overlayRequest&&version===selectionGeneration&&id===selected.value){if(!sameMessages(overlayFeed.value,result))overlayFeed.value=result;overlayWindow=window;}}
  catch{}finally{if(request===overlayRequest)overlayBusy=false;}
}
function openSettings(){const current=state.value.paths?.exports||'';savedExportDirectory.value=current;exportDirectory.value=current;closeActionError.value='';chatRateError.value='';chatRateDraft.value=null;modal.value='settings';}
async function setChatRate(value){if(chatRateBusy.value)return;chatRateBusy.value=true;chatRateDraft.value=Number(value);chatRateError.value='';try{const result=await api('settings',{danmakuPerSecond:Number(value)});state.value={...state.value,danmakuPerSecond:result.danmakuPerSecond};await refresh();invalidateMessages();invalidateSignals(true);await Promise.all([loadMessages(true),loadOverlay()]);}catch(e){chatRateError.value=e.message;}finally{chatRateDraft.value=null;chatRateBusy.value=false;}}
async function setCloseAction(value){if(closeActionBusy.value)return;closeActionBusy.value=true;closeActionDraft.value=value;closeActionError.value='';try{const result=await api('settings',{closeAction:value});state.value={...state.value,closeAction:result.closeAction};await refresh();}catch(e){closeActionError.value=e.message;}finally{closeActionDraft.value=null;closeActionBusy.value=false;}}
function openExport(){if(!selected.value||!selectedRanges.value.length){tell('请先勾选至少一个选段。');return;}exportScope.value='clips';exportTarget.value={id:selected.value,title:activeSession.value?.title};exportRanges.value=selectedRanges.value.map(r=>({start:r.start,end:r.end}));exportExcluded.value=edit.value.excluded.length;exportMode.value='dual';exportDirectory.value=state.value.paths?.exports||'';modal.value='export';}
function openFullExport(session){const latest=state.value.sessions.find(s=>s.id===session.id),blocked=latest?fullExportBlock(latest):'素材已被删除。';if(blocked){tell(blocked);return;}closeContext();exportScope.value='full';exportTarget.value={id:latest.id,title:latest.title};exportRanges.value=[];exportExcluded.value=0;exportMode.value='dual';exportDirectory.value=state.value.paths?.exports||'';modal.value='export';}
async function browseFolder(){try{const value=await pickExportFolder(exportDirectory.value);if(!value)return;exportDirectory.value=value;if(modal.value==='settings')await commitExportDirectory();}catch(e){tell(e.message);}}
async function commitExportDirectory(){if(modal.value!=='settings'||modalBusy.value)return;const value=exportDirectory.value.trim();if(!value){if(exportDirectory.value!==savedExportDirectory.value)tell('请填写导出文件夹的完整路径。');return;}if(value===savedExportDirectory.value)return;modalBusy.value=true;try{const result=await api('settings',{exportDirectory:value});const saved=result.paths?.exports||value;savedExportDirectory.value=saved;exportDirectory.value=saved;await refresh();tell('默认导出文件夹已保存。','success');}catch(e){tell(e.message);}finally{modalBusy.value=false;}}
async function openFolder(input){try{await api('folders/open',input);}catch(e){tell(e.message);}}
function searchChanged(){messageRequest++;dmBusy=false;clearTimeout(queryTimer);queryTimer=setTimeout(()=>loadMessages(true),250);}
async function exportClip(){if(modalBusy.value)return;if(exportBlock.value){tell(exportBlock.value);return;}modalBusy.value=true;const target=exportTarget.value.id,scope=exportScope.value;try{const result=await api(`sessions/${target}/export`,{scope,mode:exportMode.value,...(scope==='clips'?{ranges:exportRanges.value}:{}),exportDirectory:exportDirectory.value});modal.value='';tell(scope==='full'?'完整素材已加入导出队列。':`已创建 ${result.jobs?.length??1} 个导出任务，将按顺序逐个处理。`,'success');await refresh();}catch(e){tell(e.message);}finally{modalBusy.value=false;}}
function onKey(e){if(e.key==='Escape'){const jobId=jobMenu.value?.id;closeContext();closeModal();if(jobId)focusJob(jobId);return;}if(sessionMenu.value||jobMenu.value)return;if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)||modal.value)return;if(e.code==='Space'){e.preventDefault();void togglePlay();}else if(e.code==='ArrowLeft'){e.preventDefault();step(-1);}else if(e.code==='ArrowRight'){e.preventDefault();step(1);}else if(e.key.toLowerCase()==='i')setMark('start');else if(e.key.toLowerCase()==='o')setMark('end');}
watch([selectionReady,selected],()=>{invalidateSignals(true);void loadSignals(true);});
watch(timelineWindow,()=>{invalidateSignals();signalsError.value='';queueWindowSignals(!timelineDragging.value);},{flush:'sync'});
onMounted(async()=>{await refresh();if(disposing)return;eventSource=new EventSource('/api/events');eventSource.onmessage=e=>{applyState(JSON.parse(e.data));connected.value=true;};eventSource.onerror=()=>connected.value=false;timer=setInterval(refresh,2500);messageTimer=setInterval(()=>{void loadMessages(true);void loadOverlay();},1500);signalsTimer=setInterval(()=>void loadSignals(),3000);document.addEventListener('visibilitychange',signalsVisibility);window.addEventListener('keydown',onKey);window.addEventListener('pointerdown',closeContext);window.addEventListener('pointerup',previewVolumeUp);window.addEventListener('pointercancel',previewVolumeUp);window.addEventListener('blur',closeContext);});
onBeforeUnmount(()=>{previewTransport?.dispose();disposing=true;clearTimeout(windowSignalTimer);invalidateSignals();invalidateMessages();eventSource?.close();clearInterval(timer);clearInterval(messageTimer);clearInterval(signalsTimer);clearTimeout(queryTimer);clearTimeout(noticeTimer);document.removeEventListener('visibilitychange',signalsVisibility);window.removeEventListener('keydown',onKey);window.removeEventListener('pointerdown',closeContext);window.removeEventListener('pointerup',previewVolumeUp);window.removeEventListener('pointercancel',previewVolumeUp);window.removeEventListener('blur',closeContext);});
onMounted(()=>{panelBreakpoint.addEventListener('change',updatePanelBreakpoint);compactBreakpoint.addEventListener('change',updatePanelBreakpoint);});
onBeforeUnmount(()=>{panelBreakpoint.removeEventListener('change',updatePanelBreakpoint);compactBreakpoint.removeEventListener('change',updatePanelBreakpoint);});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><img class="brand-icon" :src="appIcon" alt="" width="30" height="30"/><strong>菜播·录包机</strong></div>
      <div class="top-actions"><button class="button subtle panel-toggle" aria-label="切换素材栏" @keydown.stop :aria-expanded="libraryVisible" aria-controls="library-panel" title="展开或收起直播间与素材栏" @click="libraryPreference=!libraryVisible"><Film :size="16"/><span>素材</span></button><button class="button subtle panel-toggle" aria-label="切换弹幕栏" @keydown.stop :aria-expanded="danmakuVisible" aria-controls="danmaku-panel" title="展开或收起弹幕列表" @click="danmakuPreference=!danmakuVisible"><Radio :size="16"/><span>弹幕</span></button><span class="core-status" :title="state.recorder.error"><i :class="{online:state.recorder.online}"/>{{ state.recorder.online?'录制服务就绪':'录制服务未连接' }}</span><button class="button subtle" @click="openSettings"><Settings :size="16"/><span>设置</span></button></div>
    </header>
    <div class="workspace" :class="{'library-collapsed':!libraryVisible,'danmaku-collapsed':!danmakuVisible}">
      <aside id="library-panel" v-show="libraryVisible" class="library">
        <button v-if="pendingCleanup.length" class="button subtle" @click="openCleanup">素材清理进度 · 查看</button>
        <section class="room-section"><h2><Radio :size="17"/>直播间</h2>
          <form class="room-form" @submit.prevent="addRoom"><input v-model="roomUrl" aria-label="直播间链接或房间号" placeholder="直播链接或房间号" :disabled="addingRoom"/><button class="button primary small" type="submit" :disabled="addingRoom||!state.recorder.online"><LoaderCircle v-if="addingRoom" class="spin" :size="15"/><span v-else>添加</span></button></form>
          <p v-if="!state.recorder.online" class="room-offline" role="status">{{ state.recorder.error || '正在连接录制服务…' }}<span>连接恢复后会自动启用添加按钮，可先填写直播间链接。</span></p>
          <div v-if="!state.rooms.length" class="rail-empty">添加房间号或直播间链接<br/>开播后自动录制</div>
          <article v-for="room in state.rooms" :key="room.roomId" class="room-item">
            <div class="room-title"><i :class="['live-dot',{online:room.recording}]"/><strong>{{ room.name||`直播间 ${room.webRid||room.roomId}` }}</strong><button class="icon-button remove-room" :aria-label="'移除监控：'+(room.name||room.roomId)" title="移除监控房间" :disabled="!roomAvailable(room,state.recorder)" @click="requestRemove(room)"><X :size="15"/></button></div>
            <p :title="room.error||room.chatError">{{ roomStatus(room) }} · {{ room.platform==='douyin'?'抖音':'B站' }} {{ room.webRid||room.roomId }}</p>
            <p v-if="room.error||room.chatError" class="room-offline" role="status">{{ room.error||room.chatError }}</p>
            <div class="room-controls"><label><input type="checkbox" :checked="room.autoRecord" :disabled="!roomAvailable(room,state.recorder)||roomBusyIds.includes(room.roomId)" @change="roomAction(room,'auto',{enabled:$event.target.checked})"/>自动录制</label><button class="text-button" :disabled="!roomAvailable(room,state.recorder)||roomBusyIds.includes(room.roomId)" @click="roomAction(room,roomRecordEnabled(room)?'stop':'start')">{{ roomRecordEnabled(room)?'停止':'开始' }}</button></div>
          </article>
        </section>
        <section class="recording-section"><div class="section-heading"><h2><Film :size="17"/>录像素材</h2></div>
          <div v-if="!state.sessions.length" class="rail-empty">录制开始后，素材会出现在这里。</div>
          <button v-for="session in state.sessions" :key="session.id" class="session-item" :class="{selected:selected===session.id}" @click="choose(session.id)" @contextmenu.prevent="showContext($event,session)" @keydown.shift.f10.prevent="showContext($event,session)" @keydown.context-menu.prevent="showContext($event,session)" title="右键管理素材"><Film :size="20"/><span><strong>{{ session.title }}</strong><small>{{ date(session.created) }}</small><span class="session-meta"><i v-if="session.status==='recording'" class="live-dot online"/>{{ statusText(session.status) }} · {{ format(session.duration) }}</span></span></button>
        </section>
        <footer class="library-credit"><p>软件作者：瞌睡小菜包</p><p>技术支持：藤椒麦旋风</p><p><a href="https://space.bilibili.com/5162836" @click.prevent="openAuthorPage">联系我们</a></p></footer>
      </aside>
      <main class="editor">
        <div class="editor-heading"><div><Film :size="21"/><h1>{{ activeSession?.title||'直播剪辑工作台' }}</h1><span v-if="activeSession?.status==='recording'" class="recording-label"><i class="live-dot online"/>录制中</span></div></div>
        <div v-if="activeSession?.error" class="inline-warning"><AlertCircle :size="16"/><span>{{ activeSession.error }}</span></div>
        <div class="video-stage">
          <video v-if="previewUrl" ref="video" :src="previewUrl" playsinline preload="auto" @loadeddata="loaded" @canplay="loaded" @timeupdate="updateTime" @play="played" @pause="paused" @waiting="loading=true" @playing="loading=false" @ended="ended" @error="loading=false;tell('预览读取失败，请稍后重新定位。原始素材仍保留。')" @click="togglePlay"/>
          <div v-if="!previewUrl" class="preview-empty"><button class="preview-start" :disabled="!canPreview" @click="togglePlay"><Play v-if="canPreview" :size="42"/><Video v-else :size="42"/></button><strong>{{ canPreview?'播放预览':selected?'等待录制画面':'选择一段录像' }}</strong><span>{{ selected?'录制继续进行，已录内容可随时回看':'添加直播间，开播后自动录制' }}</span></div>
          <div v-if="loading" class="video-loading"><LoaderCircle :size="30" class="spin"/><span>正在读取画面</span></div>
          <DanmakuOverlay v-if="previewUrl" :video="video" :base="previewBase" :messages="overlayFeed" :excluded="excluded" :enabled="showOverlay" :loading="loading"/>
        </div>
        <div class="playback-toolbar"><div class="playback-left"><button class="icon-button" aria-label="上一帧" title="上一帧（左方向键）" :disabled="!canPreview" @click="step(-1)"><StepBack :size="21"/></button><button class="icon-button play" :disabled="!canPreview" :aria-label="isPlaying?'暂停':'播放'" @click="togglePlay"><Pause v-if="isPlaying" :size="25"/><Play v-else :size="25"/></button><button class="icon-button" aria-label="下一帧" title="下一帧（右方向键）" :disabled="!canPreview" @click="step(1)"><StepForward :size="21"/></button><div class="preview-volume" :class="{open:previewVolumeOpen}" @pointerenter="openPreviewVolume" @pointerleave="leavePreviewVolume" @pointerdown="previewVolumeDown"><button type="button" class="icon-button" :disabled="!canPreview" :aria-pressed="previewMuted||previewVolume===0" :aria-label="previewMuted||previewVolume===0?'恢复预览声音':'静音预览'" :title="(previewMuted||previewVolume===0?'预览已静音，点击恢复声音':'点击静音预览')+'。只改变这里的播放，导出视频的声音不变'" @click="togglePreviewMute"><VolumeX v-if="previewMuted||previewVolume===0" :size="18"/><Volume1 v-else-if="previewVolume<0.5" :size="18"/><Volume2 v-else :size="18"/></button><div class="preview-volume-pop"><div class="preview-volume-rotator"><input type="range" min="0" max="100" step="1" :value="Math.round(previewSlider*100)" :disabled="!canPreview" aria-label="预览音量" :title="'预览音量 '+Math.round(previewSlider*100)+'%'" @input="setPreviewVolume"/></div></div></div><span class="playback-time">{{ format(position) }} <span>/ {{ format(duration) }}</span></span></div><div class="playback-right"><button class="button subtle" :disabled="!canPreview" @click="playFrom(Math.max(0,duration-3),true)"><RotateCcw :size="16"/>回到最新</button><label class="checkbox"><input v-model="showOverlay" type="checkbox"/>弹幕预览</label></div></div>
        <section class="timeline-section" aria-label="连续录像时间轴" :data-view-from="viewport.from" :data-view-to="viewport.to">
          <div class="timeline-view-controls"><span class="timeline-window-label">{{ timelineWindow?'局部查看':'全场' }} · {{ format(viewSpan) }}</span><div class="timeline-zoom" role="group" aria-label="时间轴查看范围" @keydown.stop>
            <button class="timeline-zoom-icon" type="button" aria-label="缩小时间轴" title="缩小时间轴，显示更长范围" :disabled="!canPreview||viewSpan>=duration-.001" @click="zoomTimeline(2)"><Minus :size="14"/></button>
            <button class="timeline-zoom-icon" type="button" aria-label="放大时间轴" title="放大时间轴，最小查看10秒" :disabled="!canPreview||viewSpan<=Math.min(10,duration)+.001" @click="zoomTimeline(.5)"><Plus :size="14"/></button>
            <button type="button" :disabled="!canPreview" :aria-pressed="!!timelineWindow&&Math.abs(viewSpan-Math.min(120,duration))<.001" title="以当前播放位置为中心，查看两分钟" @click="focusTimeline">2分钟</button>
            <button type="button" :disabled="!canPreview" :aria-pressed="!timelineWindow" @click="setTimelineWindow(null)">全场</button>
            <button type="button" :disabled="!canPreview||!timelineWindow" title="将当前播放位置移到视窗中间，不改变播放进度" @click="returnToPosition"><Target :size="12"/>回到播放位置</button>
          </div></div>
          <div class="ruler"><span v-for="n in 5" :key="n" :class="{'ruler-quarter':n===2||n===4}">{{ format(viewport.from+(viewport.to-viewport.from)*(n-1)/4) }}</span></div>
          <div id="timeline-tracks" class="timeline-tracks"><div class="timeline"><div class="timeline-track"/>
            <TimelineSignals kind="audio" :audio="signals?.audio" :from="viewport.from" :to="viewport.to" :data-from="signals?.from??viewport.from" :data-to="signals?.to??viewport.to" :selected="selectionReady" :loading="signalsLoading" :error="signalsError"/>
            <div v-if="draftView" class="draft-range" :style="rangeStyle(draftView)"/>
            <TimelineMarker v-if="inViewport(draftStart)" kind="start" :time="draftStart" :from="viewport.from" :to="viewport.to" :min="0" :max="draftEnd!==null&&draftEnd>0?draftEnd-.001:duration" :fps="fps" :disabled="!canPreview||saving" @change="dragMark('start',$event)" @commit="previewMark" @start="timelineDragging=true" @end="endTimelineDrag"/>
            <TimelineMarker v-if="inViewport(draftEnd)" kind="end" :time="draftEnd" :from="viewport.from" :to="viewport.to" :min="draftStart!==null&&draftStart<duration?draftStart+.001:0" :max="duration" :fps="fps" :disabled="!canPreview||saving" @change="dragMark('end',$event)" @commit="previewMark" @start="timelineDragging=true" @end="endTimelineDrag"/>
            <div v-for="{range,index,view} in visibleRanges" :key="index" class="range-highlight" :class="{unselected:range.selected===false}" :title="'选段 '+(index+1)+'：'+format(range.start)+' → '+format(range.end)" :style="rangeStyle(view)"/>
            <div v-if="inViewport(position)" class="playhead" :style="{left:timelinePercent(position)+'%'}"/>
            <input type="range" aria-label="播放位置" :min="viewport.from" :max="viewport.to||1" step="0.001" :value="sliderPosition" :disabled="!canPreview" @pointerdown="scrubbing=true" @input="position=Number($event.target.value)" @change="seekFromSlider"/>
          </div>
          <TimelineSignals kind="density" :density="signals?.density" :from="viewport.from" :to="viewport.to" :data-from="signals?.from??viewport.from" :data-to="signals?.to??viewport.to" :position="position" :selected="selectionReady" :loading="signalsLoading" :error="signalsError" :disabled="!canPreview" @seek="playFrom($event,isPlaying)"/>
          </div>
          <TimelineNavigator :key="selected||'empty'" :duration="duration" :from="viewport.from" :to="viewport.to" :disabled="!canPreview" @pan="panTimeline" @start="timelineDragging=true" @end="endTimelineDrag"/>
          <div v-if="startMarked||endMarked" class="marker-summary" aria-live="polite"><span class="start-color">{{ draftStart===null?'起点未标记或超出范围':'I 起点 · '+format(draftStart) }}</span><span class="end-color">{{ draftEnd===null?'终点未标记或超出范围':'O 终点 · '+format(draftEnd) }}</span><span v-if="draftDuration!==null" class="selection-duration">片段时长 · {{ format(displayedSpan(draftStart,draftEnd)) }}</span><span v-if="draftStart!==null&&draftEnd!==null&&draftEnd<=draftStart" class="invalid-range">终点需要晚于起点</span></div>
          <div class="selection-controls" :class="{'recording-time-controls':positionMode==='recording'}">
            <div class="selection-start">
              <div class="position-mode" role="group" aria-label="定位方式" @keydown.stop><button type="button" :aria-pressed="positionMode==='video'" :disabled="!selected" @click="setPositionMode('video')">视频时间</button><button type="button" :aria-pressed="positionMode==='recording'" :disabled="!canUseRecordingTime" :title="canUseRecordingTime?'按录制日期和时刻定位':'这份素材没有可靠的开录时间'" @click="setPositionMode('recording')">录制时间</button></div>
              <label v-if="positionMode==='video'">起点<input v-model="startText" @input="startMarked=true" @change="commitMark('start')" @keydown.enter.prevent="$event.target.blur()" aria-label="选段起点" :disabled="!selectionReady"/></label>
              <label v-else>起点<input v-model="startDateText" type="datetime-local" step="0.001" :min="clockBounds?toRecordingInput(clockBounds.min):undefined" :max="clockBounds?toRecordingInput(clockBounds.max):undefined" @input="startMarked=true" @change="commitMark('start')" @keydown.enter.prevent="$event.target.blur()" aria-label="起点录制时间" :aria-invalid="startMarked&&draftStart===null" :disabled="!canUseRecordingTime"/></label>
            </div>
            <label v-if="positionMode==='video'">终点<input v-model="endText" @input="endMarked=true" @change="commitMark('end')" @keydown.enter.prevent="$event.target.blur()" aria-label="选段终点" :disabled="!selectionReady"/></label>
            <label v-else>终点<input v-model="endDateText" type="datetime-local" step="0.001" :min="clockBounds?toRecordingInput(clockBounds.min):undefined" :max="clockBounds?toRecordingInput(clockBounds.max):undefined" @input="endMarked=true" @change="commitMark('end')" @keydown.enter.prevent="$event.target.blur()" aria-label="终点录制时间" :aria-invalid="endMarked&&draftEnd===null" :disabled="!canUseRecordingTime"/></label>
            <div class="selection-markers"><button class="button" :disabled="!canPreview" title="快捷键 I" @click="setMark('start')">设置起点</button><button class="button" :disabled="!canPreview" title="快捷键 O" @click="setMark('end')">设置终点</button></div>
            <div class="selection-actions"><button class="button primary" :disabled="!canPreview||saving||!!markerError" @click="addRange"><Plus :size="16"/>添加选段</button><button class="button accent export-selected" :disabled="!selectedRanges.length||saving||!selected" @click="openExport"><Download :size="17"/>导出选段<span v-if="selectedRanges.length">（{{ selectedRanges.length }}）</span></button></div>
          </div>
          <p v-if="markerError" class="position-error" role="status">{{ markerError }}</p>
        </section>
        <div class="bottom-panels" :data-tab="bottomTab"><div class="bottom-switch" role="tablist" aria-label="选段与导出"><button type="button" role="tab" :aria-selected="bottomTab==='clips'" @click="bottomTab='clips'">选段 <span>({{ edit.ranges.length }})</span></button><button type="button" role="tab" :aria-selected="bottomTab==='jobs'" @click="bottomTab='jobs'">导出 <span>({{ myJobs.length }})</span></button></div><section class="clips-panel"><h2><Scissors :size="16"/>待导出选段 <span>({{ edit.ranges.length }})</span><small v-if="edit.ranges.length">已选 {{ selectedRanges.length }}/{{ edit.ranges.length }} · {{ format(rangeDuration) }}</small></h2><div v-if="edit.ranges.length" class="clip-selection-toolbar"><label><input type="checkbox" aria-label="全选选段" :checked="allRangesSelected" :indeterminate="selectedRanges.length>0&&!allRangesSelected" :disabled="saving" @change="selectAllRanges($event.target.checked)"/>全选</label><span>每个勾选选段独立导出，按列表顺序逐个处理</span></div><div v-if="!edit.ranges.length" class="panel-empty">设置起点和终点，添加想保留的片段</div><div class="clip-list"><div v-for="(range,index) in edit.ranges" :key="index" class="clip-row" :class="{unselected:range.selected===false}"><input class="clip-checkbox" type="checkbox" :aria-label="'选择第 '+(index+1)+' 个选段'" :checked="range.selected!==false" :disabled="saving" @change="selectRange(index,$event.target.checked)"/><button class="clip-time" @click="playFrom(range.start,true)">{{ format(range.start) }} <span>→</span> {{ format(range.end) }}</button><div><button class="icon-button" aria-label="上移选段" :disabled="index===0||saving" @click="moveRange(index,-1)"><ChevronUp :size="15"/></button><button class="icon-button" aria-label="下移选段" :disabled="index===edit.ranges.length-1||saving" @click="moveRange(index,1)"><ChevronDown :size="15"/></button><button class="icon-button" aria-label="移除选段" :disabled="saving" @click="removeRange(index)"><X :size="16"/></button></div></div></div></section>
          <section class="jobs-panel" tabindex="-1"><h2><Download :size="16"/>导出任务 <span>({{ myJobs.length }})</span></h2><div v-if="!myJobs.length" class="panel-empty">暂无导出任务</div>
            <div v-for="job in myJobs" :key="job.id" class="job-row" tabindex="0" role="group" aria-haspopup="menu" :aria-label="'导出任务：'+jobDescription(job)" :data-job-id="job.id" title="右键管理导出任务" @contextmenu.prevent.stop="showJobContext($event,job)" @keydown.shift.f10.prevent.stop="showJobContext($event,job)" @keydown.context-menu.prevent.stop="showJobContext($event,job)">
              <div><LoaderCircle v-if="['running','queued','finalizing','saving','cancelling'].includes(job.status)" class="spin job-ok" :size="15"/><Check v-else-if="job.status==='done'" class="job-ok" :size="15"/><AlertCircle v-else class="job-bad" :size="15"/><span><template v-if="job.clipCount>1">选段 {{ job.clipIndex }}/{{ job.clipCount }} · </template>{{ jobStatusText(job) }}</span><small>{{ date(job.created) }}</small></div>
              <progress v-if="job.status==='running'" :value="job.progress" max="1"/><p v-if="job.status==='running'" class="job-progress-text">处理进度 {{ Math.round(job.progress*100) }}%</p>
              <p v-if="job.status==='saving'" class="job-save-hint">成片已编码，正在写入目标文件夹。</p><p v-else-if="job.status==='save_failed'&&job.canRetrySave" class="job-save-hint">成片已暂存，重试保存无需重新编码。</p>
              <p v-if="job.error" class="job-error">{{ job.error }}</p><p v-if="jobRetryErrors[job.id]&&jobRetryErrors[job.id]!==job.error&&job.status==='save_failed'" class="job-error" role="alert">{{ jobRetryErrors[job.id] }}</p>
              <p v-if="job.file" class="output-path" :title="job.file">{{ job.mode==='danmaku'?'弹幕版：':'纯净版：' }}{{ job.file }}</p><p v-if="job.mode==='dual'" class="output-path" :title="job.danmaku_file">弹幕版：{{ job.danmaku_file }}</p>
              <div v-if="job.status==='save_failed'" class="job-save-actions" @keydown.stop><button class="text-button" :disabled="!!retrySaveReason(job)" @click="retryJobSave(job)"><LoaderCircle v-if="retrySavingIds.includes(job.id)" class="spin" :size="14"/><RotateCcw v-else :size="14"/>重试保存</button><button class="text-button" :disabled="!!retrySaveReason(job)" @click="openRetrySave(job)"><FolderOpen :size="14"/>更换保存位置…</button></div>
              <p v-if="job.status==='save_failed'&&job.canRetrySave!==true" class="job-save-hint">{{ retrySaveReason(job) }}</p>
              <div v-if="job.status==='done'" class="download-links" @keydown.stop><button class="text-button" @click="openFolder({jobId:job.id})"><FolderOpen :size="14"/>打开文件夹</button></div>
            </div>
          </section></div>
        <div v-if="activeSession" class="archive-line"><button class="text-button" title="打开完整素材导出目录" @click="openFolder({kind:'full'})"><FolderOpen :size="16"/>完整素材</button><span>右键已完成的录像可导出整场视频</span></div>
        <section v-if="activeSession" class="preparation-panel" aria-label="后台预处理" :data-preparation-status="selectedPreparation?.status||'none'">
          <div class="preparation-summary"><span class="preparation-state" role="status"><LoaderCircle v-if="selectedPreparation?.status==='preparing'" class="spin" :size="14"/><Check v-else-if="selectedPreparation?.status==='ready'" :size="14"/><span>{{ activeSession.status==='finished'?preparationStatus(selectedPreparation):'录制完成后可预处理' }}</span></span><span v-if="selectedPreparation?.totalSeconds>0&&selectedPreparation?.status!=='exported'" class="preparation-duration">{{ format(Math.min(selectedPreparation.preparedSeconds||0,selectedPreparation.totalSeconds)) }} / {{ format(selectedPreparation.totalSeconds) }}</span><span v-if="selectedPreparation?.bytes>0" class="preparation-space">缓存 {{ formatBytes(selectedPreparation.bytes) }}</span><div v-if="selectedPreparationAction" class="preparation-actions" @keydown.stop><button class="text-button" :disabled="!!selectedPreparationBlock" :title="selectedPreparationBlock" @click="actPreparation(activeSession)"><LoaderCircle v-if="preparationBusyIds.includes(activeSession.id)" class="spin" :size="14"/><Pause v-else-if="selectedPreparationAction==='pause'" :size="14"/><RotateCcw v-else-if="selectedPreparation?.status==='error'" :size="14"/><Play v-else :size="14"/>{{ preparationActionLabel(selectedPreparation) }}</button></div></div>
          <progress v-if="selectedPreparation&&selectedPreparation.totalSeconds>0&&!['ready','exported'].includes(selectedPreparation.status)" aria-label="后台预处理进度" :value="preparationProgress(selectedPreparation)" max="1"/>
          <p v-if="preparationErrors[activeSession.id]" class="preparation-note preparation-error" role="alert">{{ preparationErrors[activeSession.id] }}</p><p v-else-if="activeSession.status==='finished'&&preparationReason(selectedPreparation)" class="preparation-note" :class="{'preparation-error':selectedPreparation?.status==='error'}">{{ preparationReason(selectedPreparation) }}</p>
        </section>
      </main>
      <aside id="danmaku-panel" v-show="danmakuVisible" class="danmaku-panel"><div class="danmaku-heading"><h2>弹幕</h2><button class="icon-button" title="撤销最近一次排除" aria-label="撤销弹幕删除" :disabled="!edit.undo.length||saving" @click="undoMessage"><RotateCcw :size="17"/></button></div><div class="search-input"><Search :size="17"/><input v-model="query" aria-label="搜索弹幕" placeholder="搜索弹幕或发送者" @input="searchChanged"/></div><div class="danmaku-options"><label><input v-model="followMessages" type="checkbox" @change="searchChanged"/>跟随播放位置</label></div><div class="danmaku-list"><div v-if="!visibleMessages.length" class="danmaku-empty"><Radio :size="28"/><strong>{{ query?'没有匹配的弹幕':'这里会显示录制的弹幕' }}</strong><span>{{ selected?'弹幕会随录像持续更新':'选择录像后查看和编辑' }}</span></div><div v-for="message in visibleMessages" :key="message.id" class="danmaku-row" :class="{excluded:excluded.has(message.id),current:Math.abs(message.time-position)<1}"><button class="message-content" @click="playFrom(message.time,false)"><span class="message-meta"><time>{{ format(message.time) }}</time><span>{{ message.user }}</span></span><span class="message-text">{{ message.text }}</span></button><button class="icon-button" :aria-label="`${excluded.has(message.id)?'恢复':'删除'}弹幕：${message.text}`" :title="excluded.has(message.id)?'恢复到剪辑':'从剪辑中排除，保留原始弹幕'" :disabled="saving" @click="toggleMessage(message)"><RotateCcw v-if="excluded.has(message.id)" :size="15"/><Trash2 v-else :size="15"/></button></div></div><div class="danmaku-footer">已排除 {{ edit.excluded.length }} 条 · 原始弹幕保留</div></aside>
    </div>
    <footer class="statusbar"><span><i :class="['live-dot',{online:connected}]"/>剪辑不改动原始录像和弹幕</span><span>{{ saving?'正在保存剪辑…':selected?'剪辑自动保存':'支持 B 站、抖音' }}</span></footer>
    <div v-if="notice" class="toast" :class="noticeKind" role="status"><Check v-if="noticeKind==='success'" :size="18"/><AlertCircle v-else :size="18"/><span>{{ notice }}</span><button class="icon-button" aria-label="关闭提示" @click="notice=''"><X :size="16"/></button></div>
    <div v-if="sessionMenu" class="session-context" role="menu" aria-label="素材操作" :style="{left:sessionMenu.x+'px',top:sessionMenu.y+'px'}" @pointerdown.stop><button role="menuitem" :disabled="!!fullExportBlock(sessionMenu.session)" :title="fullExportBlock(sessionMenu.session)" @click="openFullExport(sessionMenu.session)"><Download :size="16"/>导出完整素材</button><p v-if="fullExportBlock(sessionMenu.session)" class="context-hint">{{ fullExportBlock(sessionMenu.session) }}</p><button role="menuitem" :disabled="!!preparationActionBlock(sessionMenu.session)" :title="preparationActionBlock(sessionMenu.session)" @click="actPreparation(sessionMenu.session)"><Pause v-if="preparationAction(preparationFor(sessionMenu.session.id))==='pause'" :size="16"/><Check v-else-if="preparationFor(sessionMenu.session.id)?.status==='ready'" :size="16"/><Play v-else :size="16"/>{{ preparationActionLabel(preparationFor(sessionMenu.session.id),true) }}</button><p v-if="!preparationEnabled&&preparationAction(preparationFor(sessionMenu.session.id))!=='pause'" class="context-hint">请在设置中开启后台预处理。</p><button role="menuitem" class="context-danger" @click="requestDelete(sessionMenu.session)"><Trash2 :size="16"/>删除素材…</button></div>
    <div v-if="jobMenu" class="session-context job-context" role="menu" aria-label="导出任务操作" tabindex="-1" :style="{left:jobMenu.x+'px',top:jobMenu.y+'px'}" @pointerdown.stop>
      <button v-if="['queued','running','finalizing','cancelling','saving'].includes(jobMenuTarget?.status)" role="menuitem" :disabled="!!jobCancellationBlock(jobMenuTarget)" :title="jobCancellationBlock(jobMenuTarget)" @click="cancelJob(jobMenuTarget)"><X :size="16"/>取消导出</button>
      <button role="menuitem" class="context-danger" :disabled="!!jobRemovalBlock(jobMenuTarget)" @click="requestJobDelete(jobMenuTarget)"><Trash2 :size="16"/>删除导出任务…</button>
      <p v-if="jobRemovalBlock(jobMenuTarget)" class="context-hint">{{ jobRemovalBlock(jobMenuTarget) }}</p>
    </div>
    <div v-if="modal" class="modal-backdrop" @click.self="closeModal"><section class="modal" :role="confirmation?'alertdialog':'dialog'" aria-modal="true" :aria-label="modalTitle"><button class="icon-button close-modal" aria-label="关闭窗口" :disabled="modalBusy" @click="closeModal"><X :size="20"/></button>
      <template v-if="confirmation"><h2><Trash2 :size="22"/>{{ modalTitle }}</h2>
        <template v-if="modal==='remove-room'"><p>确认移除「{{ confirmTarget.name||confirmTarget.roomId }}」（{{ confirmTarget.roomId }}）的监控？</p><p>{{ confirmTarget.recording?'该房间正在录制，移除会结束本次录制。':'' }}以后不再自动录制，已录制素材和已导出的成片保留。</p></template>
        <template v-else-if="modal==='delete-job'">
          <p class="confirm-meta">{{ jobDeleteTarget?jobDescription(jobDeleteTarget):'' }}</p>
          <label class="checkbox"><input type="checkbox" v-model="jobDeleteRecordOnly" :disabled="modalBusy"/>仅移除任务记录，保留现有文件</label>
          <p v-if="jobDeleteRecordOnly">确认从导出列表移除这条记录？不会删除或修改任何视频文件，此操作无法撤销。</p><p v-else>将永久删除该任务对应的导出文件，并移除任务记录。此操作无法撤销。</p><p class="muted">原始录像、原始弹幕和剪辑选段保留。</p>
          <p v-if="jobPreviewLoading&&!jobDeleteRecordOnly" class="job-delete-loading" role="status"><LoaderCircle class="spin" :size="16"/>正在核对导出文件…</p>
          <template v-if="jobDeletePreview&&!jobDeleteRecordOnly"><ul v-if="jobDeletePreview.files.length" class="job-delete-files" aria-label="将删除的导出文件"><li v-for="file in jobDeletePreview.files" :key="file.path"><code>{{ file.path }}</code><span>{{ file.exists===false?'文件已不存在，仅清理对应记录':Number.isFinite(file.size)?formatBytes(file.size):'将永久删除' }}</span></li></ul><p v-else-if="!jobDeletePreview.blocked" class="muted">该任务没有已记录的输出文件，仅移除任务记录。</p></template>
          <p v-if="jobDeleteError" class="inline-warning" role="alert">{{ jobDeleteError }}</p>
          <p v-if="jobDeletePreview?.preserved?.length&&!jobDeleteRecordOnly" class="muted">同路径下属于其他任务的文件会保留，仅清理这个失败或取消的任务。</p>
          <p v-if="jobDeleteBlock&&!jobPreviewLoading" class="inline-warning">{{ jobDeleteBlock }}</p>
          <button v-if="!jobDeleteRecordOnly&&!jobPreviewLoading&&!modalBusy&&(!jobDeletePreview||jobDeletePreview.blocked)" class="button small" @click="loadJobDeletePreview()">重新核对文件</button>
        </template>
        <template v-else-if="modal==='delete-session'"><p>确认删除「{{ confirmTarget.title }}」？</p><p class="confirm-meta">{{ date(confirmTarget.created) }} · {{ format(confirmTarget.duration) }}</p><p>将永久删除程序为这份素材保存的原视频、弹幕、剪辑记录和缓存，释放磁盘空间。删除后无法恢复。</p><p class="muted">已导出的成片保留。</p><p v-if="materialDeleteError" class="inline-warning" role="alert">{{ materialDeleteError }}</p><p v-if="deleteBlock" class="inline-warning">{{ deleteBlock }}</p></template>
        <div class="confirm-actions"><button class="button" :class="{'job-delete-cancel':modal==='delete-job'}" :disabled="modalBusy" @click="closeModal">取消</button><button class="button danger" :disabled="modalBusy||!!(modal==='delete-job'?jobDeleteBlock:deleteBlock)" @click="modal==='delete-job'?confirmJobRemoval():confirmRemoval()"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>{{ modal==='delete-job'&&jobDeleteRecordOnly?'确认移除记录':modal==='remove-room'?'确认移除':'确认永久删除' }}</button></div>
      </template>
      <template v-else-if="modal==='choose-room'"><h2><Radio :size="22"/>选择主播</h2>
        <p v-if="roomChoice.candidates.length>1">找到同号房间，请选择主播。</p><p v-else>请确认要添加的主播。</p>
        <p v-if="roomChoice.unavailable?.length" class="inline-warning">{{ roomChoice.unavailable.map(platform=>platform==='bilibili'?'B站':'抖音').join('、') }}暂时无法查询，可重试或使用完整链接。</p>
        <div class="room-choice-options" role="radiogroup" aria-label="选择直播间"><label v-for="room in roomChoice.candidates" :key="room.platform" class="room-choice-option" :class="{chosen:roomChoicePlatform===room.platform}"><input v-model="roomChoicePlatform" type="radio" name="room-platform" :value="room.platform" :disabled="modalBusy" :aria-label="(room.platform==='bilibili'?'B站':'抖音')+' · '+room.name"/><span><strong>{{ room.name }}</strong><small>{{ room.platform==='bilibili'?'B站':'抖音' }} · {{ room.roomNumber }} · {{ room.streaming?'直播中':'未开播' }}</small><small v-if="room.title" class="room-choice-title" :title="room.title">{{ room.title }}</small></span></label></div>
        <p v-if="roomChoiceError" class="inline-warning" role="alert">{{ roomChoiceError }}</p>
        <div class="confirm-actions"><button class="button" :disabled="modalBusy" @click="closeModal">取消</button><button class="button primary" :disabled="modalBusy||!roomChoicePlatform" @click="confirmRoomChoice"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>确认添加</button></div>
      </template>
      <template v-else-if="modal==='settings'"><h2><Settings :size="23"/>设置</h2>
        <section class="chat-settings" aria-label="弹幕设置"><div class="chat-rate-heading"><label for="chat-rate-limit">每秒弹幕上限</label><output for="chat-rate-limit">{{ chatRateValue }} 条</output></div><input id="chat-rate-limit" type="range" min="1" max="50" step="1" :value="chatRateValue" :style="{'--chat-rate-fill':(chatRateValue-1)/49*100+'%'}" :disabled="chatRateBusy||modalBusy" @input="chatRateDraft=Number($event.target.value)" @change="setChatRate($event.target.value)"/><p class="muted">每个直播间独立计算 · 自动保存</p><p class="muted">30 字及以上过滤；10 秒内同文达到 5 条，只留一条。</p><p v-if="chatRateError" class="inline-warning" role="alert">{{ chatRateError }}</p></section>
        <fieldset v-if="isDesktop" class="export-versions" aria-label="关闭窗口时"><legend>关闭窗口时</legend><label v-for="choice in [{value:'ask',label:'每次询问'},{value:'exit',label:'退出'},{value:'background',label:'后台运行'}]" :key="choice.value" class="checkbox"><input type="radio" name="close-action" :value="choice.value" :checked="(closeActionDraft??state.closeAction??'ask')===choice.value" :disabled="closeActionBusy||modalBusy" @change="setCloseAction(choice.value)"/>{{ choice.label }}</label><p v-if="closeActionError" class="inline-warning" role="alert">{{ closeActionError }}</p></fieldset>
        <section class="preparation-settings" aria-label="自动预处理设置"><label class="checkbox"><input type="checkbox" :checked="preparationEnabledDraft??preparationEnabled" :disabled="preparationSettingsBusy||modalBusy" @change="setPreparationEnabled($event.target.checked)"/>录制完成后自动预处理<LoaderCircle v-if="preparationSettingsBusy" class="spin" :size="14"/></label><p class="muted">提前处理弹幕视频，导出时复用结果。临时缓存会额外占用磁盘，预览和选段时继续，录制、导出和素材整理时暂缓。</p><p class="muted">仍可自由调整选段和弹幕，部分内容可能需要重新处理。预处理不会自动生成导出视频，需要时请手动导出。</p><p v-if="preparationSettingsError" class="inline-warning" role="alert">{{ preparationSettingsError }}</p></section>
        <div class="directory-settings"><label class="field-label">默认导出根目录<div class="path-picker"><input v-model="exportDirectory" aria-label="默认导出文件夹" placeholder="填写完整的文件夹路径" :disabled="modalBusy" @change="commitExportDirectory" @keydown.enter.prevent="commitExportDirectory"/><button v-if="isDesktop" type="button" class="button" :disabled="modalBusy" @click="browseFolder"><FolderOpen :size="16"/>选择</button></div></label><p class="muted">按北京时间分类：完整视频保存为「完整素材 / 日期 / 起止时间.mp4」；选段保存为「导出片段 / 日期 / 起止时间 / 视频.mp4」。修改路径或重新选择后自动保存。</p><div class="export-destinations"><span>完整素材</span><code>{{ categoryPath(exportDirectory,'完整素材') }}</code><span>导出片段</span><code>{{ categoryPath(exportDirectory,'导出片段') }}</code></div><div class="directory-actions"><button class="button" type="button" @click="openFolder({kind:'exports'})"><FolderOpen :size="16"/>打开文件目录</button></div></div>
        <div class="setting-info"><span>完整原始录像与弹幕</span><code>{{ state.paths?.originals }}</code><button class="text-button" @click="openFolder({kind:'originals'})">打开原始素材文件夹</button></div>
        <section v-if="pendingCleanup.length" class="cleanup-settings" aria-label="素材清理进度"><strong>素材清理进度（{{ pendingCleanup.length }}）</strong><p class="muted">清理在后台继续；占用释放后会自动重试，不影响操作其他素材。</p><div v-for="item in pendingCleanup" :key="item.id" class="cleanup-row"><div><strong>{{ item.title }}</strong><small>{{ date(item.created) }} · {{ format(item.duration) }}</small><p role="status">{{ cleanupLabel(item) }}</p><small v-if="item.task?.detail">{{ item.task.detail }}</small><p v-if="item.purge_error&&!item.task" class="cleanup-error">{{ item.purge_error }}</p></div><button class="button small danger" :disabled="modalBusy||!!item.task" @click="requestDelete(item)">{{ item.task?'清理中':'重试清理' }}</button></div></section>
      </template>
      <template v-else-if="modal==='retry-save'"><h2><FolderOpen :size="23"/>更换保存位置</h2><p class="export-target">{{ retrySaveTarget?.description }}</p><p>已完成编码，将已有的 MP4 保存到新位置，无需重新导出。保留原来的版本、日期和时间命名。</p><form @submit.prevent="retryJobSave(retrySaveJob,true)"><label class="field-label">本次保存根目录<div class="path-picker"><input v-model="retrySaveDirectory" class="retry-save-directory" aria-label="重试保存文件夹" placeholder="填写完整的文件夹路径" :disabled="modalBusy" required/><button v-if="isDesktop" type="button" class="button" :disabled="modalBusy" @click="browseRetryFolder"><FolderOpen :size="16"/>选择</button></div></label><div class="export-destinations"><span>保存到「{{ retrySaveCategory }}」</span><code>{{ categoryPath(retrySaveDirectory,retrySaveCategory) }}</code></div><p class="muted">只更改本次任务的保存位置，默认导出目录保持不变。</p><p v-if="retrySaveError" class="inline-warning" role="alert">{{ retrySaveError }}</p><p v-else-if="retrySaveBlock" class="inline-warning">{{ retrySaveBlock }}</p><div class="confirm-actions"><button type="button" class="button" :disabled="modalBusy" @click="closeModal">取消</button><button class="button primary" :disabled="modalBusy||!!retrySaveBlock||!retrySaveDirectory.trim()"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>保存到此位置</button></div></form></template>
      <template v-else><h2><Download :size="23"/>{{ modalTitle }}</h2><p class="export-target">{{ exportTarget?.title }}</p><p v-if="exportScope==='full'">将导出这份素材的完整录像，生成{{ versionDescription }}，总时长约 {{ format(exportDuration) }}。不会改动已添加的剪辑选段。</p><p v-else>已选择 {{ exportRanges.length }} 个选段，将创建 {{ exportRanges.length }} 个独立任务，按列表顺序逐个导出。每个选段生成{{ versionDescription }}，总时长约 {{ format(exportDuration) }}。整场录制与原始素材继续保留。</p><label class="field-label">本次导出根目录<div class="path-picker"><input v-model="exportDirectory" aria-label="本次导出文件夹" placeholder="填写完整的文件夹路径"/><button v-if="isDesktop" class="button" :disabled="modalBusy" @click="browseFolder"><FolderOpen :size="16"/>选择</button></div></label><div class="export-destinations"><span>本次保存到「{{ exportCategory }}」</span><code>{{ categoryPath(exportDirectory,exportCategory) }}</code></div><p v-if="exportScope==='full'" class="muted">按素材开始日期建立文件夹，视频直接保存在日期目录中，例如 20260928 / 202609282130-2140.mp4。完成后无需再下载。</p><p v-else class="muted">按素材日期和起止时间建立文件夹，例如 20260928 / 202609282130-2140 / 202609282130-2140.mp4。完成后无需再下载。</p><fieldset class="export-versions"><legend>导出版本</legend>
          <label class="export-mode" :class="{chosen:exportMode==='clean'}"><input v-model="exportMode" type="radio" name="export-mode" value="clean"/><span><strong>纯净版本</strong><small>只生成无弹幕的 MP4</small></span></label>
          <label class="export-mode" :class="{chosen:exportMode==='danmaku'}"><input v-model="exportMode" type="radio" name="export-mode" value="danmaku"/><span><strong>弹幕版本</strong><small>只生成已把弹幕叠进画面的 MP4</small></span></label>
          <label class="export-mode" :class="{chosen:exportMode==='dual'}"><input v-model="exportMode" type="radio" name="export-mode" value="dual"/><span><strong>纯净 + 弹幕双文件版本</strong><small>分别生成两个 MP4，默认选择</small></span></label>
        </fieldset><p class="muted">导出文件夹只保留所选版本的视频。<template v-if="exportScope==='full'">弹幕版沿用这份素材的弹幕排除设置。</template><template v-else>已排除的 {{ exportExcluded }} 条弹幕不会进入弹幕版。</template></p><p v-if="exportBlock" class="inline-warning">{{ exportBlock }}</p><button class="button primary wide" :disabled="modalBusy||saving||!!exportBlock" @click="exportClip"><LoaderCircle v-if="modalBusy" class="spin" :size="16"/>开始导出</button></template>
    </section></div>
  </div>
</template>
