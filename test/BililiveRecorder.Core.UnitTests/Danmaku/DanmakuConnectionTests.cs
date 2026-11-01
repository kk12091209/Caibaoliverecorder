using System;
using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.IO.Pipelines;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Authentication;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using BililiveRecorder.Core.Api;
using BililiveRecorder.Core.Api.Danmaku;
using BililiveRecorder.Core.Api.Model;
using BililiveRecorder.Core.Config;
using Serilog;
using Serilog.Core;
using Serilog.Events;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Danmaku
{
    public class DanmakuConnectionTests
    {
        private sealed class Api : IDanmakuServerApiClient, IApiClient
        {
            internal Exception? Failure;
            internal int Requests;
            public Task<BilibiliApiResponse<RoomInfo>> GetRoomInfoAsync(int roomid) => throw new NotSupportedException();
            public Task<BilibiliApiResponse<RoomPlayInfo>> GetStreamUrlAsync(int roomid, int quality) => throw new NotSupportedException();
            public long GetUid() => 123;
            public string GetBuvid3() => "synthetic-device-secret";
            public Task<BilibiliApiResponse<DanmuInfo>> GetDanmakuServerAsync(int roomid)
            {
                this.Requests++;
                return this.Failure is not null ? Task.FromException<BilibiliApiResponse<DanmuInfo>>(this.Failure) : Task.FromResult(new BilibiliApiResponse<DanmuInfo> {
                    Code = 0, Data = new DanmuInfo { Token = "synthetic-token-secret", HostList = new[] { new DanmuInfo.HostListItem { Host = "fixture.invalid", WssPort = 443 } } }
                });
            }
            public void Dispose() { }
        }
        private sealed class Sink : ILogEventSink
        {
            private readonly List<string> messages = new List<string>();
            public void Emit(LogEvent logEvent) { lock (this.messages) this.messages.Add(logEvent.RenderMessage()); }
            public string Text { get { lock (this.messages) return string.Join("\n", this.messages); } }
        }
        private sealed class DelayedReader : PipeReader
        {
            private readonly PipeReader inner;
            internal readonly TaskCompletionSource<bool> Release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            internal DelayedReader(PipeReader inner) { this.inner = inner; }
            public override void AdvanceTo(SequencePosition consumed) => this.inner.AdvanceTo(consumed);
            public override void AdvanceTo(SequencePosition consumed, SequencePosition examined) => this.inner.AdvanceTo(consumed, examined);
            public override void CancelPendingRead() => this.inner.CancelPendingRead();
            public override void Complete(Exception? exception = null) => this.inner.Complete(exception);
            public override async ValueTask CompleteAsync(Exception? exception = null) { await this.Release.Task; await this.inner.CompleteAsync(exception); }
            public override ValueTask<ReadResult> ReadAsync(CancellationToken cancellationToken = default) => this.inner.ReadAsync(cancellationToken);
            public override bool TryRead(out ReadResult result) => this.inner.TryRead(out result);
        }
        private sealed class Transport : IDanmakuTransport
        {
            internal readonly Pipe Input = new Pipe();
            internal readonly TaskCompletionSource<bool> Hello = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            internal readonly List<int> Sent = new List<int>();
            internal bool AutoAuth = true, AutoPong = true, FailPing, Disposed, StallHello;
            internal Exception? ConnectFailure;
            internal DelayedReader? Delayed;
            public Task<PipeReader> ConnectAsync(string host, int port, AllowedAddressFamily family, CancellationToken token) => this.ConnectFailure is not null ? Task.FromException<PipeReader>(this.ConnectFailure) : Task.FromResult<PipeReader>(this.Delayed ?? this.Input.Reader);
            public async Task SendAsync(byte[] buffer, int offset, int count, CancellationToken token = default)
            {
                token.ThrowIfCancellationRequested();
                int action = BinaryPrimitives.ReadInt32BigEndian(buffer.AsSpan(offset + 8, 4));
                lock (this.Sent) this.Sent.Add(action);
                if (action == 7) { this.Hello.TrySetResult(true); if (this.StallHello) await Task.Delay(Timeout.Infinite, token); if (this.AutoAuth) await this.Packet(8, "{\"code\":0}"); }
                if (action == 2) { if (this.FailPing) throw new IOException("synthetic-send-secret"); if (this.AutoPong) await this.Bytes(Frame(3, new byte[4])); }
            }
            internal async Task Bytes(byte[] bytes) { await this.Input.Writer.WriteAsync(bytes); }
            internal Task Packet(int action, string json) => this.Bytes(Frame(action, Encoding.UTF8.GetBytes(json)));
            public void Dispose() { this.Disposed = true; this.Input.Reader.CancelPendingRead(); }
        }
        private sealed class Fixture : IDisposable
        {
            internal readonly Sink Sink = new Sink();
            internal readonly Api Api = new Api();
            internal readonly Queue<Transport> Transports = new Queue<Transport>();
            internal readonly List<bool> States = new List<bool>();
            internal readonly DanmakuClient Client;
            internal long Now;
            internal Fixture(RuntimeCookie? cookie = null, int timeoutMs = 1000)
            {
                this.Client = new DanmakuClient(this.Api, new LoggerConfiguration().WriteTo.Sink(this.Sink).CreateLogger(), cookie,
                    (_, _) => this.Transports.Dequeue(), () => Interlocked.Read(ref this.Now),
                    authenticationTimeout: TimeSpan.FromMilliseconds(timeoutMs), heartbeatInterval: TimeSpan.FromMilliseconds(30),
                    heartbeatTimeout: TimeSpan.FromMilliseconds(90), automaticHeartbeat: false);
                this.Client.StatusChanged += (_, e) => { lock (this.States) this.States.Add(e.Connected); };
            }
            internal Task Connect() => this.Client.ConnectAsync(25034104, DanmakuTransportMode.Wss, null, AllowedAddressFamily.System, CancellationToken.None);
            public void Dispose() => this.Client.Dispose();
        }
        private static byte[] Frame(int action, byte[] body, int version = 1)
        {
            var bytes = new byte[16 + body.Length]; BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(0, 4), bytes.Length);
            BinaryPrimitives.WriteInt16BigEndian(bytes.AsSpan(4, 2), 16); BinaryPrimitives.WriteInt16BigEndian(bytes.AsSpan(6, 2), (short)version);
            BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(8, 4), action); BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(12, 4), 1);
            body.CopyTo(bytes, 16); return bytes;
        }
        private static async Task Until(Func<bool> ready)
        {
            var end = DateTime.UtcNow.AddSeconds(5);
            while (!ready() && DateTime.UtcNow < end) await Task.Delay(5);
            Assert.True(ready(), "Asynchronous connection state did not arrive");
        }
        private const string Comment = "{\"cmd\":\"DANMU_MSG\",\"info\":[[0,1,25,16777215,1700000000000],\"synthetic-chat-secret\",[123,\"synthetic-user-secret\",0,0,0,0,0,\"\"],[],[],[],[],0]}";

        [Fact]
        public async Task ApiFailureKeepsSafeStageAndCodeAndCanRecoverWithoutPublishingTheBody()
        {
            using var f = new Fixture();
            f.Api.Failure = new BilibiliApiResponseCodeNotZeroException(-352, "synthetic-body-secret https://example.invalid/?token=synthetic-token-secret");
            await Assert.ThrowsAsync<BilibiliApiResponseCodeNotZeroException>(() => f.Connect());
            Assert.Contains("event=connect-failed code=-352 stage=server-info kind=api elapsed_ms=0", f.Sink.Text);
            Assert.DoesNotContain("synthetic-body-secret", f.Sink.Text); Assert.DoesNotContain("synthetic-token-secret", f.Sink.Text);
            Assert.False(f.Client.Connected); Assert.Empty(f.States);
            f.Api.Failure = null; f.Transports.Enqueue(new Transport()); await f.Connect(); Assert.True(f.Client.Connected);
        }

        [Fact]
        public async Task SocketFailureIsDistinguishedFromTheApiAndCanRetry()
        {
            using var f = new Fixture();
            f.Transports.Enqueue(new Transport { ConnectFailure = new WebSocketException("synthetic-socket-secret", new SocketException((int)SocketError.HostNotFound)) });
            await Assert.ThrowsAsync<WebSocketException>(() => f.Connect());
            Assert.Contains("event=connect-failed code=11001 stage=socket kind=dns elapsed_ms=0", f.Sink.Text);
            Assert.DoesNotContain("synthetic-socket-secret", f.Sink.Text);
            f.Transports.Enqueue(new Transport()); await f.Connect(); Assert.True(f.Client.Connected);
        }

        [Fact]
        public void ConnectionFailureCategoriesNeverNeedExceptionMessages()
        {
            Assert.Equal(("http", (int?)412), DanmakuClient.DescribeConnectionFailure(new Http412Exception("private-url")));
            Assert.Equal(("api-paused", (int?)null), DanmakuClient.DescribeConnectionFailure(new Polly.CircuitBreaker.BrokenCircuitException("private-circuit-detail")));
            Assert.Equal(("timeout", (int?)null), DanmakuClient.DescribeConnectionFailure(new TaskCanceledException("private-timeout-detail")));
            Assert.Equal(("tls", (int?)null), DanmakuClient.DescribeConnectionFailure(new WebSocketException("private-url", new AuthenticationException("private-cert-detail"))));
            Assert.Equal(("invalid-response", (int?)null), DanmakuClient.DescribeConnectionFailure(new Newtonsoft.Json.JsonReaderException("private-body")));
#if NET8_0_OR_GREATER
            Assert.Equal(("http", (int?)403), DanmakuClient.DescribeConnectionFailure(new WebSocketException("private-url", new HttpRequestException("private-body", null, HttpStatusCode.Forbidden))));
#endif
        }

        [Fact]
        public async Task RepeatedApiErrorsCanKeepRequestsPausedAfterTheProviderRecoversAsync()
        {
            var provider = new Api { Failure = new BilibiliApiResponseCodeNotZeroException(-352, "synthetic-body-secret") };
            var policies = new PollyPolicy();
            using var client = new PolicyWrappedApiClient<Api>(provider, policies);
            try
            {
                for (var attempt = 0; attempt < 3; attempt++)
                    await Assert.ThrowsAsync<BilibiliApiResponseCodeNotZeroException>(() => client.GetDanmakuServerAsync(1852631778));
                Assert.Equal(6, provider.Requests);
                Assert.Equal(Polly.CircuitBreaker.CircuitState.Open, policies.RequestFailedCircuitBreakerPolicy.CircuitState);
                provider.Failure = null;
                await Assert.ThrowsAsync<Polly.CircuitBreaker.BrokenCircuitException>(() => client.GetDanmakuServerAsync(1852631778));
                Assert.Equal(6, provider.Requests); // No new provider call until the protection period expires.
            }
            finally { policies.memoryCache.Dispose(); }
        }

        [Fact]
        public async Task SocketAloneIsNotConnectedAndFragmentedAuthPrecedesChatWithoutLoggingPayloads()
        {
            using var f = new Fixture(); var transport = new Transport { AutoAuth = false }; f.Transports.Enqueue(transport);
            int received = 0; f.Client.DanmakuReceived += (_, _) => Interlocked.Increment(ref received);
            var connect = f.Connect(); await transport.Hello.Task;
            Assert.False(f.Client.Connected); Assert.Empty(f.States); Assert.Equal(new[] { 7 }, transport.Sent);
            var packet = Frame(8, Encoding.UTF8.GetBytes("{\"code\":0}"));
            await transport.Bytes(packet.Take(3).ToArray()); await transport.Bytes(packet.Skip(3).Concat(Frame(5, Encoding.UTF8.GetBytes(Comment))).ToArray());
            await connect; await Until(() => received == 1); await transport.Packet(5, Comment); await Until(() => received == 2);
            Assert.True(f.Client.Connected); Assert.Equal(new[] { true }, f.States);
            Assert.Equal(1, f.Sink.Text.Split(new[] { "event=first-comment" }, StringSplitOptions.None).Length - 1);
            foreach (var secret in new[] { "synthetic-device-secret", "synthetic-token-secret", "synthetic-chat-secret", "synthetic-user-secret" }) Assert.DoesNotContain(secret, f.Sink.Text);
        }

        [Theory]
        [InlineData("{\"code\":-101,\"message\":\"synthetic-error-secret\"}", "authentication-rejected")]
        [InlineData("{\"code\":\"0\"}", "authentication-invalid")]
        [InlineData("{\"other\":0}", "authentication-invalid")]
        [InlineData("not-json synthetic-error-secret", "authentication-invalid")]
        public async Task RejectedOrMalformedAuthenticationClosesOnlyChatAndCanRetry(string reply, string reason)
        {
            using var f = new Fixture(); var failed = new Transport { AutoAuth = false }; f.Transports.Enqueue(failed);
            var connect = f.Connect(); await failed.Hello.Task; await failed.Packet(8, reply);
            await Assert.ThrowsAsync<IOException>(() => connect); Assert.False(f.Client.Connected); Assert.True(failed.Disposed); Assert.Empty(f.States);
            Assert.Contains("event=" + reason, f.Sink.Text); Assert.DoesNotContain("synthetic-error-secret", f.Sink.Text);
            f.Transports.Enqueue(new Transport()); await f.Connect(); Assert.True(f.Client.Connected); Assert.Equal(new[] { true }, f.States);
        }

        [Fact]
        public async Task MissingAuthenticationTimesOutEvenWhenOtherPacketsKeepArriving()
        {
            using var f = new Fixture(timeoutMs: 200); var transport = new Transport { AutoAuth = false }; f.Transports.Enqueue(transport);
            var connect = f.Connect(); await transport.Hello.Task;
            await transport.Bytes(Frame(3, new byte[4])); await transport.Packet(5, Comment);
            await Assert.ThrowsAsync<IOException>(() => connect); Assert.True(transport.Disposed); Assert.False(f.Client.Connected); Assert.Empty(f.States);
            Assert.Contains("event=authentication-timeout", f.Sink.Text);
        }

        [Fact]
        public async Task ABlockedHandshakeWriteAlsoHasAnAuthenticationDeadline()
        {
            using var f = new Fixture(timeoutMs: 200); var transport = new Transport { StallHello = true, AutoAuth = false }; f.Transports.Enqueue(transport);
            await Assert.ThrowsAsync<IOException>(() => f.Connect()); Assert.False(f.Client.Connected); Assert.True(transport.Disposed);
            Assert.Contains("event=authentication-timeout", f.Sink.Text);
        }

        [Fact]
        public async Task ReconnectDoesNotReuseThePreviousAuthenticationTokenResponse()
        {
            using var api = new PolicyWrappedApiClient<Api>(new Api(), new PollyPolicy());
            var first = await api.GetDanmakuServerAsync(25034104);
            var second = await api.GetDanmakuServerAsync(25034104);
            Assert.NotSame(first, second);
        }

        [Fact]
        public async Task QuietRoomWithHealthyHeartbeatStaysConnectedThenMissingPongDisconnectsOnce()
        {
            using var f = new Fixture(); var transport = new Transport(); f.Transports.Enqueue(transport); await f.Connect();
            for (int n = 1; n <= 8; n++)
            {
                f.Now = n * 30; await f.Client.HeartbeatTickAsync(); await Task.Delay(10);
                Assert.True(f.Client.Connected);
            }
            transport.AutoPong = false; f.Now = 270; await f.Client.HeartbeatTickAsync(); f.Now = 329; await f.Client.HeartbeatTickAsync(); Assert.True(f.Client.Connected);
            f.Now = 330; await f.Client.HeartbeatTickAsync(); await f.Client.HeartbeatTickAsync();
            Assert.False(f.Client.Connected); Assert.Equal(new[] { true, false }, f.States); Assert.Contains("event=heartbeat-timeout", f.Sink.Text);
            f.Transports.Enqueue(new Transport()); await f.Connect(); Assert.Equal(new[] { true, false, true }, f.States);
        }

        [Fact]
        public async Task LateOldReceiverCannotCloseTheRecoveredSession()
        {
            using var f = new Fixture(); var old = new Transport { AutoPong = false }; old.Delayed = new DelayedReader(old.Input.Reader); f.Transports.Enqueue(old);
            await f.Connect(); f.Now = 90; await f.Client.HeartbeatTickAsync(); Assert.False(f.Client.Connected);
            var next = new Transport(); f.Transports.Enqueue(next); await f.Connect(); old.Delayed.Release.TrySetResult(true); await Task.Delay(50);
            Assert.True(f.Client.Connected); Assert.False(next.Disposed); Assert.Equal(new[] { true, false, true }, f.States);
        }

        [Fact]
        public async Task FailedHeartbeatSendAndAbruptEofRecoverWithoutASecondDisconnect()
        {
            using var f = new Fixture(); var first = new Transport(); f.Transports.Enqueue(first); await f.Connect();
            first.FailPing = true; f.Now = 30; await f.Client.HeartbeatTickAsync(); Assert.False(f.Client.Connected);
            var next = new Transport(); f.Transports.Enqueue(next); await f.Connect(); await next.Input.Writer.CompleteAsync();
            await Until(() => !f.Client.Connected); Assert.Equal(new[] { true, false, true, false }, f.States);
            Assert.Contains("event=send-failed", f.Sink.Text); Assert.Contains("event=remote-closed", f.Sink.Text); Assert.DoesNotContain("synthetic-send-secret", f.Sink.Text);
        }

        [Fact]
        public async Task CookieChangeDuringAuthenticationCancelsOnlyTheOldHandshake()
        {
            var cookie = new RuntimeCookie(true); using var f = new Fixture(cookie); var first = new Transport { AutoAuth = false }; f.Transports.Enqueue(first);
            var connect = f.Connect(); await first.Hello.Task; cookie.Set("SESSDATA=synthetic-cookie-secret; DedeUserID=123");
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => connect);
            f.Transports.Enqueue(new Transport()); await f.Connect(); await Task.Delay(30);
            Assert.True(first.Disposed); Assert.True(f.Client.Connected); Assert.DoesNotContain("synthetic-cookie-secret", f.Sink.Text);
        }

        [Fact]
        public async Task ExplicitDisconnectCanCancelAnUnacknowledgedHandshake()
        {
            using var f = new Fixture(); var transport = new Transport { AutoAuth = false }; f.Transports.Enqueue(transport);
            var connect = f.Connect(); await transport.Hello.Task; await f.Client.DisconnectAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => connect); Assert.False(f.Client.Connected); Assert.True(transport.Disposed);
        }

        [Theory]
        [InlineData(0)]
        [InlineData(15)]
        [InlineData(16777217)]
        public async Task InvalidPacketLengthClosesTheConnectionInsteadOfSpinning(int length)
        {
            using var f = new Fixture(); var transport = new Transport(); f.Transports.Enqueue(transport); await f.Connect();
            var bytes = new byte[16]; BinaryPrimitives.WriteInt32BigEndian(bytes, length); await transport.Bytes(bytes);
            await Until(() => !f.Client.Connected); Assert.Contains("event=receive-failed", f.Sink.Text);
        }

#if NET8_0_OR_GREATER
        private static byte[] Compressed(byte[] bytes, bool zlib = false)
        {
            using var output = new MemoryStream();
            using (Stream zip = zlib ? new ZLibStream(output, CompressionLevel.Fastest, true) : new BrotliStream(output, CompressionLevel.Fastest, true))
                zip.Write(bytes, 0, bytes.Length);
            return Frame(5, output.ToArray(), zlib ? 2 : 3);
        }

        [Theory]
        [InlineData("depth")]
        [InlineData("packets")]
        [InlineData("bytes")]
        [InlineData("truncated")]
        public async Task CompressedBudgetsCloseOnlyTheInvalidConnectionAsync(string problem)
        {
            using var f = new Fixture(); var transport = new Transport(); f.Transports.Enqueue(transport); int count = 0;
            f.Client.DanmakuReceived += (_, _) => Interlocked.Increment(ref count); await f.Connect();
            var valid = Frame(5, Encoding.UTF8.GetBytes(Comment));
            byte[] packet;
            if (problem == "depth")
            {
                packet = valid;
                for (int i = 0; i < 5; i++) packet = Compressed(packet, i % 2 == 0);
            }
            else
            {
                using var payload = new MemoryStream();
                var item = problem == "bytes" ? Frame(4, new byte[1024 * 1024]) : Frame(4, Array.Empty<byte>());
                int repeat = problem == "bytes" ? 33 : problem == "packets" ? 10001 : 1;
                for (int i = 0; i < repeat; i++) payload.Write(item, 0, item.Length);
                if (problem == "truncated") payload.WriteByte(0);
                else payload.Write(valid, 0, valid.Length);
                packet = Compressed(payload.ToArray());
            }
            await transport.Bytes(packet);
            if (problem == "truncated") await transport.Bytes(valid);
            await Until(() => !f.Client.Connected || Volatile.Read(ref count) > 0);
            Assert.False(f.Client.Connected);
            Assert.Contains("event=receive-failed", f.Sink.Text);
            var recovered = new Transport(); f.Transports.Enqueue(recovered); await f.Connect();
            await recovered.Bytes(Compressed(valid, true)); await Until(() => Volatile.Read(ref count) > 0);
            Assert.True(f.Client.Connected);
        }

        [Fact]
        public async Task CompressedBudgetResetsForEachOuterPacketAsync()
        {
            using var f = new Fixture(); var transport = new Transport(); f.Transports.Enqueue(transport); int count = 0;
            f.Client.DanmakuReceived += (_, _) => Interlocked.Increment(ref count); await f.Connect();
            using var payload = new MemoryStream(); var ignored = Frame(4, Array.Empty<byte>());
            for (int i = 0; i < 6000; i++) payload.Write(ignored, 0, ignored.Length);
            var valid = Frame(5, Encoding.UTF8.GetBytes(Comment)); payload.Write(valid, 0, valid.Length);
            await transport.Bytes(Compressed(payload.ToArray()));
            await transport.Bytes(Compressed(payload.ToArray(), true));
            await Until(() => Volatile.Read(ref count) == 2); Assert.True(f.Client.Connected);
        }

        [Fact]
        public async Task BrotliMessagesContinueThroughTheAuthenticatedConnection()
        {
            using var f = new Fixture(); var transport = new Transport(); f.Transports.Enqueue(transport); int count = 0;
            f.Client.DanmakuReceived += (_, _) => Interlocked.Increment(ref count); await f.Connect();
            using var output = new MemoryStream();
            using (var zip = new BrotliStream(output, CompressionLevel.Fastest, true)) { var bytes = Frame(5, Encoding.UTF8.GetBytes(Comment)); await zip.WriteAsync(bytes); }
            await transport.Bytes(Frame(5, output.ToArray(), 3)); await Until(() => count == 1); Assert.True(f.Client.Connected);
        }
#endif
    }
}
