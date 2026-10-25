import { validRect, labelText } from '../shared/linkmic-labels.js';
import { BILI_LAYOUTS, BILI_LAYOUT_VERSION } from './bilibili-layouts.js';
import { biliCameraLayout, douyinCameraLayout } from './recording-layout.js';

const MAX_SEI=128*1024;
const identifier=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value)?value:
  Number.isSafeInteger(value)&&value>0?String(value):'';
export function parsePlatformJson(text) {
  // Platform IDs are often uint64. Never round them into another person's ID.
  return JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)?context.source:value);
}
function biliFrame(value) {
  const data=value?.LIVE_MULTI_VIDEO_LINK;
  if(!data)return null;
  const template=data.interact_template;
  if([0,2].includes(data.sei_room_status)||[0,2].includes(data.session_status)||template?.show_interact_ui===false)return {platform:'bilibili',participants:[]};
  const layoutId=data.layout_id||template?.layout_id;
  // Current SEI commonly sends only a layout ID, and cells inherit dimensions
  // from default_cell. Unknown future versions need explicit inline geometry.
  const inline=template?.layout_data;
  const layout=inline?.width>0&&inline?.height>0?inline:((template?.layout_version===undefined||template.layout_version===BILI_LAYOUT_VERSION)?BILI_LAYOUTS.find(l=>l.layout_id===layoutId):null);
  if(!layout||!Number.isFinite(layout.width)||!Number.isFinite(layout.height)||layout.width<=0||layout.height<=0||
    !Array.isArray(layout.cells)||layout.cells.length>64||!Array.isArray(data.members)||data.members.length>64)return null;
  const participants=[];
  for(const member of data.members) {
    const cells=layout.cells.filter(cell=>cell.position===member.position);
    if(cells.length!==1)continue;
    if(data.members.filter(other=>other.position===member.position).length!==1)continue;
    const cell={...layout.default_cell,...cells[0]},rect={x:cell.x/layout.width,y:cell.y/layout.height,w:cell.width/layout.width,h:cell.height/layout.height};
    const id=identifier(member.uid_str)||identifier(member.uid);
    if(!validRect(rect)||!id)continue;
    participants.push({...rect,id,name:labelText(member.uname)||labelText(member.display_name)});
  }
  return {platform:'bilibili',participants};
}
function audienceFrame(app) {
  const channel=identifier(app.channel_id),canvas=app.canvas;
  if(!channel)return null;
  const empty={platform:'douyin',channel,version:15,participants:[]};
  // Verified audience floating-seat protocol (ui_layout 7), not PK grids.
  // Its own webpage uses 23.9% right column, 3.4% right padding,
  // 14.9% bottom padding (relative to width), and 13% seats bottom-up.
  if(app.ui_layout!==7||app.interactive_scene!==8||app.hide_micseat===1||
    !canvas||!Number.isFinite(canvas.width)||!Number.isFinite(canvas.height)||
    canvas.width<=0||canvas.height<=0||canvas.width/canvas.height>1||
    !Array.isArray(app.grids)||app.grids.length>7)return empty;
  const bottom=.149*canvas.width/canvas.height,height=.13*(1-bottom),participants=[];
  for(const grid of app.grids) {
    const linkId=identifier(grid?.uid_str)||identifier(grid?.uid),seat=grid?.p;
    if(!linkId||!Number.isInteger(seat)||seat< -1||seat>5||grid.visible===0||
      app.grids.filter(other=>other?.p===seat).length!==1||
      app.grids.filter(other=>(identifier(other?.uid_str)||identifier(other?.uid))===linkId).length!==1)continue;
    const rect=seat===-1?{x:0,y:0,w:1,h:1}:{x:.761,y:1-bottom-(seat+1)*height,w:.205,h:height};
    if(validRect(rect))participants.push({...rect,linkId,...(seat===-1?{owner:true}:grid.type===2?{audioOnly:true}:{})});
  }
  return {...empty,participants};
}
function douyinFrame(value) {
  if(!Object.hasOwn(value||{},'app_data'))return null;
  let app;try{app=typeof value.app_data==='string'?parsePlatformJson(value.app_data):value.app_data;}catch{return null;}
  if(app?.ver===15)return audienceFrame(app);
  if(!app||![2,6].includes(app.ver))return {platform:'douyin',participants:[]};
  if(!Array.isArray(app.grids)||app.grids.length>64)return null;
  const channel=identifier(app.channel_id);
  if(!channel)return null;
  // Game camera composites have a different coordinate transform. Hide those
  // until that transform is known, instead of attaching a name to the game.
  if(app.game_clip||app.camera_clip)return {platform:'douyin',channel,participants:[]};
  const participants=[];
  const grids=app.ver===2?app.grids.slice(0,1):app.grids;
  for(const grid of grids) {
    const linkId=identifier(grid.uid_str)||identifier(grid.uid);
    if(!linkId||linkId==='mock_game_uid'||grid.alpha===0)continue;
    let rect={x:grid.x,y:grid.y,w:grid.w,h:grid.h};
    const crop=value.live_crop;
    if(app.ver===2&&crop) {
      if(![crop.crop_y,crop.crop_h,crop.stride_h].every(Number.isFinite)||crop.stride_h<=0)return null;
      rect={...rect,y:crop.crop_y/crop.stride_h,h:crop.crop_h/crop.stride_h};
    }
    if(validRect(rect))participants.push({...rect,linkId});
  }
  // The double-link protocol sends the remote tile only. Its own player adds
  // the local anchor on the left. Do so only for the exact half-width layout.
  if(app.ver===2&&participants.length===1&&Math.abs(participants[0].x-.5)<.001&&Math.abs(participants[0].w-.5)<.001)
    participants.unshift({...participants[0],x:0,linkId:'',owner:true});
  return {platform:'douyin',channel,version:app.ver,participants};
}
function decodePayload(type,payload) {
  try {
    if(type===5&&payload.subarray(0,16).toString('ascii')==='LIVE_SEI_CHANNEL')
      return {platform:'bilibili',value:parsePlatformJson(payload.subarray(16).toString('utf8').replace(/\0+$/,''))};
    if(type===100&&payload[0]===123)return {platform:'douyin',value:parsePlatformJson(payload.toString('utf8'))};
  }catch{/* Optional overlays must never interrupt recording on malformed SEI. */}
  return null;
}
export function platformSei(tag,lengthSize=4) {
  const result=[];
  if(tag.length<20||tag[0]!==9||(tag[11]&15)!==7||tag[12]!==1||![1,2,3,4].includes(lengthSize))return result;
  const end=tag.length-4;
  for(let offset=16,nals=0;offset+lengthSize<=end&&nals++<256;) {
    const length=tag.readUIntBE(offset,lengthSize);offset+=lengthSize;
    if(!length||offset+length>end)break;
    const nalu=tag.subarray(offset,offset+length);offset+=length;
    if((nalu[0]&31)!==6||length>MAX_SEI)continue;
    const rbsp=Buffer.allocUnsafe(length);let used=0;
    for(let i=1;i<nalu.length;i++){if(i>=3&&nalu[i]===3&&nalu[i-1]===0&&nalu[i-2]===0&&nalu[i+1]<=3)continue;rbsp[used++]=nalu[i];}
    let cursor=0;
    while(cursor+2<=used) {
      let type=0,size=0;
      while(cursor<used&&rbsp[cursor]===255){type+=255;cursor++;}
      if(cursor>=used)break;type+=rbsp[cursor++];
      while(cursor<used&&rbsp[cursor]===255){size+=255;cursor++;}
      if(cursor>=used)break;size+=rbsp[cursor++];
      if(size>MAX_SEI||cursor+size>used)break;
      const frame=decodePayload(type,rbsp.subarray(cursor,cursor+size));cursor+=size;
      if(frame)result.push(frame);
    }
  }
  return result;
}
export function linkmicFrames(payloads) {
  const frames=[];
  for(const {platform,value}of payloads)try {
    const frame=platform==='bilibili'?biliFrame(value):douyinFrame(value);if(frame)frames.push(frame);
  }catch{/* Optional malformed layout data must not stall the source index. */}
  return frames;
}
export function cameraFrames(payloads) {
  const frames=[];
  for(const {platform,value}of payloads) {
    let layout;
    if(platform==='bilibili')layout=biliCameraLayout(value);
    else {
      layout=douyinCameraLayout(value);
      if(layout===undefined&&value?.app_data)try{layout=douyinCameraLayout(typeof value.app_data==='string'?parsePlatformJson(value.app_data):value.app_data);}catch{}
    }
    if(layout!==undefined)frames.push({platform,layout});
  }
  return frames;
}
export const linkmicSei=(tag,lengthSize=4)=>linkmicFrames(platformSei(tag,lengthSize));
