export type CameraFacing = 'user' | 'environment'

export function cameraConstraints(
  device: string,
  facing: CameraFacing,
  switching = false,
): MediaTrackConstraints {
  return {
    ...(device
      ? { deviceId: { exact: device } }
      : { facingMode: switching ? { exact: facing } : { ideal: facing } }),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  }
}

/** Device identity, rather than window width: a narrow desktop window is still a desktop. */
export function isMobileCameraDevice(agent: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>) {
  return (
    /Android|iPhone|iPad|iPod/i.test(agent.userAgent) ||
    (/Macintosh/i.test(agent.userAgent) && agent.maxTouchPoints > 1)
  )
}

export function requireLiveTracks(
  stream: Pick<MediaStream, 'getAudioTracks' | 'getVideoTracks'>,
  kind: 'audio' | 'video',
) {
  const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()
  if (!tracks.some((track) => track.readyState === 'live' && track.enabled)) {
    throw new Error(
      kind === 'audio'
        ? '没有获得可用的麦克风音轨，本次未开始录制。请允许麦克风权限后重试。'
        : '没有获得可用的摄像头画面，请重新开启摄像头或选择仅录音。',
    )
  }
}
