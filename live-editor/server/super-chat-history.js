import { createReadStream } from 'node:fs';
import { xmlAttributes } from './chat-xml.js';
import { giftEventId, superChatPresentation } from './gifts.js';

const migrations = new WeakMap();
const startTag = Buffer.from('<sc '), endTag = Buffer.from('</sc>');
const maxRecordBytes = 256 * 1024;

async function readPresentation(store,source) {
  if (!source.xml||source.xmlpos<=0) return;
  let offset=0, pending=Buffer.alloc(0);
  const stream=createReadStream(source.xml,{end:source.xmlpos-1,highWaterMark:128*1024});
  for await (const bytes of stream) {
    const buffer=Buffer.concat([pending,bytes]);
    let consumed=0;
    for (;;) {
      const from=buffer.indexOf(startTag,consumed);
      if (from<0) {consumed=Math.max(consumed,buffer.length-startTag.length);break;}
      const tag=buffer.indexOf(62,from+startTag.length);
      const end=tag>=0?buffer.indexOf(endTag,tag):-1;
      if (end<0) {
        consumed=buffer.length-from>maxRecordBytes?from+startTag.length:from;
        break;
      }
      if (tag-from<=maxRecordBytes) {
        const attributes=xmlAttributes(buffer.toString('utf8',from+startTag.length,tag));
        const id=giftEventId('sc',attributes,source,offset+from);
        store.run("UPDATE gift_events SET presentation=? WHERE id=? AND presentation=''",
          JSON.stringify(superChatPresentation(attributes)),id);
      }
      consumed=end+endTag.length;
    }
    offset+=consumed;
    pending=buffer.subarray(consumed);
  }
}

export async function prepareSuperChats(store,session) {
  const sources=store.all(`SELECT s.* FROM sources s WHERE s.session=? AND EXISTS(
    SELECT 1 FROM gift_events g WHERE g.session=? AND g.source=s.id AND g.type='sc' AND g.presentation='')`,session,session);
  if (!sources.length) return;
  let attempts=migrations.get(store);
  if (!attempts) {attempts=new Map();migrations.set(store,attempts);}
  for (const source of sources) {
    if (!attempts.has(source.id)) {
      attempts.set(source.id,readPresentation(store,source).catch(()=>{}));
      while (attempts.size>256) attempts.delete(attempts.keys().next().value);
    }
    await attempts.get(source.id);
  }
}
