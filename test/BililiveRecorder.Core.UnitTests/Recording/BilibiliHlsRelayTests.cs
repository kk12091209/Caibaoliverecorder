#if NET8_0_OR_GREATER
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using BililiveRecorder.Core.Recording;
using Newtonsoft.Json.Linq;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Recording
{
    public class BilibiliHlsRelayTests
    {
        private const string Token = "test-only-capability";
        private const string Source = "https://media.example.test/live.m3u8?fake=test-signature";
        private static readonly byte[] FlvHeader = { 70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0 };

        private static string Endpoint(TcpListener listener) =>
            $"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/internal/recorder-hls";

        private static async Task<(string request, Dictionary<string, string> headers, string body)> ReadRequestAsync(
            NetworkStream stream, CancellationToken ct)
        {
            using var reader = new StreamReader(stream, Encoding.UTF8, leaveOpen: true);
            var request = await reader.ReadLineAsync(ct);
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            while (await reader.ReadLineAsync(ct) is { Length: > 0 } line)
            {
                var split = line.IndexOf(':');
                headers.Add(line[..split], line[(split + 1)..].Trim());
            }
            // Our fixture request contains only ASCII.
            var body = new char[int.Parse(headers["Content-Length"])];
            Assert.Equal(body.Length, await reader.ReadBlockAsync(body.AsMemory(), ct));
            return (request!, headers, new string(body));
        }

        [Fact]
        public void AdoptsOnlyTheCurrentBackendsAuthenticatedLoopbackEndpoint()
        {
            const string original = "http://127.0.0.1:12345/internal/recorder-hls";
            const string next = "http://127.0.0.1:23456/internal/recorder-event?token=";
            Assert.Equal(original, BilibiliHlsRelay.ResolveEndpoint(original, Token, next + "wrong"));
            Assert.Equal("http://127.0.0.1:23456/internal/recorder-hls", BilibiliHlsRelay.ResolveEndpoint(original, Token, next + Token));
            Assert.Null(BilibiliHlsRelay.ResolveEndpoint(original, "", null));
            Assert.Null(BilibiliHlsRelay.ResolveEndpoint("https://other.example/internal/recorder-hls", Token, null));
            Assert.Null(BilibiliHlsRelay.ResolveEndpoint(original + "?token=ignored", Token, null));
        }

        [Fact]
        public async Task SendsAuthenticatedPostAndClosesUnfinishedMediaOnDisposeAsync()
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var opening = BilibiliHlsRelay.OpenAsync(Endpoint(listener), Token, 721, Source, 4000, deadline.Token);
            using var client = await listener.AcceptTcpClientAsync(deadline.Token);
            using var socket = client.GetStream();
            var (request, headers, body) = await ReadRequestAsync(socket, deadline.Token);
            Assert.Equal("POST /internal/recorder-hls HTTP/1.1", request);
            Assert.Equal("Bearer " + Token, headers["Authorization"]);
            Assert.False(headers.ContainsKey("Cookie"));
            var data = JObject.Parse(body);
            Assert.Equal(721, (int)data["roomId"]!);
            Assert.Equal(Source, (string?)data["url"]);
            await socket.WriteAsync("HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nContent-Length: 100000000\r\n\r\n"u8.ToArray(), deadline.Token);
            await socket.WriteAsync(FlvHeader, deadline.Token);
            await using (var media = await opening)
            {
                var received = new byte[FlvHeader.Length];
                await media.ReadExactlyAsync(received, deadline.Token);
                Assert.Equal(FlvHeader, received);
            }
            // The relay must release its live fetch when the recording ends.
            try { Assert.Equal(0, await socket.ReadAsync(new byte[1], deadline.Token)); }
            catch (IOException ex) when (ex.InnerException is SocketException socketError &&
                socketError.SocketErrorCode == SocketError.ConnectionReset) { }
        }

        [Fact]
        public async Task CancellationCanStopPendingHandshakeAsync()
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            using var stopRecording = new CancellationTokenSource();
            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var opening = BilibiliHlsRelay.OpenAsync(Endpoint(listener), Token, 721, Source, 30000, stopRecording.Token);
            using var client = await listener.AcceptTcpClientAsync(deadline.Token);
            using var socket = client.GetStream();
            await ReadRequestAsync(socket, deadline.Token);
            stopRecording.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await opening.WaitAsync(deadline.Token));
            Assert.False(deadline.IsCancellationRequested);
        }

        [Theory]
        [InlineData("307 Temporary Redirect", "video/x-flv")]
        [InlineData("502 Bad Gateway", "text/plain")]
        [InlineData("200 OK", "text/html")]
        public async Task RejectsErrorsAndUnexpectedContentWithoutForwardingOrExposingSecretsAsync(string status, string type)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            using var original = new TcpListener(IPAddress.Loopback, 0);
            using var redirect = new TcpListener(IPAddress.Loopback, 0);
            original.Start();
            redirect.Start();
            var opening = BilibiliHlsRelay.OpenAsync(Endpoint(original), Token, 721, Source, 3000, deadline.Token);
            using var client = await original.AcceptTcpClientAsync(deadline.Token);
            using var socket = client.GetStream();
            await ReadRequestAsync(socket, deadline.Token);
            var secretBody = Source + " " + Token;
            var reply = $"HTTP/1.1 {status}\r\nContent-Type: {type}\r\nLocation: {Endpoint(redirect)}\r\nContent-Length: {secretBody.Length}\r\n\r\n{secretBody}";
            await socket.WriteAsync(Encoding.ASCII.GetBytes(reply), deadline.Token);
            var error = await Assert.ThrowsAnyAsync<IOException>(async () => await opening.WaitAsync(deadline.Token));
            Assert.DoesNotContain(Token, error.ToString());
            Assert.DoesNotContain("test-signature", error.ToString());
            Assert.False(redirect.Pending());
        }
    }
}
#endif
