import os from 'node:os';

const hardwareEncoders = [
  { id:'h264_nvenc', label:'NVIDIA 硬件加速', args:['-preset','p4','-rc','vbr','-cq','20','-b:v','0'] },
  { id:'h264_qsv', label:'Intel 硬件加速', args:['-preset','veryfast','-global_quality','20'] },
  { id:'h264_amf', label:'AMD 硬件加速', args:['-usage','transcoding','-quality','balanced','-rc','cqp','-qp_i','23','-qp_p','23'] }
];

export function softwareEncoder() {
  // Leave capacity for recording, decoding and the editor, including on a dual-core PC.
  const threads=Math.max(1,Math.min(6,Math.floor(os.availableParallelism()/2)));
  return { id:'libx264', label:'CPU 编码', hardware:false, threads };
}

export function encoderArguments(encoder, dual=false) {
  return encoder.hardware
    ? ['-c:v',encoder.id,...encoder.args]
    : ['-c:v','libx264','-preset','veryfast','-crf','20','-threads',String(Math.max(1,Math.floor(encoder.threads/(dual?2:1))))];
}

export function videoGeometryFilter(info, width, height) {
  if (info.width === width && info.height === height && info.sampleAspectRatio === '1:1') return '';
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

export function canCopyFullSource(job, sources, info, base) {
  if (job.scope !== 'full' || sources.length !== 1 || job.ranges?.length !== 1) return false;
  const source = sources[0], range = job.ranges[0];
  return source.closed === 2 && Math.abs(range.start - source.start) < .001 &&
    Math.abs(range.end - source.start - source.duration) < .001 && Math.abs(base - range.start) < .001 &&
    info.metadataVersion >= 2 && info.codec === 'h264' && info.pixelFormat === 'yuv420p' &&
    info.videoStreams === 1 && info.audioStreams <= 1 && (info.audioStreams === 0 || info.audioCodec === 'aac') &&
    info.width % 2 === 0 && info.height % 2 === 0 && info.sampleAspectRatio === '1:1';
}

export function videoMetadata(streams) {
  const videos = streams.filter(s => s.codec_type === 'video'), audio = streams.filter(s => s.codec_type === 'audio');
  const video = videos[0];
  if (!video?.width || !video?.height) throw new Error('素材中没有可识别的视频画面。');
  const [a, b] = (video.r_frame_rate || '30/1').split('/').map(Number);
  const result = { metadataVersion: 2, width: video.width, height: video.height,
    fps: b && a / b > 0 ? a / b : 30, codec: video.codec_name,
    pixelFormat: video.pix_fmt || null, sampleAspectRatio: video.sample_aspect_ratio || null,
    videoStreams: videos.length, audioStreams: audio.length, audioCodec: audio[0]?.codec_name || null };
  if(video.extradata_hash)result.encodingSignature=JSON.stringify([video.codec_name,video.profile,video.level,video.width,video.height,video.pix_fmt,video.sample_aspect_ratio,video.time_base,video.extradata_hash]);
  if(Number.isFinite(Number(video.nb_frames)))result.frames=Number(video.nb_frames);
  if(Number.isFinite(Number(video.duration)))result.duration=Number(video.duration);
  return result;
}

export function preparedEncoderArguments(encoder) {
  return [...encoderArguments({...encoder,threads:Math.min(2,encoder.threads||2)}),'-g','120','-bf','0',
    ...(encoder.id==='libx264'?['-sc_threshold','0']:[]),'-pix_fmt','yuv420p','-video_track_timescale','60000'];
}

export async function detectExportEncoder(run) {
  for(const candidate of hardwareEncoders) {
    const encoder={...candidate,hardware:true},controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),8000);
    try {
      // A listed encoder may have no compatible GPU/driver. Encode actual frames,
      // and open two sessions because dual-file export needs both concurrently.
      const output=()=>['-map','0:v:0','-frames:v','8','-an','-pix_fmt','yuv420p',...encoderArguments(encoder),'-f','null','-'];
      await run(['-f','lavfi','-i','color=c=black:size=640x360:rate=30',...output(),...output()],{signal:controller.signal});
      if(!controller.signal.aborted)return encoder;
    } catch { /* Try the next vendor, then use the universally available CPU path. */ }
    finally { clearTimeout(timeout); }
  }
  return softwareEncoder();
}
