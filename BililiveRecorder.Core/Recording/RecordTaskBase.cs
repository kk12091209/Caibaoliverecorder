using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Timers;
using BililiveRecorder.Core.Api;
using BililiveRecorder.Core.Config;
using BililiveRecorder.Core.Event;
using BililiveRecorder.Core.Scripting;
using BililiveRecorder.Core.Templating;
using Serilog;
using Timer = System.Timers.Timer;

namespace BililiveRecorder.Core.Recording
{
    internal abstract class RecordTaskBase : IRecordTask
    {
        private const string HttpHeaderAccept = "*/*";
        private const string HttpHeaderOrigin = Api.Http.HttpApiClient.HttpHeaderOrigin;
        private const string HttpHeaderReferer = Api.Http.HttpApiClient.HttpHeaderReferer;
        private const string HttpHeaderUserAgent = Api.Http.HttpApiClient.HttpHeaderUserAgent;

        private const int timer_inverval = 2;
        protected readonly Timer timer = new Timer(1000 * timer_inverval);
        protected readonly Random random = new Random();
        protected readonly CancellationTokenSource cts = new CancellationTokenSource();
        protected readonly CancellationToken ct;

        protected readonly IRoom room;
        protected readonly ILogger logger;
        protected readonly IApiClient apiClient;
        private readonly FileNameGenerator fileNameGenerator;
        private readonly UserScriptRunner userScriptRunner;

        private int partIndex = 0;

        protected string? streamHost;
        protected string? streamHostFull;
        protected bool started = false;
        protected bool timeoutTriggered = false;
        protected int qn;

        private readonly object ioStatsLock = new();
        protected int ioNetworkDownloadedBytes;

        protected Stopwatch ioDiskStopwatch = new();
        protected object ioDiskStatsLock = new();
        protected TimeSpan ioDiskWriteDuration;
        protected int ioDiskWrittenBytes;

        private DateTimeOffset ioStatsLastTrigger;
        protected readonly Stopwatch progressClock = new();
        protected readonly RecordingProgressWatchdog progressWatchdog = new();
        protected virtual bool TracksMediaProgress => false;

        protected RecordTaskBase(IRoom room, ILogger logger, IApiClient apiClient, UserScriptRunner userScriptRunner)
        {
            this.room = room ?? throw new ArgumentNullException(nameof(room));
            this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
            this.apiClient = apiClient ?? throw new ArgumentNullException(nameof(apiClient));
            this.userScriptRunner = userScriptRunner ?? throw new ArgumentNullException(nameof(userScriptRunner));

            this.fileNameGenerator = new FileNameGenerator(room.RoomConfig, logger);
            this.ct = this.cts.Token;

            this.timer.Elapsed += this.Timer_Elapsed_TriggerIOStats;
        }

        public Guid SessionId { get; } = Guid.NewGuid();

        public int Qn => this.qn;
        public bool HasRecordedOutput => this.progressWatchdog.HasRecordedOutput;

        #region Events

        public event EventHandler<IOStatsEventArgs>? IOStats;
        public event EventHandler<RecordingStatsEventArgs>? RecordingStats;
        public event EventHandler<RecordFileOpeningEventArgs>? RecordFileOpening;
        public event EventHandler<RecordFileClosedEventArgs>? RecordFileClosed;
        public event EventHandler? RecordSessionEnded;

        protected void OnIOStats(IOStatsEventArgs e) => IOStats?.Invoke(this, e);
        protected void OnRecordingStats(RecordingStatsEventArgs e) => RecordingStats?.Invoke(this, e);
        protected void OnRecordFileOpening(RecordFileOpeningEventArgs e) => RecordFileOpening?.Invoke(this, e);
        protected void OnRecordFileClosed(RecordFileClosedEventArgs e) => RecordFileClosed?.Invoke(this, e);
        protected void OnRecordSessionEnded(EventArgs e) => RecordSessionEnded?.Invoke(this, e);

        #endregion

        public virtual void RequestStop() => this.cts.Cancel();

        public virtual void SplitOutput() { }

        public async virtual Task StartAsync()
        {
            if (this.started)
                throw new InvalidOperationException("Only one StartAsync call allowed per instance.");
            this.started = true;

            var token = Environment.GetEnvironmentVariable("BREC_HLS_TOKEN");
            var relay = BilibiliHlsRelay.ResolveEndpoint(Environment.GetEnvironmentVariable("BREC_HLS_ENDPOINT"),
                token, this.room.RoomConfig.WebHookUrlsV2);
            var source = await this.FetchStreamUrlAsync(this.room.RoomConfig.RoomId, relay != null).ConfigureAwait(false);
            this.ct.ThrowIfCancellationRequested();
            var fullUrl = source.Url;
            var codecQn = source.Requested with { Qn = source.CurrentQn };
            this.selectedRouteHost = source.Route;

            this.qn = codecQn.Qn;
            this.streamHost = new Uri(fullUrl).Host;
            var qnDesc = StreamQualityNumber.MapToString(codecQn.Qn);

            this.logger.Information("连接直播服务器 {Host} 录制画质 {Qn} ({QnDescription})", this.streamHost, codecQn, qnDesc);

            Stream stream;
            try
            {
                var timeout = (int)this.room.RoomConfig.TimingStreamConnect;
                if (source.IsHls)
                {
                    this.logger.Information("使用 HLS 线路录制，保留原始音视频编码");
                    this.streamHostFull = this.streamHost;
                    stream = await BilibiliHlsRelay.OpenAsync(relay!, token!, this.room.RoomConfig.RoomId, fullUrl,
                        Math.Max(30000, timeout), this.ct).ConfigureAwait(false);
                }
                else
                    stream = await this.GetStreamAsync(fullUrl, timeout).ConfigureAwait(false);
            }
            catch (Exception) when (!this.ct.IsCancellationRequested) { this.MarkStreamRouteFailed(); throw; }

            this.ioStatsLastTrigger = DateTimeOffset.UtcNow;
            this.progressClock.Restart();
            this.progressWatchdog.Start(0, this.TracksMediaProgress);

            this.ct.Register(state => _ = Task.Run(async () =>
            {
                try
                {
                    if (state is not WeakReference<Stream> weakRef)
                        return;

                    await Task.Delay(1000);

                    if (weakRef.TryGetTarget(out var weakStream))
                    {
#if NET6_0_OR_GREATER
                        await weakStream.DisposeAsync();
#else
                        weakStream.Dispose();
#endif
                    }
                }
                catch (Exception)
                { }
            }), state: new WeakReference<Stream>(stream), useSynchronizationContext: false);

            this.StartRecordingLoop(stream);
        }

        protected void MarkStreamRouteFailed()
        {
            if (!this.ct.IsCancellationRequested && this.selectedRouteHost is { Length: > 0 } host)
                StreamRouteHealth.Shared.Failed(this.room.RoomConfig.RoomId, host, DateTimeOffset.UtcNow);
        }
        private string? selectedRouteHost;

        protected abstract void StartRecordingLoop(Stream stream);

        private void Timer_Elapsed_TriggerIOStats(object? sender, ElapsedEventArgs e)
        {
            int networkDownloadBytes, diskWriteBytes;
            TimeSpan durationDiff, diskWriteDuration;
            DateTimeOffset startTime, endTime;


            lock (this.ioStatsLock) // 锁 timer elapsed 事件本身防止并行运行
            {
                // networks
                networkDownloadBytes = Interlocked.Exchange(ref this.ioNetworkDownloadedBytes, 0); // 锁网络统计
                endTime = DateTimeOffset.UtcNow;
                startTime = this.ioStatsLastTrigger;
                this.ioStatsLastTrigger = endTime;
                durationDiff = endTime - startTime;


                // disks
                lock (this.ioDiskStatsLock) // 锁硬盘统计
                {
                    diskWriteDuration = this.ioDiskWriteDuration;
                    diskWriteBytes = this.ioDiskWrittenBytes;
                    this.ioDiskWriteDuration = TimeSpan.Zero;
                    this.ioDiskWrittenBytes = 0;
                }
            }

            var netMbps = networkDownloadBytes * (8d / 1024d / 1024d) / durationDiff.TotalSeconds;
            var diskMBps = diskWriteBytes / (1024d * 1024d) / diskWriteDuration.TotalSeconds;

            var stalled = this.progressWatchdog.Check(this.progressClock.Elapsed.TotalMilliseconds, networkDownloadBytes, this.room.RoomConfig.TimingWatchdogTimeout);
            if (!this.timeoutTriggered && stalled is not null)
            {
                this.timeoutTriggered = true;
                this.MarkStreamRouteFailed();
                this.logger.Warning("录制进度异常：{Reason}；主动断开以重新连接", stalled);
                this.RequestStop();
            }

            this.OnIOStats(new IOStatsEventArgs
            {
                StreamHost = this.streamHost,
                NetworkBytesDownloaded = networkDownloadBytes,
                Duration = durationDiff,
                StartTime = startTime,
                EndTime = endTime,
                NetworkMbps = netMbps,
                DiskBytesWritten = diskWriteBytes,
                DiskWriteDuration = diskWriteDuration,
                DiskMBps = diskMBps,
            });


        }

        protected (string fullPath, string relativePath) CreateFileName()
        {
            this.partIndex++;

            var output = this.fileNameGenerator.CreateFilePath(new FileNameTemplateContext
            {
                Name = FileNameGenerator.RemoveInvalidFileName(this.room.Name, ignore_slash: false),
                Title = FileNameGenerator.RemoveInvalidFileName(this.room.Title, ignore_slash: false),
                RoomId = this.room.RoomConfig.RoomId,
                ShortId = this.room.ShortId,
                Uid = this.room.Uid,
                AreaParent = FileNameGenerator.RemoveInvalidFileName(this.room.AreaNameParent, ignore_slash: false),
                AreaChild = FileNameGenerator.RemoveInvalidFileName(this.room.AreaNameChild, ignore_slash: false),
                PartIndex = this.partIndex,
                Qn = this.qn,
                Json = this.room.RawBilibiliApiJsonData,
            });

            return (output.FullPath!, output.RelativePath);
        }

        #region Api Requests

        private HttpClient CreateHttpClient()
        {
            var handler = Api.Http.HttpClientWithBindAddress.CreateHandler(
                this.room.RoomConfig.NetworkTransportBindAddress,
                this.room.RoomConfig.NetworkTransportUseSystemProxy,
                allowAutoRedirect: false);

            var httpClient = new HttpClient(handler);
            var headers = httpClient.DefaultRequestHeaders;
            headers.Add("Accept", HttpHeaderAccept);
            headers.Add("Origin", HttpHeaderOrigin);
            headers.Add("Referer", HttpHeaderReferer);
            headers.Add("User-Agent", HttpHeaderUserAgent);
            return httpClient;
        }

        internal static readonly char[] QnParseSeparator = new[] { ',', '，', '、', ' ' };
        internal static IReadOnlyList<StreamCodecQn> ParseAllowedQn(string? allowedQn)
        {
            if (string.IsNullOrWhiteSpace(allowedQn)) return Array.Empty<StreamCodecQn>();

            var qns = allowedQn!.Split(QnParseSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Select(static x =>
                {
                    if (x.Equals("avc*", StringComparison.OrdinalIgnoreCase))
                        return new StreamCodecQn { Qn = BilibiliRecordingSource.AnyCurrentQuality, Codec = StreamCodec.AVC };
                    if (int.TryParse(x, out var num) && num >= 0)
                    {
                        return new StreamCodecQn
                        {
                            Qn = num,
                            Codec = StreamCodec.AVC
                        };
                    }
                    else if (x.StartsWith("avc", StringComparison.OrdinalIgnoreCase))
                    {
                        if (int.TryParse(x[3..], out num) && num >= 0)
                        {
                            return new StreamCodecQn
                            {
                                Qn = num,
                                Codec = StreamCodec.AVC
                            };
                        }
                    }
                    else if (x.StartsWith("hevc", StringComparison.OrdinalIgnoreCase))
                    {
                        if (int.TryParse(x[4..], out num) && num >= 0)
                        {
                            return new StreamCodecQn
                            {
                                Qn = num,
                                Codec = StreamCodec.HEVC
                            };
                        }
                    }

                    // invalid
                    return new StreamCodecQn
                    {
                        Qn = -1,
                        Codec = StreamCodec.AVC
                    };
                })
                .Where(x => x.Qn >= 0 || x.Qn == BilibiliRecordingSource.AnyCurrentQuality)
                .ToList();

            return qns;
        }

        private async Task<BilibiliRecordingSource> FetchStreamUrlAsync(int roomId, bool allowHls)
        {
            var qualities = ParseAllowedQn(this.room.RoomConfig.RecordingQuality);

            if (this.userScriptRunner.CallOnFetchStreamUrl(this.logger, roomId, qualities) is { } urlFromScript)
            {
                this.logger.Information("使用用户脚本返回的直播流地址");
                return new(urlFromScript, string.Empty, false, new StreamCodecQn { Codec = StreamCodec.AVC, Qn = -1 }, -1);
            }

            const int defaultQn = 10000;
            async Task<BilibiliRecordingSource> SelectAsync(int qn)
            {
                var response = await this.apiClient.GetStreamUrlAsync(roomId, qn).ConfigureAwait(false);
                var streams = response.Data?.PlayurlInfo?.Playurl?.Streams ?? Array.Empty<Api.Model.RoomPlayInfo.StreamItem>();
                var source = BilibiliRecordingSource.Select(streams, qualities, allowHls, StreamRouteHealth.Shared, roomId, DateTimeOffset.UtcNow);
                if (source != null) return source;

                this.logger.Warning("已开播，当前没有与录制设置兼容的直播线路；稍后重新检查。设置画质 {QnSettings}", qualities);
                throw new NoMatchingQnValueException();
            }

            var selected = await SelectAsync(defaultQn).ConfigureAwait(false);
            if (selected.Requested.Qn != defaultQn && selected.CurrentQn != selected.Requested.Qn)
                selected = await SelectAsync(selected.Requested.Qn).ConfigureAwait(false);
            if (selected.CurrentQn != selected.Requested.Qn)
                this.logger.Information("平台提供画质 {CurrentQn}，请求画质 {SelectedQn}；继续录制平台实际提供的画质，不因此重启", selected.CurrentQn, selected.Requested);
            return selected;
        }

        protected async Task<Stream> GetStreamAsync(string fullUrl, int timeout)
        {
            var client = this.CreateHttpClient();

            var streamHostInfoBuilder = new StringBuilder();

            while (true)
            {
                var allowedAddressFamily = this.room.RoomConfig.NetworkTransportAllowedAddressFamily;
                HttpRequestMessage request;
                Uri originalUri;

                if (this.userScriptRunner.CallOnTransformStreamUrl(this.logger, fullUrl) is { } scriptResult)
                {
                    var (scriptUrl, scriptIp) = scriptResult;

                    this.logger.Debug("用户脚本重定向了直播流地址 {NewUrl}, 旧地址 {OldUrl}", scriptUrl, fullUrl);

                    fullUrl = scriptUrl;
                    originalUri = new Uri(fullUrl);


                    if (scriptIp is not null)
                    {
                        this.logger.Debug("用户脚本指定了服务器 IP {IP}", scriptIp);

                        var uri = new Uri(fullUrl);
                        var builder = new UriBuilder(uri)
                        {
                            Host = scriptIp
                        };

                        request = new HttpRequestMessage(HttpMethod.Get, builder.Uri);
                        request.Headers.Host = uri.IsDefaultPort ? uri.Host : uri.Host + ":" + uri.Port;

                        streamHostInfoBuilder.Append(originalUri.Host);
                        streamHostInfoBuilder.Append(" [");
                        streamHostInfoBuilder.Append(scriptIp);
                        streamHostInfoBuilder.Append(']');

                        goto sendRequest;
                    }
                }
                else
                {
                    originalUri = new Uri(fullUrl);
                }

                if (allowedAddressFamily == AllowedAddressFamily.System)
                {
                    this.logger.Debug("NetworkTransportAllowedAddressFamily is System");
                    request = new HttpRequestMessage(HttpMethod.Get, originalUri);

                    streamHostInfoBuilder.Append(originalUri.Host);
                }
                else
                {
                    var ips = await Dns.GetHostAddressesAsync(originalUri.DnsSafeHost);

                    var filtered = ips.Where(x => allowedAddressFamily switch
                    {
                        AllowedAddressFamily.Ipv4 => x.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork,
                        AllowedAddressFamily.Ipv6 => x.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6,
                        AllowedAddressFamily.Any => true,
                        _ => false
                    }).ToArray();

                    var selected = filtered[this.random.Next(filtered.Length)];

                    this.logger.Debug("指定直播服务器地址 {DnsHost}: {SelectedIp}, Allowed: {AllowedAddressFamily}, {IPAddresses}", originalUri.DnsSafeHost, selected, allowedAddressFamily, ips);

                    streamHostInfoBuilder.Append(originalUri.Host);
                    streamHostInfoBuilder.Append(" [");
                    streamHostInfoBuilder.Append(selected);
                    streamHostInfoBuilder.Append(']');

                    if (selected is null)
                    {
                        throw new Exception("DNS 没有返回符合要求的 IP 地址");
                    }

                    var builder = new UriBuilder(originalUri)
                    {
                        Host = selected.ToString()
                    };

                    request = new HttpRequestMessage(HttpMethod.Get, builder.Uri);
                    request.Headers.Host = originalUri.IsDefaultPort ? originalUri.Host : originalUri.Host + ":" + originalUri.Port;
                }

            sendRequest:

                var resp = await client.SendAsync(request,
                     HttpCompletionOption.ResponseHeadersRead,
                     new CancellationTokenSource(timeout).Token)
                     .ConfigureAwait(false);

                switch (resp.StatusCode)
                {
                    case HttpStatusCode.OK:
                        {
                            this.logger.Information("开始接收直播流");
                            this.streamHostFull = streamHostInfoBuilder.ToString();
                            var stream = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false);
                            return stream;
                        }
                    case HttpStatusCode.Moved:
                    case HttpStatusCode.Redirect:
                        {
                            fullUrl = new Uri(originalUri, resp.Headers.Location!).ToString();
                            this.logger.Debug("跳转到 {Url}, 原文本 {Location}", fullUrl, resp.Headers.Location!.OriginalString);
                            resp.Dispose();
                            streamHostInfoBuilder.Append('\n');
                            break;
                        }
                    default:
                        throw new Exception(string.Format("尝试下载直播流时服务器返回了 ({0}){1}", resp.StatusCode, resp.ReasonPhrase));
                }
            }
        }
        #endregion
    }
}
