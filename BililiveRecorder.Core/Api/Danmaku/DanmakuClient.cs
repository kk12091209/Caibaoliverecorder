using System;
using System.Buffers;
using System.Buffers.Binary;
using System.IO;
using System.IO.Compression;
using System.IO.Pipelines;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Timers;
using BililiveRecorder.Core.Config;
using Nerdbank.Streams;
using Newtonsoft.Json;
using Serilog;
using Timer = System.Timers.Timer;

namespace BililiveRecorder.Core.Api.Danmaku
{
    internal class DanmakuClient : IDanmakuClient, IDisposable
    {
        private readonly ILogger logger;
        private readonly IDanmakuServerApiClient apiClient;
        private readonly RuntimeCookie? runtimeCookie;
        private readonly Timer timer;
        private readonly SemaphoreSlim semaphoreSlim = new SemaphoreSlim(1, 1);
        private readonly Func<DanmakuTransportMode, string?, IDanmakuTransport> transportFactory;
        private readonly Func<long> now;
        private readonly TimeSpan authenticationTimeout;
        private readonly long heartbeatIntervalMs, heartbeatTimeoutMs;
        private readonly bool automaticHeartbeat;
        private Session? current;
        private volatile bool disposedValue;
        private int credentialVersion;

        // A receiver, timeout or cookie change may finish after the next socket
        // opens. Every callback owns its session and can only close that session.
        private sealed class Session
        {
            internal readonly object Sync = new object();
            internal readonly int RoomId, CredentialVersion;
            internal readonly CancellationTokenSource Lifetime;
            internal readonly CancellationToken Token;
            internal readonly TaskCompletionSource<bool> Authentication = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            internal IDanmakuTransport? Transport;
            internal PipeReader? Reader;
            internal bool Authenticated, Closed, FirstComment;
            internal long LastHeartbeat, LastPing;
            internal string? Failure;
            internal int? AuthenticationCode;
            private int stopped;
            internal Session(int roomId, int credentialVersion, CancellationToken cancellationToken)
            {
                this.RoomId = roomId; this.CredentialVersion = credentialVersion;
                this.Lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                this.Token = this.Lifetime.Token;
            }
            internal void StopIo()
            {
                if (Interlocked.Exchange(ref this.stopped, 1) == 0)
                {
                    this.Authentication.TrySetCanceled();
                    this.Lifetime.Cancel();
                    this.Lifetime.Dispose();
                }
                this.StopTransport();
            }
            internal void StopTransport()
            {
                try { this.Reader?.CancelPendingRead(); } catch (Exception) { }
                try { this.Transport?.Dispose(); } catch (Exception) { }
            }
        }

        public bool Connected
        {
            get { var session = this.current; if (session is null) return false; lock (session.Sync) return session.Authenticated && !session.Closed; }
        }
        public event EventHandler<StatusChangedEventArgs>? StatusChanged;
        public event EventHandler<DanmakuReceivedEventArgs>? DanmakuReceived;
        public Func<string, string?>? BeforeHandshake { get; set; }
        private static readonly JsonSerializerSettings jsonSerializerSettings = new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore };

        public DanmakuClient(IDanmakuServerApiClient apiClient, ILogger logger, RuntimeCookie? runtimeCookie = null)
            : this(apiClient, logger, runtimeCookie, CreateTransport) { }

        internal DanmakuClient(IDanmakuServerApiClient apiClient, ILogger logger, RuntimeCookie? runtimeCookie,
            Func<DanmakuTransportMode, string?, IDanmakuTransport> transportFactory, Func<long>? now = null,
            TimeSpan? authenticationTimeout = null, TimeSpan? heartbeatInterval = null, TimeSpan? heartbeatTimeout = null,
            bool automaticHeartbeat = true)
        {
            this.apiClient = apiClient ?? throw new ArgumentNullException(nameof(apiClient));
            this.logger = logger?.ForContext<DanmakuClient>() ?? throw new ArgumentNullException(nameof(logger));
            this.transportFactory = transportFactory;
            this.now = now ?? (() => (long)(System.Diagnostics.Stopwatch.GetTimestamp() * (1000d / System.Diagnostics.Stopwatch.Frequency)));
            this.authenticationTimeout = authenticationTimeout ?? TimeSpan.FromSeconds(10);
            this.heartbeatIntervalMs = (long)(heartbeatInterval ?? TimeSpan.FromSeconds(30)).TotalMilliseconds;
            this.heartbeatTimeoutMs = (long)(heartbeatTimeout ?? TimeSpan.FromSeconds(90)).TotalMilliseconds;
            this.automaticHeartbeat = automaticHeartbeat;
            this.timer = new Timer(1000) { AutoReset = true, Enabled = false };
            this.timer.Elapsed += this.SendPingMessageTimerCallback;
            this.runtimeCookie = runtimeCookie;
            if (runtimeCookie is not null) runtimeCookie.Changed += this.RuntimeCookie_Changed;
        }

        private static IDanmakuTransport CreateTransport(DanmakuTransportMode mode, string? bindAddress) => mode switch
        {
            DanmakuTransportMode.Tcp => new DanmakuTransportTcp(bindAddress),
            DanmakuTransportMode.Ws => new DanmakuTransportWebSocket(bindAddress),
            DanmakuTransportMode.Wss => new DanmakuTransportSecureWebSocket(bindAddress),
            _ => throw new ArgumentOutOfRangeException(nameof(mode))
        };

        // These fixed events are the only informational core lines retained by
        // the desktop log. Never include cookies, token, handshake or chat text.
        private void Lifecycle(Session session, string state, bool warning = false, int? code = null)
        {
            var level = warning ? Serilog.Events.LogEventLevel.Warning : Serilog.Events.LogEventLevel.Information;
            if (code.HasValue) this.logger.Write(level, "[DanmakuLifecycle] room={RoomId} event={State:l} code={Code}", session.RoomId, state, code.Value);
            else this.logger.Write(level, "[DanmakuLifecycle] room={RoomId} event={State:l}", session.RoomId, state);
        }

        private void RuntimeCookie_Changed(object? sender, EventArgs e)
        {
            Interlocked.Increment(ref this.credentialVersion);
            var session = this.current;
            if (session is null || this.disposedValue) return;
            session.Failure = "credentials-changed";
            session.StopIo();
            _ = this.CloseSessionAsync(session, "credentials-changed");
        }

        public async Task DisconnectAsync()
        {
            var session = this.current;
            if (session is null) return;
            session.StopIo(); // Also releases a connection still waiting for authentication.
            await this.CloseSessionAsync(session, "disconnected").ConfigureAwait(false);
        }

        // The semaphore is held by the caller. Status publication and detaching
        // use the session lock so a late authentication cannot publish success.
        private void Detach(Session session, string reason, bool warning)
        {
            lock (session.Sync)
            {
                if (!ReferenceEquals(this.current, session) || session.Closed) return;
                session.Closed = true;
                this.current = null;
                try { this.timer.Stop(); } catch (ObjectDisposedException) { }
                session.StopIo();
                this.Lifecycle(session, reason, warning, reason == "authentication-rejected" ? session.AuthenticationCode : null);
                if (session.Authenticated) this.StatusChanged?.Invoke(this, StatusChangedEventArgs.False);
            }
        }

        private async Task CloseSessionAsync(Session session, string reason, bool warning = false)
        {
            // Unblock ConnectAsync before waiting for its semaphore.
            session.Authentication.TrySetException(new IOException("弹幕连接在认证完成前结束。"));
            await this.semaphoreSlim.WaitAsync().ConfigureAwait(false);
            try { this.Detach(session, reason, warning); }
            finally { this.semaphoreSlim.Release(); }
        }

        public async Task ConnectAsync(int roomId, DanmakuTransportMode transportMode, string? bindAddress, AllowedAddressFamily allowedAddressFamily, CancellationToken cancellationToken)
        {
            if (this.disposedValue) throw new ObjectDisposedException(nameof(DanmakuClient));
            if (!Enum.IsDefined(typeof(DanmakuTransportMode), transportMode)) throw new ArgumentOutOfRangeException(nameof(transportMode));
            await this.semaphoreSlim.WaitAsync(cancellationToken).ConfigureAwait(false);
            Session? session = null;
            try
            {
                if (this.disposedValue) throw new ObjectDisposedException(nameof(DanmakuClient));
                if (this.current is not null) return;
                session = new Session(roomId, Volatile.Read(ref this.credentialVersion), cancellationToken);
                this.current = session;
                this.Lifecycle(session, "connecting");
                var serverInfo = await this.apiClient.GetDanmakuServerAsync(roomId).ConfigureAwait(false);
                session.Token.ThrowIfCancellationRequested();
                if (serverInfo.Data is null) throw new IOException("未获得弹幕服务器信息。");
                var server = serverInfo.Data.SelectDanmakuServer(transportMode);
                session.Transport = this.transportFactory(server.TransportMode, bindAddress);
                session.Reader = await session.Transport.ConnectAsync(server.Host, server.Port, allowedAddressFamily, session.Token).ConfigureAwait(false);
                session.Token.ThrowIfCancellationRequested();
                using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(session.Token))
                {
                    deadline.CancelAfter(this.authenticationTimeout);
                    using var registration = deadline.Token.Register(() => { session.Authentication.TrySetCanceled(); session.StopTransport(); });
                    _ = this.ReceiveAsync(session);
                    try
                    {
                        await this.SendHelloAsync(session, this.apiClient.GetUid(), this.apiClient.GetBuvid3(), server.Token ?? string.Empty, deadline.Token).ConfigureAwait(false);
                        await session.Authentication.Task.ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (!session.Token.IsCancellationRequested)
                    {
                        session.Failure = "authentication-timeout";
                        throw new IOException("弹幕认证等待超时，将重新连接。");
                    }
                    session.Token.ThrowIfCancellationRequested();
                }
                await this.SendHeartbeatAsync(session).ConfigureAwait(false);
                if (this.automaticHeartbeat) this.timer.Start();
            }
            catch
            {
                if (session is not null) this.Detach(session, session.Failure ?? (session.Token.IsCancellationRequested ? "disconnected" : "connect-failed"), !session.Token.IsCancellationRequested);
                throw;
            }
            finally { this.semaphoreSlim.Release(); }
        }

        private async Task ReceiveAsync(Session session)
        {
            var reason = "remote-closed";
            try { await ProcessDataAsync(session.Reader!, (action, body) => this.ProcessPacket(session, action, body), session.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) when (session.Token.IsCancellationRequested) { }
            catch (ObjectDisposedException) { }
            catch (Exception) { reason = "receive-failed"; } // Parser exceptions can contain remote payloads.
            finally
            {
                session.Authentication.TrySetException(new IOException("弹幕连接在认证完成前结束。"));
                await this.CloseSessionAsync(session, reason, reason == "receive-failed").ConfigureAwait(false);
            }
        }

        private void ProcessPacket(Session session, int action, string body)
        {
            lock (session.Sync)
            {
                if (session.Closed || session.Token.IsCancellationRequested || !ReferenceEquals(this.current, session)) return;
                if (action == 8 && !session.Authenticated)
                {
                    int? code = null;
                    try
                    {
                        var value = Newtonsoft.Json.Linq.JObject.Parse(body)["code"];
                        if (value?.Type == Newtonsoft.Json.Linq.JTokenType.Integer) code = (int)value;
                    }
                    catch (Exception) { }
                    if (code != 0 || session.CredentialVersion != Volatile.Read(ref this.credentialVersion))
                    {
                        session.Failure = code.HasValue ? "authentication-rejected" : "authentication-invalid";
                        session.AuthenticationCode = code;
                        session.Authentication.TrySetException(new IOException("弹幕认证未通过，将重新连接。"));
                        return;
                    }
                    session.Authenticated = true;
                    Interlocked.Exchange(ref session.LastHeartbeat, this.now());
                    this.Lifecycle(session, "authenticated");
                    this.StatusChanged?.Invoke(this, StatusChangedEventArgs.True);
                    session.Authentication.TrySetResult(true);
                }
                else if (action == 3 && session.Authenticated) Interlocked.Exchange(ref session.LastHeartbeat, this.now());
                else if (action == 5 && session.Authenticated)
                {
                    try
                    {
                        var message = new DanmakuModel(body);
                        if (!session.FirstComment && message.MsgType == DanmakuMsgType.Comment)
                        {
                            session.FirstComment = true;
                            this.Lifecycle(session, "first-comment");
                        }
                        this.DanmakuReceived?.Invoke(this, new DanmakuReceivedEventArgs(message));
                    }
                    catch (Exception) { this.Lifecycle(session, "message-invalid", true); }
                }
            }
        }

        private async Task SendHeartbeatAsync(Session session)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(session.Token);
            deadline.CancelAfter(this.authenticationTimeout);
            try { await this.SendMessageAsync(session, 2, string.Empty, deadline.Token).ConfigureAwait(false); session.LastPing = this.now(); }
            catch { session.Failure = "send-failed"; throw; }
        }

        internal async Task HeartbeatTickAsync()
        {
            if (this.disposedValue || !await this.semaphoreSlim.WaitAsync(0).ConfigureAwait(false)) return;
            try
            {
                var session = this.current;
                if (session is null || !session.Authenticated) return;
                lock (session.Sync)
                {
                    if (this.now() - session.LastHeartbeat >= this.heartbeatTimeoutMs)
                    {
                        this.Detach(session, "heartbeat-timeout", true);
                        return;
                    }
                }
                if (this.now() - session.LastPing < this.heartbeatIntervalMs) return;
                try { await this.SendHeartbeatAsync(session).ConfigureAwait(false); }
                catch (Exception) { this.Detach(session, "send-failed", true); }
            }
            finally { this.semaphoreSlim.Release(); }
        }

#pragma warning disable VSTHRD100 // Timer callbacks must contain their exceptions.
        private async void SendPingMessageTimerCallback(object? sender, ElapsedEventArgs e)
#pragma warning restore VSTHRD100
        {
            try { await this.HeartbeatTickAsync().ConfigureAwait(false); }
            catch (Exception) { /* A concurrent shutdown has already closed its session. */ }
        }

        public void Dispose()
        {
            this.disposedValue = true;
            this.timer.Dispose();
            if (this.runtimeCookie is not null) this.runtimeCookie.Changed -= this.RuntimeCookie_Changed;
            var session = Interlocked.Exchange(ref this.current, null);
            if (session is not null) lock (session.Sync) { session.Closed = true; session.StopIo(); }
            // Receivers/timer callbacks can still be draining; do not dispose
            // their semaphore while an asynchronous continuation owns it.
            GC.SuppressFinalize(this);
        }

        #region Send

        private Task SendHelloAsync(Session session, long uid, string? buvid, string token, CancellationToken cancellationToken)
        {
            var body = JsonConvert.SerializeObject(new
            {
                uid,
                roomid = session.RoomId,
                protover = 3,
                buvid,
                platform = "web",
                type = 2,
                key = token,
            }, Formatting.None, jsonSerializerSettings);

            if (!(this.runtimeCookie?.Enabled == true && this.runtimeCookie.Configured) && this.BeforeHandshake is { } func)
            {
                var newBody = func(body);
                if (newBody is not null)
                {
                    this.logger.Debug("已应用弹幕握手脚本");
                    body = newBody;
                }
            }

            return this.SendMessageAsync(session, 7, body, cancellationToken);
        }

        private async Task SendMessageAsync(Session session, int action, string body, CancellationToken cancellationToken)
        {
            var transport = session.Transport ?? throw new IOException("弹幕连接已关闭。");

            var payload = Encoding.UTF8.GetBytes(body);
            const int headerLength = 16;
            var totalLength = payload.Length + headerLength;

            var buffer = ArrayPool<byte>.Shared.Rent(totalLength);
            try
            {
                BinaryPrimitives.WriteUInt32BigEndian(new Span<byte>(buffer, 0, 4), (uint)totalLength);
                BinaryPrimitives.WriteUInt16BigEndian(new Span<byte>(buffer, 4, 2), headerLength);
                BinaryPrimitives.WriteUInt16BigEndian(new Span<byte>(buffer, 6, 2), 1);
                BinaryPrimitives.WriteUInt32BigEndian(new Span<byte>(buffer, 8, 4), (uint)action);
                BinaryPrimitives.WriteUInt32BigEndian(new Span<byte>(buffer, 12, 4), 1);

                if (payload.Length > 0)
                    Array.Copy(payload, 0, buffer, headerLength, payload.Length);

                await transport.SendAsync(buffer, 0, totalLength, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }

        #endregion

        #region Receive

        private static async Task ProcessDataAsync(PipeReader reader, Action<int, string> callback, CancellationToken cancellationToken)
        {
            try
            {
                while (true)
                {
                    var result = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
                    var buffer = result.Buffer;
                    while (TryParseCommand(ref buffer, callback)) { }
                    reader.AdvanceTo(buffer.Start, buffer.End);
                    if (result.IsCompleted)
                    {
                        if (!buffer.IsEmpty) throw new InvalidDataException("弹幕连接在数据包完成前关闭。");
                        break;
                    }
                }
            }
            finally { await reader.CompleteAsync().ConfigureAwait(false); }
        }

        private static bool TryParseCommand(ref ReadOnlySequence<byte> buffer, Action<int, string> callback)
        {
            if (buffer.Length < 4)
                return false;

            int length;
            {
                var lengthSlice = buffer.Slice(buffer.Start, 4);
                if (lengthSlice.IsSingleSegment)
                {
                    length = BinaryPrimitives.ReadInt32BigEndian(lengthSlice.First.Span);
                }
                else
                {
                    Span<byte> stackBuffer = stackalloc byte[4];
                    lengthSlice.CopyTo(stackBuffer);
                    length = BinaryPrimitives.ReadInt32BigEndian(stackBuffer);
                }
            }

            if (length < 16 || length > 16 * 1024 * 1024) throw new InvalidDataException("弹幕数据包长度无效。");
            if (buffer.Length < length)
                return false;

            var headerSlice = buffer.Slice(buffer.Start, 16);

            DanmakuProtocol header;
            if (headerSlice.IsSingleSegment)
            {
                Parse2Protocol(headerSlice.First.Span, out header);
            }
            else
            {
                Span<byte> stackBuffer = stackalloc byte[16];
                headerSlice.CopyTo(stackBuffer);
                Parse2Protocol(stackBuffer, out header);
            }

            if (header.HeaderLength < 16 || header.HeaderLength > length) throw new InvalidDataException("弹幕数据包头无效。");
            var bodySlice = buffer.Slice(header.HeaderLength, length - header.HeaderLength);
            buffer = buffer.Slice(length);

            if (header.Version == 2 && header.Action == 5)
            {
                using var deflate = new DeflateStream(bodySlice.Slice(2, bodySlice.End).AsStream(), CompressionMode.Decompress, leaveOpen: false);
                ParseCommandCompressedBody(deflate, callback);
            }
            else if (header.Version == 3 && header.Action == 5)
            {
#if NET6_0_OR_GREATER
                using var brotli = new BrotliStream(bodySlice.AsStream(), CompressionMode.Decompress, leaveOpen: false);
#else
                using var brotli = new BrotliSharpLib.BrotliStream(bodySlice.AsStream(), CompressionMode.Decompress, leaveOpen: false);
#endif
                ParseCommandCompressedBody(brotli, callback);
            }
            else
                ParseCommandNormalBody(ref bodySlice, header.Action, callback);

            return true;
        }

        private static void ParseCommandCompressedBody(Stream decompressed, Action<int, string> callback)
        {
            var reader = PipeReader.Create(decompressed);
            while (true)
            {
#pragma warning disable VSTHRD002 // Avoid problematic synchronous waits
                // 全内存内运行同步返回，所以不会有问题
                var result = reader.ReadAsync().Result;
#pragma warning restore VSTHRD002 // Avoid problematic synchronous waits
                var inner_buffer = result.Buffer;

                while (TryParseCommand(ref inner_buffer, callback)) { }

                reader.AdvanceTo(inner_buffer.Start, inner_buffer.End);

                if (result.IsCompleted)
                    break;
            }
            reader.Complete();
        }

        private static void ParseCommandNormalBody(ref ReadOnlySequence<byte> buffer, int action, Action<int, string> callback)
        {
            switch (action)
            {
                case 5:
                case 8:
                    {
                        if (buffer.Length > int.MaxValue)
                            throw new ArgumentOutOfRangeException(nameof(buffer), "ParseCommandNormalBody buffer length larger than int.MaxValue");

                        var b = ArrayPool<byte>.Shared.Rent((int)buffer.Length);
                        try
                        {
                            buffer.CopyTo(b);
                            var json = Encoding.UTF8.GetString(b, 0, (int)buffer.Length);
                            callback(action, json);
                        }
                        finally
                        {
                            ArrayPool<byte>.Shared.Return(b);
                        }
                    }
                    break;
                case 3:
                    if (buffer.Length != 4) throw new InvalidDataException("弹幕心跳回应无效。");
                    callback(3, string.Empty);
                    break;
                default:
                    break;
            }
        }

        private static unsafe void Parse2Protocol(ReadOnlySpan<byte> buffer, out DanmakuProtocol protocol)
        {
            fixed (byte* ptr = buffer)
            {
                protocol = *(DanmakuProtocol*)ptr;
            }
            protocol.ChangeEndian();
        }

        private struct DanmakuProtocol
        {
            /// <summary>
            /// 消息总长度 (协议头 + 数据长度)
            /// </summary>
            public int PacketLength;
            /// <summary>
            /// 消息头长度 (固定为16[sizeof(DanmakuProtocol)])
            /// </summary>
            public short HeaderLength;
            /// <summary>
            /// 消息版本号
            /// </summary>
            public short Version;
            /// <summary>
            /// 消息类型
            /// </summary>
            public int Action;
            /// <summary>
            /// 参数, 固定为1
            /// </summary>
            public int Parameter;
            /// <summary>
            /// 转为本机字节序
            /// </summary>
            public void ChangeEndian()
            {
                this.PacketLength = IPAddress.HostToNetworkOrder(this.PacketLength);
                this.HeaderLength = IPAddress.HostToNetworkOrder(this.HeaderLength);
                this.Version = IPAddress.HostToNetworkOrder(this.Version);
                this.Action = IPAddress.HostToNetworkOrder(this.Action);
                this.Parameter = IPAddress.HostToNetworkOrder(this.Parameter);
            }
        }

        #endregion
    }
}
