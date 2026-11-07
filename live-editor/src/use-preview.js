import { ref, computed, nextTick } from 'vue';
import { ui } from '../shared/ui-copy.js';
import { latestPreviewPosition } from './video-time.js';
import { previewStream } from './preview-stream.js';

/** Owns playback, transport invalidation and audio for one workbench window. */
export function usePreview({
  selected, detail, duration, canPreview, fps, tell, loadOverlay
}) {
  const video=ref(null),previewUrl=ref(''),position=ref(0),previewBase=ref(0),isPlaying=ref(false),loading=ref(false),previewEnded=ref(false),scrubbing=ref(false);
  let previewTransport;
  const previewClient=crypto.randomUUID();
  const previewVolume=ref(1),previewMuted=ref(false);
  try{const saved=JSON.parse(localStorage.getItem('preview-audio')||'null');if(saved&&Number.isFinite(saved.volume))previewVolume.value=Math.min(1,Math.max(0,saved.volume));if(saved&&typeof saved.muted==='boolean')previewMuted.value=saved.muted;}catch{}
  let previewVolumeHold=previewVolume.value>0?previewVolume.value:1;
  const previewSlider=computed(()=>previewMuted.value?0:previewVolume.value);
  let generation=0;

  function containsTime(ranges,time){for(let i=0;i<ranges.length;i++)if(time>=ranges.start(i)&&time<ranges.end(i)-.05)return true;return false;}
  async function playFrom(time,play=true,{allowTail=false}={}){
    if(!canPreview.value)return;
    const available=detail.value?.sources||[];let target=Math.max(0,Math.min(time,Math.max(0,duration.value-(allowTail?0:.1))));
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
  function disposePreview(){previewTransport?.dispose();}
  function invalidatePreview(){generation++;}
  function releasePagePreview(){disposePreview();invalidatePreview();pausePreview();loading.value=false;previewEnded.value=true;}
  async function togglePlay(){if(isPlaying.value){pausePreview();return;}if(!previewUrl.value||previewEnded.value){await playFrom(position.value,true);return;}const version=generation;isPlaying.value=true;await video.value.play().catch(e=>{if(version===generation&&e.name!=='AbortError'){isPlaying.value=false;tell(ui.workbench.暂时无法播放请重新定位后重试);}});}
  function played(){isPlaying.value=!!video.value&&!video.value.paused;}
  function loaded(){loading.value=false;applyPreviewAudio();if(!isPlaying.value)video.value?.pause();}
  function paused(){if(video.value?.paused&&!loading.value&&!video.value.ended)isPlaying.value=false;}
  function updateTime(){if(video.value&&!scrubbing.value)position.value=Math.min(duration.value,previewBase.value+video.value.currentTime);}
  function step(direction){pausePreview();void playFrom(position.value+direction/fps.value,false,{allowTail:true});}
  function returnToLatest(){
    const target=latestPreviewPosition(detail.value?.sources||[],duration.value);
    if(target!==null)void playFrom(target,true,{allowTail:true});
  }
  function playNext(){const available=detail.value?.sources||[];const same=available.find(s=>s.start<=position.value&&s.start+s.duration>position.value+.15);if(same){void playFrom(position.value+1/fps.value,true);return;}const next=available.find(s=>s.start>previewBase.value+.1&&s.start>=position.value-.3&&s.duration>0);if(next)void playFrom(next.start,true);}
  function ended(){previewEnded.value=true;loading.value=false;if(isPlaying.value)playNext();}
  return {
    video, previewUrl, position, previewBase, isPlaying, loading, previewEnded, scrubbing,
    previewVolume, previewMuted, previewSlider, previewVolumeOpen, setPreviewVolume, togglePreviewMute,
    openPreviewVolume, leavePreviewVolume, previewVolumeDown, previewVolumeUp,
    playFrom, playNext, pausePreview, togglePlay, played, loaded, paused, updateTime, step, returnToLatest, ended,
    disposePreview, invalidatePreview, releasePagePreview
  };
}
