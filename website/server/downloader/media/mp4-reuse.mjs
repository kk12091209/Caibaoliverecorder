import { open } from 'node:fs/promises'
import { runMedia } from './process.mjs'
import { mediaTool } from './tools.mjs'

// Only an ordinary, complete MP4 with its index before the media can bypass
// remuxing. Fragmented, truncated and unknown containers keep the existing path.
export async function hasProgressiveMp4Layout(file) {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const header = Buffer.alloc(16)
    let offset = 0,
      boxes = 0,
      ftyp = false,
      moov = false,
      mdat = false
    while (offset < size && ++boxes <= 4096) {
      if (size - offset < 8) return false
      const { bytesRead } = await handle.read(header, 0, Math.min(16, size - offset), offset)
      if (bytesRead < 8) return false
      let length = header.readUInt32BE(0),
        minimum = 8
      const type = header.toString('ascii', 4, 8)
      if (length === 1) {
        if (bytesRead < 16) return false
        const extended = header.readBigUInt64BE(8)
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false
        length = Number(extended)
        minimum = 16
      } else if (length === 0) length = size - offset
      if (length < minimum || offset + length > size) return false
      if (type === 'ftyp') {
        if (offset !== 0 || length < 16) return false
        ftyp = true
      } else if (type === 'moov') {
        if (!ftyp || moov || mdat) return false
        moov = true
      } else if (type === 'mdat') {
        if (!moov || length <= minimum) return false
        mdat = true
      } else if (!['free', 'skip', 'wide'].includes(type)) return false
      offset += length
    }
    return offset === size && ftyp && moov && mdat
  } finally {
    await handle.close()
  }
}

export async function reusableMp4(file, signal) {
  try {
    if (!(await hasProgressiveMp4Layout(file))) return null
    const raw = await runMedia(
      await mediaTool('ffprobe'),
      [
        '-v',
        'error',
        '-count_packets',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,nb_read_packets:format=format_name,duration',
        '-of',
        'json',
        file,
      ],
      signal,
      { idleMs: 30000, rejectStderr: true },
    )
    const data = JSON.parse(raw),
      streams = data.streams || []
    const videos = streams.filter((s) => s.codec_type === 'video'),
      audios = streams.filter((s) => s.codec_type === 'audio')
    if (
      videos.length !== 1 ||
      audios.length > 1 ||
      streams.length !== videos.length + audios.length ||
      videos[0].codec_name !== 'h264' ||
      audios.some((s) => s.codec_name !== 'aac') ||
      streams.some((s) => !(Number(s.nb_read_packets) > 0)) ||
      !(videos[0].width > 0 && videos[0].height > 0 && Number(data.format?.duration) > 0)
    )
      return null
    return {
      width: videos[0].width,
      height: videos[0].height,
      duration: Number(data.format.duration),
      hasAudio: audios.length === 1,
    }
  } catch (error) {
    signal?.throwIfAborted()
    return null
  }
}
