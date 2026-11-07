import { ref, computed } from 'vue';
import { ui } from '../shared/ui-copy.js';
import { frameTimePosition, markPreviewPosition } from './video-time.js';
import { recordingTimeAt, positionAtRecordingInput, toRecordingInput, recordingTimeBounds } from './recording-time.js';

/** Keeps editable time strings separate from precise marker positions. */
export function useClipMarkers({
  selected, detail, activeSession, selectionReady, duration, canPreview,
  position, frameRateAt, formatPosition, playFrom, tell
}) {
  const positionMode=ref('video'),startDateText=ref(''),endDateText=ref('');
  const startText=ref(''),endText=ref(''),startExact=ref(null),endExact=ref(null);
  const startMarked=ref(false),endMarked=ref(false);
  const draftStart=computed(()=>markerTime('start',startMarked.value));
  const draftEnd=computed(()=>markerTime('end',endMarked.value));
  const draftDuration=computed(()=>draftStart.value!==null&&draftEnd.value!==null&&draftEnd.value>draftStart.value?draftEnd.value-draftStart.value:null);
  const clockBounds=computed(()=>recordingTimeBounds(activeSession.value,detail.value?.sources||[],duration.value));
  const canUseRecordingTime=computed(()=>selectionReady.value&&activeSession.value?.room>0&&!!clockBounds.value);
  const markerError=computed(()=>{for(const which of ['start','end']){if(!(which==='start'?startMarked.value:endMarked.value))continue;try{readMark(which);}catch(e){return (which==='start'?ui.workbench.起点:ui.workbench.终点)+e.message;}}return '';});

  function parse(text){
    const fields=text.split(':');
    if(fields.length===4&&fields.every(field=>/^\d+$/.test(field))){
      const [hours,minutes,seconds,frame]=fields.map(Number),second=hours*3600+minutes*60+seconds;
      const time=frameTimePosition(second,frame,frameRateAt(second));
      if(minutes<60&&seconds<60&&Number.isFinite(time))return time;
    }
    const values=fields.map(Number);
    if(fields.length<=3&&fields.every(field=>field.trim())&&values.every(value=>Number.isFinite(value)&&value>=0)){
      const time=values.reduce((a,b)=>a*60+b,0);if(Number.isFinite(time))return time;
    }
    throw new Error(ui.workbench.视频时间格式错误);
  }
  function readMark(which){
    if(!selectionReady.value)throw new Error(ui.workbench.请等待素材加载完成);
    if(!(which==='start'?startMarked.value:endMarked.value))throw new Error(ui.workbench.请填写视频时间);
    if(positionMode.value==='recording')return positionAtRecordingInput(which==='start'?startDateText.value:endDateText.value,activeSession.value,detail.value?.sources||[],duration.value,which==='start'?startExact.value:endExact.value);
    const t=videoMark(which);if(t>duration.value+.000001)throw new Error(ui.workbench.超出已录制范围);return Math.min(t,duration.value);
  }
  function videoMark(which){
    const text=(which==='start'?startText.value:endText.value).trim();
    if(!text)throw new Error(ui.workbench.请填写视频时间);
    const exact=which==='start'?startExact.value:endExact.value;
    return Number.isFinite(exact)?exact:parse(text);
  }
  function markerTime(which,marked){if(!marked||!selected.value)return null;try{return readMark(which);}catch{return null;}}
  function inputMark(which,text){
    const marked=!!text.trim(),recording=positionMode.value==='recording';
    if(which==='start'){startMarked.value=marked;startExact.value=null;(recording?startDateText:startText).value=text;}
    else{endMarked.value=marked;endExact.value=null;(recording?endDateText:endText).value=text;}
  }
  function markText(which,t){
    const stamp=recordingTimeAt(t,activeSession.value,detail.value?.sources||[]),dateText=Number.isFinite(stamp)?toRecordingInput(stamp,false):'';
    if(which==='start'){startMarked.value=true;startExact.value=t;startText.value=formatPosition(t);startDateText.value=dateText;}
    else{endMarked.value=true;endExact.value=t;endText.value=formatPosition(t);endDateText.value=dateText;}
  }
  function setPositionMode(mode){
    if(mode===positionMode.value||!selected.value||mode==='recording'&&!canUseRecordingTime.value)return;
    for(const which of ['start','end']){
      if(!(which==='start'?startMarked.value:endMarked.value))continue;
      try{markText(which,readMark(which));}catch{}
    }
    positionMode.value=mode;
  }
  function commitMark(which){
    if(!(which==='start'?startMarked.value:endMarked.value))return;
    try{const t=readMark(which);markText(which,t);void playFrom(markPreviewPosition(t,detail.value?.sources||[]),false);}catch(e){tell(e.message);}
  }
  function setMark(which){if(canPreview.value)markText(which,position.value);}
  function dragMark(which,time){markText(which,time);}
  function previewMark(time){void playFrom(markPreviewPosition(time,detail.value?.sources||[]),false);}
  function clearDraftMarks(){
    startMarked.value=false;endMarked.value=false;startExact.value=null;endExact.value=null;
    startText.value='';endText.value='';startDateText.value='';endDateText.value='';
  }
  return {
    positionMode, startText, endText, startDateText, endDateText, startMarked, endMarked,
    draftStart, draftEnd, draftDuration, clockBounds, canUseRecordingTime, markerError,
    readMark, inputMark, setPositionMode, commitMark, setMark, dragMark, previewMark, clearDraftMarks
  };
}
