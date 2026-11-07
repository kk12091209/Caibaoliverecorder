import { ui } from '../shared/ui-copy.js';
import {roomAvailable} from './room-status.js';
import {platformLabel} from '../shared/platforms.js';

// Presentation only: consume the existing snapshots without probing services.
export function recorderStatusDetails(recorder={},rooms=[],connected=true,anchors=[]){
  const copy=ui.recorderStatus;
  const displayed=[...rooms];
  // Inactive followed users can remain in anchors after their capture room closes.
  for(const anchor of anchors){
    const platform=anchor.platform||'bilibili';
    const roomId=platform!=='bilibili'?platform+':'+(anchor.webRid||anchor.ownWebRid||''):anchor.roomId;
    if(displayed.some(room=>(room.platform||'bilibili')===platform&&String(room.roomId)===String(roomId)))continue;
    displayed.push({...anchor,platform,roomId:roomId===platform+':'?anchor.key:roomId,recording:!!anchor.recording});
  }
  const platforms=['bilibili','douyin'];
  if('xiaohongshuOnline' in recorder||displayed.some(room=>room.platform==='xiaohongshu'))platforms.push('xiaohongshu');
  return platforms.map(platform=>{
    const available=connected&&roomAvailable({platform},recorder);
    const platformRooms=displayed.filter(room=>(room.platform||'bilibili')===platform);
    return {
      platform,label:platformLabel(platform),
      status:available?copy.就绪:copy.未连接,failed:!available,
      error:!connected?copy.状态更新中:platform==='bilibili'?recorder.error||'':'',
      idle:platformRooms.length?'':copy.待机未添加直播间,
      // Once a service is unreachable, its old per-room snapshot is not evidence
      // of current recording or socket health. Keep the service failure visible.
      rooms:available?platformRooms.map(room=>{
        let chat=copy.连接状态待确认,chatFailed=false;
        const connection=platform==='bilibili'
          ?room.danmakuConnected===true?'connected':room.danmakuConnected===false?'disconnected':undefined
          :room.chatStatus?.connection;
        // The same display rules apply to both platforms. No capture task is
        // idle, not a connection failure; preserve a confirmed background socket.
        if(connection==='connected')chat=copy.已连接;
        else if(!room.recording)chat=copy.等待启动;
        else if(['disconnected','retrying','stopped'].includes(connection)){chat=copy.未连接;chatFailed=true;}
        const videoFailed=!!room.error;
        return {
          id:room.roomId,name:room.name||String(room.roomId),
          video:videoFailed?copy.保存失败:room.recording?ui.common.录制中:copy.未采集,
          videoFailed,videoHint:room.error||'',chat,chatFailed,
          chatHint:room.chatError||(room.chatStatus?.writeFailed?copy.保存失败:'')
        };
      }):[]
    };
  });
}
