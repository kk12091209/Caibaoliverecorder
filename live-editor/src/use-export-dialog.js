import { ref, computed } from 'vue';
import { ui } from '../shared/ui-copy.js';
import { api } from './api.js';
import { pickExportFolder } from './desktop.js';

/** Prepares an export request and manages the directory shared with Settings. */
export function useExportDialog({
  state, selected, selectedRanges, activeSession, edit, modal, modalBusy, tell, refresh, closeContext
}) {
  const exportMode=ref('dual'),exportGifts=ref(false);
  const exportDirectory=ref(''),savedExportDirectory=ref('');
  const exportScope=ref('clips'),exportTarget=ref(null),exportRanges=ref([]),exportExcluded=ref(0);
  const versionDescription=computed(()=>({clean:ui.workbench.选项一个纯净版MP4,danmaku:ui.workbench.选项一个弹幕版MP4,dual:ui.workbench.纯净版和弹幕版两个MP4})[exportMode.value]);
  const exportSession=computed(()=>state.value.sessions.find(s=>s.id===exportTarget.value?.id));
  const exportCategory=computed(()=>exportScope.value==='full'?'完整素材':'导出片段');
  const exportDuration=computed(()=>exportScope.value==='full'?(exportSession.value?.duration||0):exportRanges.value.reduce((total,r)=>total+r.end-r.start,0));
  const exportBlock=computed(()=>{
    if(!exportSession.value)return ui.workbench.素材已被删除无法导出;
    if(exportScope.value==='full')return fullExportBlock(exportSession.value);
    return exportRanges.value.length?'':ui.workbench.请先勾选至少一个选段;
  });

  function fullExportBlock(session){return session.status!=='finished'?ui.workbench.录制或整理完成后才能导出完整素材:!(session.duration>0)?ui.workbench.这份素材暂时没有可导出的画面:'';}
  function openExport(){if(!selected.value||!selectedRanges.value.length){tell(ui.workbench.请先勾选至少一个选段);return;}exportScope.value='clips';exportTarget.value={id:selected.value,title:activeSession.value?.title};exportRanges.value=selectedRanges.value.map(r=>({start:r.start,end:r.end}));exportExcluded.value=edit.value.excluded.length;exportMode.value='dual';exportGifts.value=state.value.giftStyle?.export===true;exportDirectory.value=state.value.paths?.exports||'';modal.value='export';}
  function openFullExport(session){const latest=state.value.sessions.find(s=>s.id===session.id),blocked=latest?fullExportBlock(latest):ui.workbench.素材已被删除;if(blocked){tell(blocked);return;}closeContext();exportScope.value='full';exportTarget.value={id:latest.id,title:latest.title};exportRanges.value=[];exportExcluded.value=0;exportMode.value='dual';exportGifts.value=state.value.giftStyle?.export===true;exportDirectory.value=state.value.paths?.exports||'';modal.value='export';}
  async function browseFolder(){try{const value=await pickExportFolder(exportDirectory.value);if(!value)return;exportDirectory.value=value;if(modal.value==='settings')await commitExportDirectory();}catch(e){tell(e.message);}}
  async function commitExportDirectory(){if(modal.value!=='settings'||modalBusy.value)return;const value=exportDirectory.value.trim();if(!value){if(exportDirectory.value!==savedExportDirectory.value)tell(ui.workbench.请填写导出文件夹的完整路径);return;}if(value===savedExportDirectory.value)return;modalBusy.value=true;try{const result=await api('settings',{exportDirectory:value});const saved=result.paths?.exports||value;savedExportDirectory.value=saved;exportDirectory.value=saved;await refresh();tell(ui.workbench.默认导出文件夹已保存,'success');}catch(e){tell(e.message);}finally{modalBusy.value=false;}}
  async function openFolder(input){try{await api('folders/open',input);}catch(e){tell(e.message);}}
  async function exportClip(){if(modalBusy.value)return;if(exportBlock.value){tell(exportBlock.value);return;}modalBusy.value=true;const target=exportTarget.value.id,scope=exportScope.value;try{const result=await api(`sessions/${target}/export`,{scope,mode:exportMode.value,giftsEnabled:exportMode.value!=='clean'&&exportGifts.value,...(scope==='clips'?{ranges:exportRanges.value}:{}),exportDirectory:exportDirectory.value});modal.value='';tell(scope==='full'?ui.workbench.完整素材已加入导出队列:ui.workbench.导出任务已创建(result.jobs?.length??1),'success');await refresh();}catch(e){tell(e.message);}finally{modalBusy.value=false;}}
  return {
    exportMode, exportGifts, exportDirectory, savedExportDirectory, exportScope, exportTarget,
    exportRanges, exportExcluded, versionDescription, exportCategory, exportDuration, exportBlock,
    fullExportBlock, openExport, openFullExport, browseFolder, commitExportDirectory, openFolder, exportClip
  };
}
