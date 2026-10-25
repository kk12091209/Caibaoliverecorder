import {cameraGeometry,cameraLayoutAt} from '../shared/recording-style.js';
import {containedVideoFrame} from '../shared/video-geometry.js';

export function drawRecordingLayout(ctx,video,events,time,style,width,height) {
  ctx.clearRect(0,0,width,height);
  const g=cameraGeometry(cameraLayoutAt(events,time),style,video.videoWidth,video.videoHeight);
  if(!g)return false;
  const {scale,left,top}=containedVideoFrame(width,height,video.videoWidth,video.videoHeight);
  ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
  for(const [source,target]of [[g.main,g.mainTarget],[g.camera,g.cameraTarget]])
    ctx.drawImage(video,source.x,source.y,source.w,source.h,left+target.x*scale,top+target.y*scale,target.w*scale,target.h*scale);
  return true;
}
