using System;

namespace BililiveRecorder.Core.Recording
{
    // All times are elapsed monotonic milliseconds, never the wall clock.
    internal sealed class RecordingProgressWatchdog
    {
        internal const double StartupTimeout = 20000;
        internal const double ProgressTimeout = 15000;
        private readonly object sync = new();
        private double started, network, disk, video, audio;
        private bool checkMedia, wrote, sawVideo, sawAudio, inputEnded;
        private int videoTimestamp = -1, audioTimestamp = -1;

        public void Start(double now, bool checkMedia)
        {
            lock (this.sync)
            {
                this.started = this.network = this.disk = this.video = this.audio = now;
                this.checkMedia = checkMedia;
                this.wrote = this.sawVideo = this.sawAudio = false;
                this.inputEnded = false;
                this.videoTimestamp = this.audioTimestamp = -1;
            }
        }

        // Call only after the write has completed, not when a frame is parsed.
        public void Written(double now, int bytes, int videoTimestamp = -1, int audioTimestamp = -1)
        {
            if (bytes <= 0) return;
            lock (this.sync)
            {
                this.disk = now;
                this.wrote = true;
                if (videoTimestamp >= 0 && videoTimestamp > this.videoTimestamp)
                {
                    this.video = now; this.sawVideo = true; this.videoTimestamp = videoTimestamp;
                }
                if (audioTimestamp >= 0 && audioTimestamp > this.audioTimestamp)
                {
                    this.audio = now; this.sawAudio = true; this.audioTimestamp = audioTimestamp;
                }
            }
        }

        public void NewFile()
        {
            lock (this.sync) this.videoTimestamp = this.audioTimestamp = -1;
        }

        public void InputEnded()
        {
            lock (this.sync) this.inputEnded = true;
        }

        public string? Check(double now, int receivedBytes, uint networkTimeout)
        {
            lock (this.sync)
            {
                if (receivedBytes > 0) this.network = now;
                string? reason = null;
                if (!this.inputEnded && now - this.network >= Math.Max(1000, networkTimeout)) reason = "未收到直播数据";
                else if (now - this.disk >= (this.wrote ? ProgressTimeout : StartupTimeout)) reason = "录制文件停止写入";
                else if (this.checkMedia)
                {
                    if (!this.sawVideo && !this.sawAudio && now - this.started >= StartupTimeout) reason = "尚未写入有效音视频";
                    else if (this.sawVideo && now - this.video >= ProgressTimeout) reason = "视频时间停止推进";
                    else if (this.sawAudio && now - this.audio >= ProgressTimeout) reason = "音频时间停止推进";
                }
                return reason is null ? null : $"{reason}；距收包 {(now - this.network) / 1000:F1} 秒，距写入 {(now - this.disk) / 1000:F1} 秒，距视频推进 {(now - this.video) / 1000:F1} 秒，距音频推进 {(now - this.audio) / 1000:F1} 秒";
            }
        }
    }
}
