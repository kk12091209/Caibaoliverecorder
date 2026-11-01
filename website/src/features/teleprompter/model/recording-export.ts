import {
  BlobSource,
  StreamTarget,
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

// Account for the original, already generated files, output copies and working
// overhead together. This bounds retained export buffers, not browser-wide RSS.
export const EXPORT_MEMORY_BUDGET = 256 * 1024 * 1024
const WORKING_RESERVE = 16 * 1024 * 1024
export function exportOutputLimit(sourceBytes: number, retainedBytes = 0) {
  if (![sourceBytes, retainedBytes].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('文件大小无效，请保存原始录制。')
  const available = Math.floor(
    (EXPORT_MEMORY_BUDGET - WORKING_RESERVE - sourceBytes * 2 - retainedBytes) / 3,
  )
  if (available <= 0) throw new Error('本次文件较大，请先保存原始录制；当前导出超出内存预算。')
  return available
}

// A bounded seekable target avoids BufferTarget's contiguous growth/copy peak.
// MP4 may rewrite its header, so append-only concatenation is not sufficient.
export function recordingBuffer(limit: number) {
  const pageSize = 256 * 1024,
    pages = new Map<number, Uint8Array<ArrayBuffer>>()
  let size = 0
  const release = () => {
    pages.clear()
    size = 0
  }
  return {
    target: new StreamTarget(
      new WritableStream({
        write({ data, position }) {
          const end = position + data.byteLength
          if (
            !Number.isSafeInteger(position) ||
            position < 0 ||
            !Number.isSafeInteger(end) ||
            end > limit
          )
            throw new Error('生成文件超出内存预算，原始录制仍可保存。')
          let copied = 0
          while (copied < data.byteLength) {
            const index = Math.floor((position + copied) / pageSize),
              offset = (position + copied) % pageSize
            let page = pages.get(index)
            if (!page) {
              page = new Uint8Array(Math.min(pageSize, limit - index * pageSize))
              pages.set(index, page)
            }
            const length = Math.min(data.byteLength - copied, page.length - offset)
            page.set(data.subarray(copied, copied + length), offset)
            copied += length
          }
          size = Math.max(size, end)
        },
        abort: release,
      }),
      { chunked: false },
    ),
    blob(type: string) {
      if (!size) throw new Error('未生成有效文件，请保存原始文件。')
      const chunks: Uint8Array<ArrayBuffer>[] = []
      for (let offset = 0; offset < size; offset += pageSize) {
        const length = Math.min(pageSize, size - offset)
        chunks.push((pages.get(offset / pageSize) || new Uint8Array(length)).subarray(0, length))
      }
      const blob = new Blob(chunks, { type })
      release()
      return blob
    },
    release,
  }
}

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
  retainedBytes = 0,
): Promise<ExportedRecording> {
  signal?.throwIfAborted()
  const buffer = recordingBuffer(exportOutputLimit(blob.size, retainedBytes))
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
    const target = buffer.target
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
    const mp4 = format === MP4
    return {
      blob: buffer.blob(`${kind}/${mp4 ? 'mp4' : format === OGG ? 'ogg' : 'webm'}`),
      extension: mp4 ? (kind === 'audio' ? 'm4a' : 'mp4') : format === OGG ? 'ogg' : 'webm',
      label: kind === 'video' ? '视频（无声）' : '独立音频',
    }
  } catch (error) {
    await output?.cancel().catch(() => {})
    throw error
  } finally {
    buffer.release()
    input.dispose()
  }
}

export async function zipRecordings(
  files: { name: string; blob: Blob }[],
  signal?: AbortSignal,
  retainedBytes = 0,
) {
  signal?.throwIfAborted()
  const limit = exportOutputLimit(
    files.reduce((total, file) => total + file.blob.size, 0),
    retainedBytes,
  )
  const { Zip, ZipPassThrough } = await import('fflate')
  const chunks: ArrayBuffer[] = []
  let failure: Error | null = null
  let bytes = 0
  const archive = new Zip((error, data) => {
    if (error) failure = error
    else if (data?.length) {
      bytes += data.byteLength
      if (bytes > limit) failure = new Error('打包超出内存预算，仍可分别保存文件。')
      else if (!failure) chunks.push(data.slice().buffer)
    }
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
          if (failure) throw failure
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
  } finally {
    chunks.length = 0
  }
}
