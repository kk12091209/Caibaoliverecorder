import { extractRecordingTrack, zipRecordings } from './recording-export'

self.onmessage = async ({ data }) => {
  try {
    const value =
      data.operation === 'track'
        ? await extractRecordingTrack(data.blob, data.kind)
        : await zipRecordings(data.files)
    self.postMessage({ value })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '文件处理失败。' })
  }
}
