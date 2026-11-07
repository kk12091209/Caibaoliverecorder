import { ref, shallowRef, computed, watch, nextTick } from 'vue';
import { api } from './api.js';
import { messageTime, messageWindow } from '../shared/message-navigation.js';

/** Owns paginated messages, search and follow/drag request lifetimes. */
export function useMessageBrowser({
  selected, selectionReady, selectionVersion, duration, position, scrubbing,
  danmakuVisible, messageMenu, modal, modalBusy, senderFilter, lotteryTarget, lotteryEditing,
  refreshLotteryDetail, tell, visibleMessages
}) {
  const query=ref(''),messages=shallowRef([]),giftRows=shallowRef([]),lotteryRows=shallowRef([]);
  const showGiftList=ref(false),followMessages=ref(true),messageList=ref(null);
  let queryTimer,messageRequest=0,dmBusy=false,lastMessageKey='';
  const messagePage=ref({hasBefore:false,hasAfter:false}),messageLoading=ref(false),messageFollowPaused=ref(false);
  const feedKey=row=>`${row.type==='d'?'d':row.type==='lottery'?'l':'g'}:${row.id}`;
  const messageWindowAnchor=ref(0),messageBrowseTime=ref(0),messageNavigationPinned=ref(false);
  const searchKeyword=computed(()=>query.value.trim());
  const searching=computed(()=>!!searchKeyword.value);
  const searchPattern=computed(()=>{
    const keyword=searchKeyword.value.slice(0,200);
    return keyword?new RegExp('('+keyword.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'):null;
  });
  const followMessageList=computed(()=>followMessages.value&&!searching.value);
  const activeSenderFilter=computed(()=>searching.value||showGiftList.value?null:senderFilter.value);
  const messageRange=computed(()=>messageWindow(duration.value,messageFollowPaused.value?messageWindowAnchor.value:position.value,followMessageList.value));

  let automaticMessageRequest=false;
  function pauseMessageFollow(){if(followMessageList.value&&!messageFollowPaused.value){messageWindowAnchor.value=position.value;messageFollowPaused.value=true;}if(automaticMessageRequest&&dmBusy){messageRequest++;dmBusy=false;messageLoading.value=false;}}
  // Keep the user's rail target through async loading and virtual-row measurement.
  // Only an explicit list gesture or resuming follow can hand control back.
  function startMessageNavigation(){messageNavigationPinned.value=true;pauseMessageFollow();}
  function manualMessageScroll(){stopMessageDrag();messageNavigationPinned.value=false;pauseMessageFollow();}
  function syncMessageBrowseTime(time){
    if(!messageNavigationPinned.value&&(!followMessageList.value||messageFollowPaused.value))messageBrowseTime.value=time;
  }
  function jumpMessages(time){stopMessageDrag();startMessageNavigation();const target=messageTime(time,duration.value);messageBrowseTime.value=target;void loadMessages(true,undefined,target);}
  function resumeMessageFollow(){stopMessageDrag();messageNavigationPinned.value=false;messageFollowPaused.value=false;void loadMessages(true);}
  let messageDragFrame=0,messageDragRequest=null;
  function stopMessageDrag(){
    cancelAnimationFrame(messageDragFrame);messageDragFrame=0;
    messageDragRequest?.abort();messageDragRequest=null;
  }
  function previewMessageNavigation(time){
    if(!selectionReady.value||!danmakuVisible.value||document.hidden)return;
    const target=messageTime(time,duration.value);messageBrowseTime.value=target;
    const rows=visibleMessages.value;
    if(rows[0]?.time<=target&&target<=rows.at(-1)?.time){
      stopMessageDrag();messageList.value?.scrollToTime(target,true);return;
    }
    if(messageDragFrame||messageDragRequest)return;
    // Reuse cached rows and keep one page request in flight while dragging.
    messageDragFrame=requestAnimationFrame(async()=>{
      messageDragFrame=0;
      const controller=new AbortController();
      const requested=messageBrowseTime.value;
      messageDragRequest=controller;
      try{await loadMessages(true,undefined,requested,controller.signal);}
      finally{
        if(messageDragRequest===controller){
          messageDragRequest=null;
          if(messageBrowseTime.value!==requested)previewMessageNavigation(messageBrowseTime.value);
        }
      }
    });
  }
  function shouldFollowPlayback(){
    return followMessageList.value&&!messageFollowPaused.value&&!messageMenu.value&&!modal.value&&danmakuVisible.value;
  }
  function assignFeed(rows){messages.value=rows.filter(row=>row.type==='d');giftRows.value=rows.filter(row=>row.type!=='d'&&row.type!=='lottery');lotteryRows.value=rows.filter(row=>row.type==='lottery');}
  async function loadMessages(force=false,direction,at,dragSignal){
    if(!selectionReady.value||!danmakuVisible.value||document.hidden)return;
    if(dmBusy){if(!force)return;messageRequest++;dmBusy=false;}
    const scope={...messageRange.value},target=at!==undefined?Math.max(scope.from,Math.min(scope.to,at)):followMessageList.value?messageTime(position.value,duration.value):undefined;
    if(!force&&!direction&&(queryTimer||scrubbing.value||messageFollowPaused.value||messageMenu.value||modal.value))return;
    const id=selected.value,version=selectionVersion();
    const mode=searching.value?'search':showGiftList.value?'gifts':'chat';
    const key=JSON.stringify([id,followMessageList.value?Math.floor(position.value/5):'all',searchKeyword.value,mode,activeSenderFilter.value]);
    if(!force&&!direction&&key===lastMessageKey)return;
    const request=++messageRequest;dmBusy=true;messageLoading.value=true;automaticMessageRequest=!force&&!direction;
    const anchor=messageList.value?.capture(),current=()=>!dragSignal?.aborted&&request===messageRequest&&version===selectionVersion()&&id===selected.value;
    try{
      const params=new URLSearchParams({q:searchKeyword.value,gifts:mode==='chat'?'0':'1',onlyGifts:mode==='gifts'?'1':'0',from:String(scope.from),to:String(scope.to)});
      if(activeSenderFilter.value)params.set('sender',JSON.stringify(activeSenderFilter.value));
      if(direction){const row=direction==='before'?visibleMessages.value[0]:visibleMessages.value.at(-1);if(row)params.set('cursor',JSON.stringify({time:row.time,key:feedKey(row)}));params.set('direction',direction);}
      else if(target!==undefined)params.set('at',String(target));
      const result=await api(`sessions/${id}/feed?${params}`,undefined,{signal:dragSignal});if(!current())return;
      let rows=result.rows;
      if(!dragSignal&&!direction&&followMessageList.value){
        // Follow mode queries only the current +/- 60 second window.
        // Dense windows stay paginated; no chat timestamp sets media duration.
        while(result.hasBefore&&rows.length<2400&&rows[0]?.time>scope.from){
          params.delete('at');params.set('direction','before');params.set('cursor',JSON.stringify(result.before));
          const previous=await api(`sessions/${id}/feed?${params}`);if(!current())return;
          rows=[...previous.rows,...rows];result.before=previous.before;result.hasBefore=previous.hasBefore;if(!previous.rows.length)break;
        }
      }
      if(!dragSignal&&!direction&&followMessageList.value){
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
      if(at!==undefined){messageList.value?.scrollToTime(target,!!dragSignal);}else if(direction||messageFollowPaused.value)await messageList.value?.restore(anchor);else if(followMessageList.value)followMessagePosition();else messageList.value?.reset();
      const lottery=lotteryTarget.value,summary=lottery&&lotteryRows.value.find(x=>x.id===lottery.record.id);
      if(modal.value==='lottery'&&!lotteryEditing.value&&!modalBusy.value&&summary&&(summary.state!==lottery.record.state||summary.winnerCount!==lottery.record.winnerCount||summary.revision!==lottery.record.revision))void refreshLotteryDetail();
    }catch(e){if(current())tell(e.message);}finally{if(request===messageRequest){dmBusy=false;messageLoading.value=false;}}
  }
  function loadMessagePage(direction){pauseMessageFollow();return loadMessages(false,direction);}
  function followMessagePosition(){
    if(scrubbing.value||!shouldFollowPlayback())return;
    messageBrowseTime.value=position.value;messageList.value?.scrollToTime(position.value);
  }
  watch([position,followMessageList,danmakuVisible],followMessagePosition,{flush:'post'});
  watch(danmakuVisible,value=>{if(value)void loadMessages(true);});
  watch(selected,()=>{messageFollowPaused.value=false;messageWindowAnchor.value=0;messageBrowseTime.value=0;messageNavigationPinned.value=false;messagePage.value={hasBefore:false,hasAfter:false};});
  function searchChanged(){
    stopMessageDrag();
    messageNavigationPinned.value=false;
    messageBrowseTime.value=followMessageList.value?position.value:0;
    lastMessageKey='';
    messageFollowPaused.value=false;
    messageRequest++;
    dmBusy=false;
    assignFeed([]);
    messagePage.value={hasBefore:false,hasAfter:false};
    messageLoading.value=selectionReady.value;
    clearTimeout(queryTimer);
    queryTimer=setTimeout(()=>{queryTimer=null;void loadMessages(true);},250);
  }
  function changeGiftList(enabled){
    if(searching.value||showGiftList.value===enabled)return;
    showGiftList.value=enabled;
    searchChanged();
  }
  function clearMessageSearch(){
    query.value='';
    searchChanged();
    document.getElementById('message-search')?.focus();
  }

  function resetMessageKey(){lastMessageKey='';}
  function invalidateFeed(){stopMessageDrag();messageRequest++;dmBusy=false;resetMessageKey();}
  function cancelPendingFollow(){
    if(shouldFollowPlayback()&&dmBusy){messageRequest++;dmBusy=false;messageLoading.value=false;}
  }
  function finishMessageScrub(){
    if(shouldFollowPlayback()){
      messageBrowseTime.value=position.value;
      void loadMessages(true,undefined,position.value);
    }
  }
  function closeMessageBrowser(){clearTimeout(queryTimer);}
  return {
    query, messages, giftRows, lotteryRows, showGiftList, followMessages, messageList, feedKey,
    messagePage, messageLoading, messageFollowPaused, messageBrowseTime, messageRange,
    searchKeyword, searching, searchPattern, followMessageList, activeSenderFilter,
    pauseMessageFollow, manualMessageScroll, syncMessageBrowseTime, jumpMessages, resumeMessageFollow,
    startMessageNavigation, previewMessageNavigation, stopMessageDrag, shouldFollowPlayback,
    loadMessages, loadMessagePage, searchChanged, changeGiftList, clearMessageSearch,
    resetMessageKey, invalidateFeed, cancelPendingFollow, finishMessageScrub, closeMessageBrowser
  };
}
