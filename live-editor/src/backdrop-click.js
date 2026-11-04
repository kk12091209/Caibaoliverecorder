// A browser can retarget a click to the backdrop after a drag starts in a dialog.
// Dismiss only a primary click that starts and ends on that same backdrop.
export function createBackdropClickGuard(){
  let gesture=null;
  function reset(){gesture=null;}
  function pointerDown(event){
    reset();
    if(event.button!==0||event.isPrimary===false||!event.currentTarget||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
    gesture={pointerId:event.pointerId,backdrop:event.currentTarget,x:event.clientX,y:event.clientY,
      startedOutside:event.target===event.currentTarget,endedOutside:false,released:false,dragged:false};
  }
  function pointerMove(event){
    if(!gesture||gesture.released||event.pointerId!==gesture.pointerId)return;
    if(!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY)||Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>6)gesture.dragged=true;
  }
  function pointerUp(event){
    if(!gesture||event.pointerId!==gesture.pointerId)return;
    pointerMove(event);
    gesture.released=true;
    gesture.endedOutside=event.button===0&&event.target===gesture.backdrop&&event.currentTarget===gesture.backdrop;
  }
  function click(event){
    const ended=gesture;reset();
    return !!ended&&ended.startedOutside&&ended.endedOutside&&ended.released&&!ended.dragged
      &&event.target===ended.backdrop&&event.currentTarget===ended.backdrop
      &&event.button===0&&event.detail!==0
      &&(event.pointerId===undefined||event.pointerId===ended.pointerId);
  }
  return {pointerDown,pointerMove,pointerUp,click,reset};
}
