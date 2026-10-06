import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { atomicJson } from './service-runtime.js';

export const damagedDatabase=error=>[11,26].includes(error.errcode)||error.errcode===1&&/no such column|has no column|malformed database|no such table/i.test(error.message);
export async function privateDirectory(directory) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('数据恢复目录异常，已保留原文件。');
}
export async function openRecoveredStore(root,diagnostics) {
  const recovery=path.join(root,'recovery'),safeRoot=path.join(recovery,'safe-data'),marker=path.join(recovery,'active.json');
  let active=false;
  try {const stat=await fs.lstat(recovery);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('数据恢复目录异常，已保留原文件。');
    try {const saved=JSON.parse(await fs.readFile(marker,'utf8'));active=saved?.mode==='safe-data-v1';}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    // A damaged marker must not discard a previously used safe workbench.
    if(!active)active=await fs.stat(path.join(safeRoot,'editor.sqlite')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const open=async directory=>{
    try{if((await fs.lstat(path.join(directory,'editor.sqlite'))).isSymbolicLink())throw new Error('素材数据库文件异常，已保留原文件。');}catch(error){if(error.code!=='ENOENT')throw error;}
    return new Store(directory);
  };
  let store;
  if(!active)try {store=await open(root);}catch(error){
    if(!damagedDatabase(error))throw error;
    await privateDirectory(recovery);await privateDirectory(safeRoot);
    // Keep the original database, WAL, recordings and configurations in place.
    // The durable marker selects an independent index on subsequent launches.
    await atomicJson(marker,{mode:'safe-data-v1',created:new Date().toISOString(),reason:'素材索引无法读取，原数据已隔离保留'});
    active=true;
    diagnostics.record('数据恢复','旧素材索引无法读取，已保留原始文件并启用安全数据区',{level:'警告',important:true});
  }
  if(active) {
    await privateDirectory(recovery);await privateDirectory(safeRoot);
    try{store=await open(safeRoot);}catch(error){
      if(!damagedDatabase(error))throw error;
      const backup=path.join(recovery,'retained-index-'+randomUUID());await privateDirectory(backup);
      for(const suffix of ['', '-wal','-shm','-journal'])try{await fs.rename(path.join(safeRoot,'editor.sqlite')+suffix,path.join(backup,'editor.sqlite'+suffix));}catch(error){if(error.code!=='ENOENT')throw error;}
      diagnostics.record('数据恢复','安全区素材索引损坏，已隔离保留；录像文件未删除',{level:'警告',important:true});
      store=await open(safeRoot);
    }
  }
  store.primaryRoot=root;store.diagnostics=diagnostics;
  store.recovery={safeMode:active,recovering:false,error:'',isolatedRecords:store.recoveryCount};
  if(store.recoveryCount)diagnostics.record('数据恢复',`已保留并隔离 ${store.recoveryCount} 条异常记录，其他数据继续使用`,{level:'警告',important:true});
  return store;
}
