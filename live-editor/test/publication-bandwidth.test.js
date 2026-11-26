import assert from 'node:assert/strict';
import test from 'node:test';
import { MiB, PublicationBandwidth } from '../server/publication-bandwidth.js';

test('starts uncapped and increases a shared budget only with healthy demand', async () => {
  let time=0;
  const governor=new PublicationBandwidth({now:()=>time,delay:async ms=>{time+=ms;}});
  const first=governor.transfer(),second=governor.transfer();
  await first.take(MiB,undefined);
  await second.take(MiB,undefined);
  assert.equal(time,0);
  governor.update({state:'observing',reason:'开播'});
  assert.equal(governor.rate,MiB);
  await first.take(MiB/4,undefined);
  await second.take(MiB/4,undefined);
  assert.equal(time,250);
  governor.update({state:'healthy'},MiB);
  time+=15_000;
  governor.update({state:'healthy'},MiB*0.5);
  assert.equal(governor.rate,MiB);
  time+=15_000;
  governor.update({state:'healthy'},MiB);
  assert.equal(governor.rate,MiB*1.5);
  governor.update({state:'pressure',room:'123',reason:'写入变慢'});
  assert.equal(governor.rate,MiB*.75);
  governor.update({state:'idle'});
  assert.equal(governor.rate,Infinity);
});

test('extended recording protection yields only an open request and counts actual replayed bytes', async () => {
  let time=0;
  const governor=new PublicationBandwidth({now:()=>time,delay:async ms=>{time+=ms;}});
  const transfer=governor.transfer();
  transfer.sent(1,0,500);
  transfer.confirm(2,400);
  governor.update({state:'paused',reason:'重连'});
  await assert.rejects(transfer.take(500,undefined),{code:'CAIBO_UPLOAD_YIELDED'});
  assert.equal(transfer.metrics().pausedMs,20_000);
  governor.update({state:'healthy'});
  await transfer.awaitOpen();
  transfer.sent(1,0,800);
  transfer.confirm(1,800);
  const {emitted,repeated,confirmed,pausedMs}=transfer.metrics();
  assert.deepEqual({emitted,repeated,confirmed,pausedMs},{emitted:1300,repeated:500,confirmed:1200,pausedMs:20_000});
});
