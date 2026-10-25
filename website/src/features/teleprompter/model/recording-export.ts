import {
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  OGG,
  Output,
  Mp4OutputFormat,
  OggOutputFormat,
  WEBM,
  WebMOutputFormat,
  type EncodedPacket,
  type InputTrack,
} from 'mediabunny'
import type { RecordingMode } from './recording'

export type ExportedRecording = { blob: Blob; extension: string; label: string }

async function copyTrackPackets(
  track: InputTrack,
  add: (packet: EncodedPacket) => Promise<void>,
  signal?: AbortSignal,
) {
  let packets = 0
  for await (const packet of new EncodedPacketSink(track).packets()) {
    signal?.throwIfAborted()
    await add(packet)
    packets++
    if (packets % 128 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return packets
}

/** Copy encoded packets to a single-track container; no second video encode or server upload. */
export async function extractRecordingTrack(
  blob: Blob,
  kind: RecordingMode,
  signal?: AbortSignal,
): Promise<ExportedRecording> {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4, WEBM, OGG] })
  let output: Output | undefined
  try {
    signal?.throwIfAborted()
    const format = await input.getFormat()
    const container =
      format === MP4
        ? new Mp4OutputFormat()
        : format === OGG
          ? new OggOutputFormat()
          : new WebMOutputFormat()
    const target = new BufferTarget()
    output = new Output({ format: container, target })
    let packets = 0
    if (kind === 'video') {
      const track = await input.getPrimaryVideoTrack()
      if (!track) throw new Error('这次录制中没有视频轨道。')
      const codec = await track.getCodec()
      const config = await track.getDecoderConfig()
      if (!codec || !config || !container.getSupportedVideoCodecs().includes(codec))
        throw new Error('当前视频格式暂时无法分离，请保存原始视频。')
      const source = new EncodedVideoPacketSource(codec)
      output.addVideoTrack(source, { rotation: await track.getRotation() })
      await output.start()
      packets = await copyTrackPackets(
        track,
        (packet) => source.add(packet, { decoderConfig: config }),
        signal,
      )
      source.close()
    } else {
      const track = await input.getPrimaryAudioTrack()
      if (!track) throw new Error('这次录制中没有音频轨道，请保存原始视频。')
      const codec = await track.getCodec()
      const config = await track.getDecoderConfig()
      if (!codec || !config || !container.getSupportedAudioCodecs().includes(codec))
        throw new Error('当前音频格式暂时无法分离，请保存原始视频。')
      const source = new EncodedAudioPacketSource(codec)
      output.addAudioTrack(source)
      await output.start()
      packets = await copyTrackPackets(
        track,
        (packet) => source.add(packet, { decoderConfig: config }),
        signal,
      )
      source.close()
    }
    if (!packets) throw new Error('未读取到有效媒体内容，请保存原始文件。')
    signal?.throwIfAborted()
    await output.finalize()
    if (!target.buffer?.byteLength) throw new Error('未生成有效文件，请保存原始文件。')
    const mp4 = format === MP4
    return {
      blob: new Blob([target.buffer], {
        type: `${kind}/${mp4 ? 'mp4' : format === OGG ? 'ogg' : 'webm'}`,
      }),
      extension: mp4 ? (kind === 'audio' ? 'm4a' : 'mp4') : format === OGG ? 'ogg' : 'webm',
      label: kind === 'video' ? '视频（无声）' : '独立音频',
    }
  } catch (error) {
    await output?.cancel().catch(() => {})
    throw error
  } finally {
    input.dispose()
  }
}

export async function zipRecordings(files: { name: string; blob: Blob }[], signal?: AbortSignal) {
  const { Zip, ZipPassThrough } = await import('fflate')
  const chunks: ArrayBuffer[] = []
  let failure: Error | null = null
  const archive = new Zip((error, data) => {
    if (error) failure = error
    else if (data?.length) chunks.push(data.slice().buffer)
  })
  try {
    for (const file of files) {
      signal?.throwIfAborted()
      const entry = new ZipPassThrough(file.name)
      archive.add(entry)
      const reader = file.blob.stream().getReader()
      let processed = 0
      try {
        while (true) {
          signal?.throwIfAborted()
          const next = await reader.read()
          if (next.done) break
          entry.push(next.value)
          processed += next.value.length
          if (processed >= 4 * 1024 * 1024) {
            processed = 0
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        }
        entry.push(new Uint8Array(), true)
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
    }
    archive.end()
    if (failure) throw failure
    return new Blob(chunks, { type: 'application/zip' })
  } catch (error) {
    archive.terminate()
    throw error
  }
}
