using BililiveRecorder.Core.Recording;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Recording
{
    public class RecordingProgressWatchdogTests
    {
        private static RecordingProgressWatchdog Create(bool media = true)
        {
            var guard = new RecordingProgressWatchdog(); guard.Start(0, media); return guard;
        }

        [Fact]
        public void TotalNetworkLossTimesOutButBriefJitterRecovers()
        {
            var guard = Create();
            Assert.Null(guard.Check(8000, 0, 10000));
            guard.Written(9000, 1000, 9000, 9000);
            Assert.Null(guard.Check(9000, 1000, 10000));
            Assert.Contains("未收到直播数据", guard.Check(19000, 0, 10000));
        }

        [Fact]
        public void TrickleCannotHideMissingDiskWrites()
        {
            var guard = Create();
            for (var now = 2000; now < 20000; now += 2000) Assert.Null(guard.Check(now, 1, 10000));
            Assert.Contains("文件停止写入", guard.Check(20000, 1, 10000));
        }

        [Fact]
        public void RepeatedMediaTimestampsCannotHideFrozenVideo()
        {
            var guard = Create(); guard.Written(0, 100, 0, 0);
            for (var now = 2000; now <= 16000; now += 2000)
            {
                guard.Written(now, 100, 0, now);
                var reason = guard.Check(now, 100, 10000);
                if (now < 15000) Assert.Null(reason); else Assert.Contains("视频时间停止", reason);
            }
        }

        [Fact]
        public void MissingAudioIsDetectedIndependentlyOfVideo()
        {
            var guard = Create(); guard.Written(0, 100, 0, 0);
            guard.Written(16000, 100, 16000);
            Assert.Contains("音频时间停止", guard.Check(16000, 100, 10000));
        }

        [Fact]
        public void HeadersAloneAreNotEffectiveMedia()
        {
            var guard = Create(); guard.Written(20000, 100);
            Assert.Contains("尚未写入有效音视频", guard.Check(20000, 1, 10000));
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void HealthyAndAudioOnlyStreamsRemainHealthyAcrossFileSplits(bool video)
        {
            var guard = Create();
            for (var now = 0; now <= 2400000; now += 2000)
            {
                if (now % 60000 == 0) guard.NewFile();
                guard.Written(now, 100, video ? now % 60000 : -1, now % 60000);
                Assert.Null(guard.Check(now, 100, 10000));
            }
        }

        [Fact]
        public void EofDrainsBufferedFramesButStillDetectsAStuckWriter()
        {
            var guard = Create(); guard.InputEnded();
            for (var now = 0; now <= 20000; now += 2000)
            {
                guard.Written(now, 100, now, now);
                Assert.Null(guard.Check(now, 0, 10000));
            }
            Assert.Contains("文件停止写入", guard.Check(35000, 0, 10000));
        }

        [Fact]
        public void RawModeChecksActualWritesWithoutRequiringParsedFrames()
        {
            var guard = Create(false); guard.Written(30000, 100);
            Assert.Null(guard.Check(30000, 100, 10000));
            Assert.Contains("文件停止写入", guard.Check(45000, 100, 10000));
        }
    }
}
