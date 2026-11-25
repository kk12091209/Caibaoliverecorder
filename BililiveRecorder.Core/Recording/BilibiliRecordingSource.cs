using System;
using System.Collections.Generic;
using System.Linq;
using BililiveRecorder.Core.Api;
using static BililiveRecorder.Core.Api.Model.RoomPlayInfo;

namespace BililiveRecorder.Core.Recording
{
    internal sealed record BilibiliRecordingSource(string Url, string Route, bool IsHls, StreamCodecQn Requested, int CurrentQn)
    {
        internal const int AnyCurrentQuality = -2;

        internal static BilibiliRecordingSource? Select(StreamItem[] streams, IReadOnlyList<StreamCodecQn> qualities, bool allowHls,
            StreamRouteHealth health, int roomId, DateTimeOffset now)
        {
            var preferred = Candidates(streams, qualities.Where(q => q.Qn != AnyCurrentQuality), allowHls, health, roomId, now);
            var fallback = Candidates(streams, qualities.Where(q => q.Qn == AnyCurrentQuality), allowHls, health, roomId, now);
            BilibiliRecordingSource? first = null;
            foreach (var candidate in preferred.Concat(fallback))
            {
                if (!health.IsCoolingDown(roomId, candidate.Route, now)) return candidate;
                first ??= candidate;
            }
            return first;
        }

        private static IEnumerable<BilibiliRecordingSource> Candidates(StreamItem[] streams, IEnumerable<StreamCodecQn> qualities,
            bool allowHls, StreamRouteHealth health, int roomId, DateTimeOffset now)
        {
            // Only H.264 HLS can be remuxed to the native FLV editing pipeline without re-encoding.
            var formats = new[] { ("http_stream", "flv"), ("http_hls", "fmp4"), ("http_hls", "ts") };
            foreach (var (protocol, format) in formats)
            {
                var hls = protocol == "http_hls";
                if (hls && !allowHls) continue;
                var codecs = streams.Where(x => x?.ProtocolName == protocol)
                    .SelectMany(x => x.Formats ?? Array.Empty<FormatItem>())
                    .Where(x => x?.FormatName == format)
                    .SelectMany(x => x.Codecs ?? Array.Empty<CodecItem>()).ToArray();
                foreach (var quality in qualities)
                {
                    if (hls && quality.Codec != StreamCodec.AVC) continue;
                    var name = quality.Codec == StreamCodec.AVC ? "avc" : "hevc";
                    foreach (var item in codecs)
                    {
                        if (item?.CodecName != name || string.IsNullOrWhiteSpace(item.BaseUrl)) continue;
                        var qn = quality.Qn == AnyCurrentQuality ? item.CurrentQn : quality.Qn;
                        if (quality.Qn == AnyCurrentQuality && qn <= 0) continue;
                        if (item.CurrentQn != qn && item.AcceptQn?.Contains(qn) != true) continue;
                        var routes = new List<BilibiliRecordingSource>();
                        foreach (var info in item.UrlInfos ?? Array.Empty<UrlInfoItem>())
                        {
                            if (string.IsNullOrWhiteSpace(info?.Host)) continue;
                            var url = info!.Host + item.BaseUrl + info.Extra;
                            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http") ||
                                (hls && uri.Scheme != "https") || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0) continue;
                            var key = protocol + "/" + format + ":" + uri.Authority;
                            routes.Add(new(url, key, hls, quality with { Qn = qn }, item.CurrentQn));
                        }
                        if (routes.Count == 0) continue;
                        var host = health.Select(roomId, routes.Select(route => route.Route), now);
                        yield return routes.First(route => route.Route == host);
                    }
                }
            }
        }
    }
}
