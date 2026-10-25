const GiB=1024**3;

// Independent VideoToolbox workers also spread the CPU subtitle renderer over
// several cores. Keep the existing two-worker budget on unmeasured devices.
export async function foregroundRenderConcurrency(plan,parts,{recording=false,resources}={}) {
  const encoder=plan.profile.encoder;
  if(!encoder.hardware||parts.length<2||recording)return 1;
  if(encoder.id!=='h264_videotoolbox'||parts.length<4||!resources)return 2;
  let sample;try{sample=await resources();}catch{return 2;}
  if(!Number.isFinite(sample.cores)||sample.cores<8||!Number.isFinite(sample.total)||sample.total<8*GiB)return 2;
  // Include decoder surfaces, subtitle buffers and an explicit 2 GiB reserve.
  // A 4K job therefore needs substantially more memory than a 1080p job.
  const bytes=Math.max(256*1024**2,plan.profile.width*plan.profile.height*4*48);
  if(!Number.isFinite(sample.available)||!Number.isFinite(bytes))return 2;
  const capacity=Math.floor((sample.available-2*GiB)/bytes);
  return Math.max(2,Math.min(4,Math.floor(sample.cores/2),capacity));
}
