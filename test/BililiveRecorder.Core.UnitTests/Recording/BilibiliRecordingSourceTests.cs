using System;
using BililiveRecorder.Core.Api;
using BililiveRecorder.Core.Recording;
using Xunit;
using static BililiveRecorder.Core.Api.Model.RoomPlayInfo;

namespace BililiveRecorder.Core.UnitTests.Recording
{
    public class BilibiliRecordingSourceTests
    {
        private static readonly StreamCodecQn[] Allowed = { new() { Codec = StreamCodec.AVC, Qn = 10000 }, new() { Codec = StreamCodec.AVC, Qn = 250 } };
        private static StreamItem Stream(string protocol, string format, string codec, string? host = "https://video.example", int[]? accept = null, int current = 250) =>
            new()
            {
                ProtocolName = protocol, Formats = new[] { new FormatItem { FormatName = format, Codecs = new[] { new CodecItem
                {
                    CodecName = codec, CurrentQn = current, AcceptQn = accept ?? new[] {10000, 250},
                    BaseUrl = "/live", UrlInfos = host == null ? Array.Empty<UrlInfoItem>() : new[] {new UrlInfoItem {Host = host, Extra = "?signed=example"}}
                }}}}
            };

        [Theory]
        [InlineData("ts")]
        [InlineData("fmp4")]
        public void SupportsAdvertisedAvcHlsWhenFlvHasNoRecordingRoute(string format)
        {
            var streams = new[] { Stream("http_stream", "flv", "avc", null), Stream("http_hls", format, "avc") };
            var source = BilibiliRecordingSource.Select(streams, Allowed, true, new StreamRouteHealth(), 721, DateTimeOffset.UtcNow);
            Assert.True(source!.IsHls);
            Assert.Equal(10000, source.Requested.Qn);
            Assert.Equal(250, source.CurrentQn);
            Assert.Equal("https://video.example/live?signed=example", source.Url);
            Assert.Null(BilibiliRecordingSource.Select(streams, Allowed, false, new StreamRouteHealth(), 721, DateTimeOffset.UtcNow));
        }

        [Fact]
        public void PrefersFlvAndFallsBackWhenItsRouteFailsWithoutPenalizingTheOtherRoom()
        {
            var streams = new[] { Stream("http_hls", "fmp4", "avc"), Stream("http_stream", "flv", "avc") };
            var now = DateTimeOffset.UtcNow;
            var health = new StreamRouteHealth();
            var flv = BilibiliRecordingSource.Select(streams, Allowed, true, health, 721, now)!;
            Assert.False(flv.IsHls);
            health.Failed(721, flv.Route, now);
            Assert.True(BilibiliRecordingSource.Select(streams, Allowed, true, health, 721, now)!.IsHls);
            Assert.False(BilibiliRecordingSource.Select(streams, Allowed, true, health, 5017134, now)!.IsHls);
            Assert.False(BilibiliRecordingSource.Select(streams, Allowed, true, health, 721, now.AddMinutes(3))!.IsHls);
        }


        [Theory]
        [InlineData("http_stream", "flv")]
        [InlineData("http_hls", "fmp4")]
        public void UnlistedCurrentAvcQualityRequiresExplicitFallback(string protocol, string format)
        {
            var health = new StreamRouteHealth();
            var now = DateTimeOffset.UtcNow;
            var streams = new[] { Stream(protocol, format, "avc", accept: new[] {888}, current: 888) };
            Assert.Null(BilibiliRecordingSource.Select(streams, Allowed, true, health, 721, now));
            var flexible = RecordTaskBase.ParseAllowedQn("avc10000,avc250,avc*");
            var chosen = BilibiliRecordingSource.Select(streams, flexible, true, health, 721, now)!;
            Assert.Equal(888, chosen.CurrentQn);
            Assert.Equal(chosen.CurrentQn, chosen.Requested.Qn);
            Assert.Null(BilibiliRecordingSource.Select(new[] { Stream(protocol, format, "av1") }, flexible, true, health, 721, now));
            Assert.Null(BilibiliRecordingSource.Select(new[] { Stream(protocol, format, "avc", accept: Array.Empty<int>(), current: 0) },
                flexible, true, health, 721, now));
        }

        [Fact]
        public void RequestedHlsQualityPrecedesUnlistedFlvQuality()
        {
            var streams = new[] { Stream("http_stream", "flv", "avc", accept: new[] {888}, current: 888), Stream("http_hls", "ts", "avc") };
            var selected = BilibiliRecordingSource.Select(streams, RecordTaskBase.ParseAllowedQn("avc250,avc*"), true,
                new StreamRouteHealth(), 721, DateTimeOffset.UtcNow)!;
            Assert.True(selected.IsHls);
            Assert.Equal(250, selected.Requested.Qn);
            Assert.Empty(RecordTaskBase.ParseAllowedQn("-2,hevc-2,avc-2"));
        }

        [Fact]
        public void SelectsActualQualityWhenAcceptListIsEmptyAndRejectsUnsupportedOrMismatchedMedia()
        {
            var streams = new[] { Stream("http_hls", "fmp4", "avc", accept: Array.Empty<int>()) };
            Assert.Equal(250, BilibiliRecordingSource.Select(streams, Allowed, true, new StreamRouteHealth(), 721, DateTimeOffset.UtcNow)!.Requested.Qn);
            streams = new[] { Stream("http_hls", "fmp4", "av1"), Stream("http_hls", "fmp4", "hevc"), Stream("http_stream", "dash", "avc") };
            Assert.Null(BilibiliRecordingSource.Select(streams, Allowed, true, new StreamRouteHealth(), 721, DateTimeOffset.UtcNow));
        }
    }
}
