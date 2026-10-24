import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {Media} from '../server/media.js';

test('cancelled preview releases a backpressured output instead of blocking the next source',async()=>{
  const child=new EventEmitter(),controller=new AbortController();
  child.stdin=new PassThrough();child.stdin.resume();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdio=[child.stdin,child.stdout,child.stderr,new PassThrough()];child.pid=Number.NaN;
  let closed=false;child.kill=()=>{if(!closed){closed=true;setTimeout(()=>{child.stdout.end();child.emit('close',1);},5);}return true;};
  const media=Object.assign(Object.create(Media.prototype),{closed:false,ffmpeg:'fake',children:new Set(),backgroundChildren:new Set(),interactiveChildren:new Set(),spawnTracked:()=>child});
  let received;const writing=new Promise(resolve=>{received=resolve;});
  const output=new Writable({highWaterMark:1,write(_bytes,_encoding,_callback){received();/* paused browser: never drains */}});
  const operation=Media.prototype.processInternal.call(media,[],{output,signal:controller.signal,interactive:true});
  child.stdout.write(Buffer.alloc(128*1024));await writing;controller.abort();
  const result=await Promise.race([operation.then(()=>'settled'),delay(100).then(()=>'stuck')]);
  // Release the intentionally blocked sink even when verifying the old defect.
  output.destroy();await operation;
  assert.equal(result,'settled');assert.equal(output.destroyed,true);assert.equal(media.children.size,0);assert.equal(media.interactiveChildren.size,0);
});
