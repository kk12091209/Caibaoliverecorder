// Coordinates are relative to the encoded video, including its own padding.
// Browser letterboxing and export letterboxing are applied only at rendering.
export function validRect(rect) {
  return rect && ['x','y','w','h'].every(key=>Number.isFinite(rect[key])) &&
    rect.x>=0 && rect.y>=0 && rect.w>0 && rect.h>0 &&
    rect.x+rect.w<=1.001 && rect.y+rect.h<=1.001;
}
export const labelText=value=>typeof value==='string'
  ? Array.from(value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').trim()).slice(0,80).join('') : '';
export function participantName(person) {
  const name=labelText(person.name);
  if(name)return name;
  if(person.id)return `ID ${person.id}`;
  return person.linkId?`连麦 ${person.linkId}`:'';
}
export function labelGeometry(person,width,height,sourceWidth=width,sourceHeight=height) {
  if(!validRect(person)||![width,height,sourceWidth,sourceHeight].every(n=>Number.isFinite(n)&&n>0))return null;
  const scale=Math.min(width/sourceWidth,height/sourceHeight);
  const frameWidth=sourceWidth*scale,frameHeight=sourceHeight*scale;
  const left=(width-frameWidth)/2+person.x*frameWidth,top=(height-frameHeight)/2+person.y*frameHeight;
  const tileWidth=person.w*frameWidth,tileHeight=person.h*frameHeight;
  const size=Math.min(Math.max(9,Math.min(frameWidth,frameHeight)*.022),tileHeight*.16,tileWidth*.16);
  if(size<1)return null;
  const inset=Math.max(size*.45,2),maxWidth=Math.max(0,tileWidth-2*inset);
  // The same conservative truncation is used by CSS and ASS, with a final clip
  // to the tile. Very long IDs/names cannot spill into a neighbouring anchor.
  let text='',units=0;
  for(const char of Array.from(participantName(person))) {
    const next=/[\x20-\x7e]/.test(char)?.62:1;
    if((units+next+1)*size>maxWidth){text+='…';break;}
    text+=char;units+=next;
  }
  const audioOnly=person.audioOnly===true&&!person.owner;
  const avatarSize=Math.min(tileWidth*.56,tileHeight*.62);
  return {text,size,x:left+tileWidth-inset,y:top+tileHeight-inset,left,top,audioOnly,
    avatar:audioOnly?person.avatarUrl:'',avatarSize,
    avatarX:left+(tileWidth-avatarSize)/2,avatarY:top+Math.max(0,(tileHeight-size*1.8-avatarSize)/2),
    right:left+tileWidth,bottom:top+tileHeight,maxWidth};
}
export function labelsAt(events,time) {
  let low=0,high=events.length;
  while(low<high){const mid=(low+high)>>1;if(events[mid].time<=time)low=mid+1;else high=mid;}
  const event=events[low-1];
  return event&&time<event.end?event.participants:[];
}
