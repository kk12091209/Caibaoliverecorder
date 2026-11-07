// The app owns its tasks until readers, writers and external processes settle.
export function closeAppWith({
  beginClosing, timers, liveHealth, lotteries, updates, ingestor, media, recorder, linkmic,
  deletionMaintenance, deletingSessions, preparation, waveform, density, clients, server,
  storage, getStartupRecovery, credentials, diagnostics, store, runtime,
}) {
  let closePromise;
  return function close() {
    return closePromise??=(async()=>{
      beginClosing();liveHealth.close();await lotteries.close();await updates.close();for(const timer of timers)clearInterval(timer);ingestor.stop();media.close();const recorderClosed=recorder.close();await linkmic.close();
      const deletionsClosed=Promise.allSettled([deletionMaintenance.close(),deletingSessions.close()]);
      const preparationClosed=preparation.close();
      const waveformClosed=waveform.close();density.close();
      for(const client of clients)client.end();
      const httpClosed=new Promise(resolve=>server.close(resolve));
      await storage.close();
      await waveformClosed;
      await preparationClosed;
      await deletionsClosed;
      await getStartupRecovery();
      await media.waitForSaves();
      await Promise.allSettled([...media.probes,...media.enqueues,...media.previews.values()].map(operation=>operation.done));
      await httpClosed;
      await recorderClosed;
      while(ingestor.busy||media.processing||recorder.pollBusy)await new Promise(resolve=>setTimeout(resolve,30));
      await credentials.close();
      await diagnostics.close();
      store.close();
      await runtime.release();
    })();
  };
}

export async function recoverAppTasks({
  diagnostics, media, store, isClosing, ingestor, preparation, lotteries, options, maintain,
}) {
  // Publish the workbench before inspecting historical output files. A bad
  // task must not keep the native window on the startup failure page.
  try{
    diagnostics.record('数据恢复','开始恢复上次任务',{important:true});
    await media.recoverPendingSaves();
    if(!isClosing())await media.recoverInterruptedExports();
  }catch(error){store.recovery.error='部分旧任务恢复未完成，可以重新导出；原文件已保留。';diagnostics.record('任务恢复',error,{level:'警告',important:true});}
  finally{store.recovery.recovering=false;}
  if(!isClosing()){ingestor.start();void media.work();if(options.preparation!==false)preparation.start();if(!options.noRecorder&&options.lotteries!==false)lotteries.start();maintain();}
}
