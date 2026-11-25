using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Nerdbank.Streams;
using Newtonsoft.Json;

namespace BililiveRecorder.Core.Recording
{
    internal static class BilibiliHlsRelay
    {
        private static readonly HttpClient Client = new(new HttpClientHandler
        {
            UseProxy = false,
            UseCookies = false,
            AllowAutoRedirect = false,
        }) { Timeout = Timeout.InfiniteTimeSpan };

        private static bool IsLocalEndpoint(Uri uri) =>
            uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.UserInfo.Length == 0 && uri.Fragment.Length == 0;

        internal static string? ResolveEndpoint(string? endpoint, string? token, string? webhook)
        {
            if (string.IsNullOrWhiteSpace(token) || !Uri.TryCreate(endpoint, UriKind.Absolute, out var initial) ||
                !IsLocalEndpoint(initial) || initial.Query.Length != 0 || initial.AbsolutePath != "/internal/recorder-hls")
                return null;

            // A surviving core may be adopted by the desktop backend on a new port.
            if (Uri.TryCreate(webhook, UriKind.Absolute, out var current) && IsLocalEndpoint(current) &&
                current.AbsolutePath == "/internal/recorder-event" && current.Query == "?token=" + token)
                return new Uri(current, initial.AbsolutePath).AbsoluteUri;
            return initial.AbsoluteUri;
        }

        internal static async Task<Stream> OpenAsync(string endpoint, string token, int roomId, string sourceUrl,
            int timeoutMilliseconds, CancellationToken ct)
        {
            if (ResolveEndpoint(endpoint, token, null) == null)
                throw new IOException("HLS 本地转封装服务未配置");
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
            {
                Content = new StringContent(JsonConvert.SerializeObject(new { roomId, url = sourceUrl }), Encoding.UTF8, "application/json")
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("video/x-flv"));

            using var startup = CancellationTokenSource.CreateLinkedTokenSource(ct);
            startup.CancelAfter(timeoutMilliseconds);
            var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, startup.Token).ConfigureAwait(false);
            try
            {
                if (response.StatusCode != HttpStatusCode.OK || response.Content.Headers.ContentType?.MediaType != "video/x-flv")
                    throw new IOException($"HLS 转封装未能开始（HTTP {(int)response.StatusCode}）");
                var stream = new MonitoringStream(await response.Content.ReadAsStreamAsync().ConfigureAwait(false));
                var stop = ct.Register(response.Dispose);
                stream.Disposed += (_, _) => { stop.Dispose(); response.Dispose(); };
                return stream;
            }
            catch
            {
                response.Dispose();
                throw;
            }
        }
    }
}
