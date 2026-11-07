import { exportedJobFile } from './output-names.js';
import { directories } from './directories.js';
import { chatRate } from './chat-rules.js';
import { savedGiftStyle } from '../shared/gifts.js';
import { savedDanmakuStyle } from '../shared/danmaku-style.js';
import { savedRecordingStyle } from '../shared/recording-style.js';
import { savedHighlightStyle } from '../shared/highlight-style.js';
import { savedTimestampStyle, savedTimestampPosition } from '../shared/timestamp-style.js';

export function workbenchSettings(store,media,closeAction,previewTimestamp){return {
  paths:directories(store),closeAction:closeAction(),previewTimestamp:previewTimestamp(),
  previewTimestampStyle:savedTimestampStyle(store),previewTimestampPosition:savedTimestampPosition(store),
  recordingStyle:savedRecordingStyle(store),giftStyle:savedGiftStyle(store),danmakuPerSecond:chatRate(store),
  danmakuStyle:savedDanmakuStyle(store),highlightStyle:savedHighlightStyle(store),danmakuFont:media.fonts.snapshot()
};}

export function workbenchSnapshot({store,recorder,diagnostics,updates,preparation,deletingSessions,root,settingsSnapshot,credentialWarnings}){return {credentialWarnings,recovery:{...store.recovery,isolatedRecords:store.recoveryCount},diagnostics:{error:diagnostics.lastError},updates:updates.snapshot(),sessions:recorder.materialOrigins(store.sessions()),rooms:recorder.rooms,anchors:recorder.anchors,following:recorder.douyin.followingSnapshot,recorder:recorder.statusSnapshot(),preparation:preparation.snapshot(),jobs:store.all("SELECT jobs.id,session,jobs.created,jobs.status,progress,file,jobs.error,mode,data FROM jobs LEFT JOIN sessions ON sessions.id=jobs.session WHERE jobs.session IS NULL OR sessions.deleted_at='' ORDER BY jobs.created DESC,jobs.rowid ASC LIMIT 100").map(job=>{const {data,...entry}=job,details=store.jobDetails(job);return {...entry,scope:details.scope||'clips',clipIndex:details.clipIndex,clipCount:details.clipCount,danmaku_file:exportedJobFile(job,'danmaku')||'',canRetrySave:details.canRetrySave===true,canRetryExport:['failed','interrupted'].includes(job.status)&&!details.recoveryInvalid,hasProcessingRecovery:!!details.processingRecovery,savedExportSteps:details.processingRecovery?.completedSteps||0,hasRetainedFiles:!!(details.processingRecovery||details.pendingPublication),automaticRetries:details.automaticRetries||0,resumedExportSteps:details.resumedExportSteps||0,exportDirectory:details.outputRoot||''};}),deletions:deletingSessions.snapshot(),pendingCleanup:store.pendingCleanup(),dataPath:root,...settingsSnapshot()};}
