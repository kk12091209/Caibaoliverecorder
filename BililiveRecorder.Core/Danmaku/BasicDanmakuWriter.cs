using System;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Xml;
using BililiveRecorder.Core.Api.Danmaku;
using BililiveRecorder.Core.Config.V3;
using BililiveRecorder.Core.Scripting;
using Serilog;

#nullable enable
namespace BililiveRecorder.Core.Danmaku
{
    internal class BasicDanmakuWriter : IBasicDanmakuWriter
    {
        private static readonly XmlWriterSettings xmlWriterSettings = new XmlWriterSettings
        {
            Async = true,
            Indent = true,
            IndentChars = "  ",
            Encoding = Encoding.UTF8,
            CloseOutput = true,
            WriteEndDocumentOnClose = true,
        };

        private static readonly Regex invalidXMLChars = new Regex(@"(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFEFF\uFFFE\uFFFF]", RegexOptions.Compiled);
        private static string RemoveInvalidXMLChars(string? text) => string.IsNullOrWhiteSpace(text) ? string.Empty : invalidXMLChars.Replace(text, string.Empty);

        private XmlWriter? xmlWriter = null;
        private readonly Stopwatch dmTime = new Stopwatch();
        private readonly Func<double> recordingTime;
        private readonly LotteryDanmakuTracker lotteryTracker = new LotteryDanmakuTracker();
        private uint writeCount = 0;
        private RoomConfig? config;
        private readonly BoundedDanmakuBuffer<PendingMessage> pending = new BoundedDanmakuBuffer<PendingMessage>();
        private readonly CancellationTokenSource pumpCancellation = new CancellationTokenSource();
        private readonly object pumpGate = new object();
        private Task? pump;
        private int generation;
        private sealed class PendingMessage
        {
            internal DanmakuModel? Model;
            internal double Time;
            internal string Text = string.Empty, User = string.Empty;
            internal string? Raw;
            internal long UserId, Stamp;
            internal int Type, Size, Color;
        }

        private readonly SemaphoreSlim semaphoreSlim = new SemaphoreSlim(1, 1);
        private readonly ILogger logger;
        private readonly UserScriptRunner userScriptRunner;

        public BasicDanmakuWriter(ILogger logger, UserScriptRunner userScriptRunner)
            : this(logger, userScriptRunner, null) { }

        internal BasicDanmakuWriter(ILogger logger, UserScriptRunner userScriptRunner, Func<double>? recordingTime)
        {
            this.logger = logger?.ForContext<BasicDanmakuWriter>() ?? throw new ArgumentNullException(nameof(logger));
            this.userScriptRunner = userScriptRunner ?? throw new ArgumentNullException(nameof(userScriptRunner));
            this.generation = this.pending.Begin();
            this.recordingTime = recordingTime ?? (() => Math.Max(this.dmTime.Elapsed.TotalSeconds, 0d));
        }

        [SuppressMessage("Usage", "VSTHRD002", Justification = "The writer lifecycle is synchronous; all drain awaits use ConfigureAwait(false) and hold the writer semaphore.")]
        public void EnableWithPath(string path, IRoom room)
        {
            if (this.disposedValue) return;

            this.semaphoreSlim.Wait();
            try
            {
                this.pending.End();
                this.DrainLockedAsync(true).GetAwaiter().GetResult();
                this.DisableCore();

                try { Directory.CreateDirectory(Path.GetDirectoryName(path)!); } catch (Exception) { }
                var stream = File.Open(path, FileMode.Create, FileAccess.Write, FileShare.Read);

                this.config = room.RoomConfig;

                this.xmlWriter = XmlWriter.Create(stream, xmlWriterSettings);
                WriteStartDocument(this.xmlWriter, room);
                this.dmTime.Restart();
                this.writeCount = 0;
                this.generation = this.pending.Begin();
            }
            finally
            {
                this.semaphoreSlim.Release();
            }
        }

        [SuppressMessage("Usage", "VSTHRD002", Justification = "The synchronous lifecycle must flush the final bounded batch; drain awaits do not capture a synchronization context.")]
        public void Disable()
        {
            if (this.disposedValue) return;

            this.pending.End();
            this.semaphoreSlim.Wait();
            try
            {
                this.DrainLockedAsync(true).GetAwaiter().GetResult();
                this.DisableCore();
            }
            finally
            {
                this.semaphoreSlim.Release();
            }
        }

        private void DisableCore()
        {
            this.pending.Clear();
            try
            {
                if (this.xmlWriter != null)
                {
                    this.xmlWriter.Close();
                    this.xmlWriter.Dispose();
                    this.xmlWriter = null;
                }
            }
            catch (Exception ex)
            {
                this.logger.Warning(ex, "关闭弹幕文件时发生错误");
                this.xmlWriter = null;
            }
        }

        public Task WriteAsync(DanmakuModel danmakuModel)
        {
            if (this.disposedValue)
                return Task.CompletedTask;
            var receiptGeneration = this.generation;
            var time = this.recordingTime();

            // Unknown lottery events still carry the server-confirmed phrase and validity window.
            // Observe them synchronously before quota accounting and without one Task.Run per event.
            string? lottery = null;
            try
            {
                if (this.config != null) lottery = this.lotteryTracker.Process(danmakuModel.RawObject, this.config.RoomId);
            }
            catch (Exception ex)
            {
                // Optional classification must never interrupt or discard the original recording.
                this.logger.Debug(ex, "Unable to classify lottery participation message");
            }

            if (this.xmlWriter is null || this.config is null)
                return Task.CompletedTask;

            if (danmakuModel.MsgType is not (DanmakuMsgType.Comment or DanmakuMsgType.SuperChat or DanmakuMsgType.GiftSend or DanmakuMsgType.GuardBuy))
                return Task.CompletedTask;

            if (danmakuModel.MsgType == DanmakuMsgType.Comment && (lottery != null || StickerPlaceholder.IsMatch(danmakuModel.CommentText)))
                return Task.CompletedTask;
            if ((danmakuModel.MsgType == DanmakuMsgType.SuperChat && !this.config.RecordDanmakuSuperChat) ||
                (danmakuModel.MsgType == DanmakuMsgType.GiftSend && !this.config.RecordDanmakuGift) ||
                (danmakuModel.MsgType == DanmakuMsgType.GuardBuy && !this.config.RecordDanmakuGuard)) return Task.CompletedTask;

            var rawString = danmakuModel.RawString ?? string.Empty;
            if (!this.userScriptRunner.CallOnDanmaku(this.logger, rawString))
                return Task.CompletedTask;

            PendingMessage message;
            int retainedBytes;
            try
            {
                if (danmakuModel.MsgType == DanmakuMsgType.Comment)
                {
                    // Drop profiles and unrelated protocol metadata before buffering.
                    // A large incoming profile must not discard an otherwise short comment.
                    message = new PendingMessage {
                        Time = time, Text = danmakuModel.CommentText ?? string.Empty,
                        User = danmakuModel.UserName ?? string.Empty, UserId = danmakuModel.UserID,
                        Type = danmakuModel.RawObject?["info"]?[0]?[1]?.ToObject<int>() ?? 1,
                        Size = danmakuModel.RawObject?["info"]?[0]?[2]?.ToObject<int>() ?? 25,
                        Color = danmakuModel.RawObject?["info"]?[0]?[3]?.ToObject<int>() ?? 0XFFFFFF,
                        Stamp = danmakuModel.RawObject?["info"]?[0]?[4]?.ToObject<long>() ?? 0L,
                        Raw = this.config.RecordDanmakuRaw ? danmakuModel.RawObject?["info"]?.ToString(Newtonsoft.Json.Formatting.None) : null
                    };
                    // UTF-16 payload size plus an allowance for object/string headers.
                    var characters = (long)message.Text.Length + message.User.Length + (message.Raw?.Length ?? 0);
                    if (characters > (16 * 1024 - 512) / 2) return Task.CompletedTask;
                    retainedBytes = (int)characters * 2 + 512;
                }
                else
                {
                    var payloadBytes = Encoding.UTF8.GetByteCount(rawString);
                    if (payloadBytes > (16 * 1024 - 512) / 4) return Task.CompletedTask;
                    message = new PendingMessage { Model = danmakuModel, Time = time };
                    retainedBytes = payloadBytes * 4 + 512;
                }
            }
            catch (Exception ex) { this.logger.Debug(ex, "忽略格式异常的弹幕"); return Task.CompletedTask; }
            if (this.pending.Add(message, retainedBytes, (long)time, receiptGeneration, danmakuModel.MsgType == DanmakuMsgType.Comment))
                lock (this.pumpGate) if (!this.disposedValue && (this.pump is null || this.pump.IsCompleted)) this.pump = this.PumpAsync();
            return Task.CompletedTask;
        }

        private async Task PumpAsync()
        {
            try
            {
                while (true)
                {
                    await Task.Delay(100, this.pumpCancellation.Token).ConfigureAwait(false);
                    await this.semaphoreSlim.WaitAsync(this.pumpCancellation.Token).ConfigureAwait(false);
                    try { await this.DrainLockedAsync(false).ConfigureAwait(false); }
                    finally { this.semaphoreSlim.Release(); }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { this.logger.Warning(ex, "弹幕写入循环异常，后续消息将重试"); }
        }

        private async Task DrainLockedAsync(bool force)
        {
            using var batch = this.pending.Take((long)this.recordingTime(), force);
            if (this.xmlWriter is null || this.config is null) return;
            try
            {
                foreach (var density in batch.Density)
                {
                    await this.xmlWriter.WriteStartElementAsync(null, "density", null).ConfigureAwait(false);
                    await this.xmlWriter.WriteAttributeStringAsync(null, "ts", null, density.Second.ToString(System.Globalization.CultureInfo.InvariantCulture)).ConfigureAwait(false);
                    await this.xmlWriter.WriteAttributeStringAsync(null, "count", null, density.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)).ConfigureAwait(false);
                    await this.xmlWriter.WriteAttributeStringAsync(null, "kept", null, density.Kept.ToString(System.Globalization.CultureInfo.InvariantCulture)).ConfigureAwait(false);
                    await this.xmlWriter.WriteEndElementAsync().ConfigureAwait(false);
                }
            }
            catch (Exception ex) { this.logger.Warning(ex, "写入弹幕密度时发生错误"); this.DisableCore(); return; }
            foreach (var message in batch.Items.OrderBy(item => item.Time))
                if(message.Model is null) await this.WriteCommentLockedAsync(message).ConfigureAwait(false);
                else await this.WriteLockedAsync(message.Model, message.Time).ConfigureAwait(false);
            if (batch.Items.Count > 0 && this.xmlWriter != null)
            {
                try { await this.xmlWriter.FlushAsync().ConfigureAwait(false); }
                catch (Exception ex) { this.logger.Warning(ex, "写入弹幕时发生错误"); this.DisableCore(); }
            }
        }

        private async Task WriteCommentLockedAsync(PendingMessage message)
        {
            if (this.xmlWriter is null) return;
            try
            {
                await this.xmlWriter.WriteStartElementAsync(null, "d", null).ConfigureAwait(false);
                await this.xmlWriter.WriteAttributeStringAsync(null, "p", null,
                    FormattableString.Invariant($"{message.Time:F3},{message.Type},{message.Size},{message.Color},{message.Stamp},0,{message.UserId},0")).ConfigureAwait(false);
                await this.xmlWriter.WriteAttributeStringAsync(null, "user", null, RemoveInvalidXMLChars(message.User)).ConfigureAwait(false);
                if(message.Raw != null) await this.xmlWriter.WriteAttributeStringAsync(null, "raw", null, RemoveInvalidXMLChars(message.Raw)).ConfigureAwait(false);
                this.xmlWriter.WriteValue(RemoveInvalidXMLChars(message.Text));
                await this.xmlWriter.WriteEndElementAsync().ConfigureAwait(false);
            }
            catch (Exception ex) { this.logger.Warning(ex, "写入弹幕时发生错误"); this.DisableCore(); }
        }

        // Caller owns the writer semaphore. Receipt time was captured before buffering.
        private async Task WriteLockedAsync(DanmakuModel danmakuModel, double recordedTime)
        {
            if (this.xmlWriter is null || this.config is null) return;
            try
            {
                if (this.xmlWriter is null)
                    return;

                var write = true;
                var recordDanmakuRaw = this.config.RecordDanmakuRaw;
                switch (danmakuModel.MsgType)
                {
                    case DanmakuMsgType.SuperChat:
                        if (this.config.RecordDanmakuSuperChat)
                        {
                            await this.xmlWriter.WriteStartElementAsync(null, "sc", null).ConfigureAwait(false);
                            var ts = recordedTime;
                            await this.xmlWriter.WriteAttributeStringAsync(null, "ts", null, ts.ToString("F3")).ConfigureAwait(false);
                            await this.xmlWriter.WriteAttributeStringAsync(null, "user", null, RemoveInvalidXMLChars(danmakuModel.UserName)).ConfigureAwait(false);
                            await this.xmlWriter.WriteAttributeStringAsync(null, "uid", null, danmakuModel.UserID.ToString()).ConfigureAwait(false);
                            await this.xmlWriter.WriteAttributeStringAsync(null, "price", null, danmakuModel.Price.ToString()).ConfigureAwait(false);
                            await this.xmlWriter.WriteAttributeStringAsync(null, "time", null, danmakuModel.SCKeepTime.ToString()).ConfigureAwait(false);
                            if (recordDanmakuRaw)
                                await this.xmlWriter.WriteAttributeStringAsync(null, "raw", null, RemoveInvalidXMLChars(danmakuModel.RawObject?["data"]?.ToString(Newtonsoft.Json.Formatting.None))).ConfigureAwait(false);
                            this.xmlWriter.WriteValue(RemoveInvalidXMLChars(danmakuModel.CommentText));
                            await this.xmlWriter.WriteEndElementAsync().ConfigureAwait(false);
                        }
                        break;
                    case DanmakuMsgType.GiftSend:
                        if (this.config.RecordDanmakuGift)
                        {
                            var ts = recordedTime;
                            var raw = recordDanmakuRaw ? RemoveInvalidXMLChars(danmakuModel.RawObject?["data"]?.ToString(Newtonsoft.Json.Formatting.None)) : null;

                            if (danmakuModel.GiftList is { } giftList)
                            {
                                // SEND_GIFT_V2 一条消息可能包含多件礼物，每件礼物写一个 gift 元素
                                foreach (var gift in giftList)
                                    await WriteGiftAsync(this.xmlWriter, ts, danmakuModel, gift.GiftName, gift.Num, raw).ConfigureAwait(false);
                            }
                            else
                            {
                                await WriteGiftAsync(this.xmlWriter, ts, danmakuModel, danmakuModel.GiftName, danmakuModel.GiftCount, raw).ConfigureAwait(false);
                            }
                        }
                        break;
                    case DanmakuMsgType.GuardBuy:
                        if (this.config.RecordDanmakuGuard)
                        {
                            await this.xmlWriter.WriteStartElementAsync(null, "guard", null).ConfigureAwait(false);
                            var ts = recordedTime;
                            await this.xmlWriter.WriteAttributeStringAsync(null, "ts", null, ts.ToString("F3")).ConfigureAwait(false);
                            await this.xmlWriter.WriteAttributeStringAsync(null, "user", null, RemoveInvalidXMLChars(danmakuModel.UserName)).ConfigureAwait(false);
                            await this.xmlWriter.WriteAttributeStringAsync(null, "uid", null, danmakuModel.UserID.ToString()).ConfigureAwait(false);
                            await this.xmlWriter.WriteAttributeStringAsync(null, "level", null, danmakuModel.UserGuardLevel.ToString()).ConfigureAwait(false); ;
                            await this.xmlWriter.WriteAttributeStringAsync(null, "count", null, danmakuModel.GiftCount.ToString()).ConfigureAwait(false);
                            if (recordDanmakuRaw)
                                await this.xmlWriter.WriteAttributeStringAsync(null, "raw", null, RemoveInvalidXMLChars(danmakuModel.RawObject?["data"]?.ToString(Newtonsoft.Json.Formatting.None))).ConfigureAwait(false);
                            await this.xmlWriter.WriteEndElementAsync().ConfigureAwait(false);
                        }
                        break;
                    default:
                        write = false;
                        break;
                }

                if (write && this.writeCount++ >= this.config.RecordDanmakuFlushInterval)
                {
                    await this.xmlWriter.FlushAsync().ConfigureAwait(false);
                    this.writeCount = 0;
                }
            }
            catch (Exception ex)
            {
                this.logger.Warning(ex, "写入弹幕时发生错误");
                this.DisableCore();
            }
        }

        private static async Task WriteGiftAsync(XmlWriter writer, double ts, DanmakuModel danmakuModel, string? giftName, int giftCount, string? raw)
        {
            await writer.WriteStartElementAsync(null, "gift", null).ConfigureAwait(false);
            await writer.WriteAttributeStringAsync(null, "ts", null, ts.ToString("F3")).ConfigureAwait(false);
            await writer.WriteAttributeStringAsync(null, "user", null, RemoveInvalidXMLChars(danmakuModel.UserName)).ConfigureAwait(false);
            await writer.WriteAttributeStringAsync(null, "uid", null, danmakuModel.UserID.ToString()).ConfigureAwait(false);
            await writer.WriteAttributeStringAsync(null, "giftname", null, RemoveInvalidXMLChars(giftName)).ConfigureAwait(false);
            await writer.WriteAttributeStringAsync(null, "giftcount", null, giftCount.ToString()).ConfigureAwait(false);
            if (raw is not null)
                await writer.WriteAttributeStringAsync(null, "raw", null, raw).ConfigureAwait(false);
            await writer.WriteEndElementAsync().ConfigureAwait(false);
        }

        private static void WriteStartDocument(XmlWriter writer, IRoom room)
        {
            writer.WriteStartDocument();
            writer.WriteProcessingInstruction("xml-stylesheet", "type=\"text/xsl\" href=\"#s\"");
            writer.WriteStartElement("i");
            writer.WriteComment("\nmikufans录播姬 " + GitVersionInformation.InformationalVersion + "\nhttps://rec.danmuji.org/user/danmaku/\n本文件的弹幕信息兼容mikufans主站视频弹幕XML格式\n本XML自带样式可以在浏览器里打开（推荐使用Chrome）\n\nsc 为SuperChat\ngift为礼物\nguard为上船\n\nattribute \"raw\" 为原始数据\n");
            writer.WriteElementString("chatserver", "chat.bilibili.com");
            writer.WriteElementString("chatid", "0");
            writer.WriteElementString("mission", "0");
            writer.WriteElementString("maxlimit", "1000");
            writer.WriteElementString("state", "0");
            writer.WriteElementString("real_name", "0");
            writer.WriteElementString("source", "0");

            writer.WriteStartElement("BililiveRecorder");
            writer.WriteAttributeString("version", GitVersionInformation.FullSemVer);
            writer.WriteEndElement();

            writer.WriteStartElement("BililiveRecorderRecordInfo");
            writer.WriteAttributeString("roomid", room.RoomConfig.RoomId.ToString());
            writer.WriteAttributeString("shortid", room.ShortId.ToString());
            writer.WriteAttributeString("name", RemoveInvalidXMLChars(room.Name));
            writer.WriteAttributeString("title", RemoveInvalidXMLChars(room.Title));
            writer.WriteAttributeString("areanameparent", RemoveInvalidXMLChars(room.AreaNameParent));
            writer.WriteAttributeString("areanamechild", RemoveInvalidXMLChars(room.AreaNameChild));
            writer.WriteAttributeString("start_time", DateTimeOffset.Now.ToString("O"));
            writer.WriteEndElement();

            // see BililiveRecorder.ToolBox\Tool\DanmakuMerger\DanmakuMergerHandler.cs
            const string style = @"<z:stylesheet version=""1.0"" id=""s"" xml:id=""s"" xmlns:z=""http://www.w3.org/1999/XSL/Transform""><z:output method=""html""/><z:template match=""/""><html><meta name=""viewport"" content=""width=device-width""/><title>mikufans录播姬弹幕文件 - <z:value-of select=""/i/BililiveRecorderRecordInfo/@name""/></title><style>body{margin:0}h1,h2,p,table{margin-left:5px}table{border-spacing:0}td,th{border:1px solid grey;padding:1px}th{position:sticky;top:0;background:#4098de}tr:hover{background:#d9f4ff}div{overflow:auto;max-height:80vh;max-width:100vw;width:fit-content}</style><h1><a href=""https://rec.danmuji.org"">mikufans录播姬</a>弹幕XML文件</h1><p>本文件不支持在 IE 浏览器里预览，请使用 Chrome Firefox Edge 等浏览器。</p><p>文件用法参考文档 <a href=""https://rec.danmuji.org/user/danmaku/"">https://rec.danmuji.org/user/danmaku/</a></p><table><tr><td>录播姬版本</td><td><z:value-of select=""/i/BililiveRecorder/@version""/></td></tr><tr><td>房间号</td><td><z:value-of select=""/i/BililiveRecorderRecordInfo/@roomid""/></td></tr><tr><td>主播名</td><td><z:value-of select=""/i/BililiveRecorderRecordInfo/@name""/></td></tr><tr><td>录制开始时间</td><td><z:value-of select=""/i/BililiveRecorderRecordInfo/@start_time""/></td></tr><tr><td><a href=""#d"">弹幕</a></td><td>共<z:value-of select=""count(/i/d)""/>条记录</td></tr><tr><td><a href=""#guard"">上船</a></td><td>共<z:value-of select=""count(/i/guard)""/>条记录</td></tr><tr><td><a href=""#sc"">SC</a></td><td>共<z:value-of select=""count(/i/sc)""/>条记录</td></tr><tr><td><a href=""#gift"">礼物</a></td><td>共<z:value-of select=""count(/i/gift)""/>条记录</td></tr></table><h2 id=""d"">弹幕</h2><div id=""dm""><table><tr><th>用户名</th><th>出现时间</th><th>用户ID</th><th>弹幕</th><th>参数</th></tr><z:for-each select=""/i/d""><tr><td><z:value-of select=""@user""/></td><td></td><td></td><td><z:value-of select="".""/></td><td><z:value-of select=""@p""/></td></tr></z:for-each></table></div><script>Array.from(document.querySelectorAll('#dm tr')).slice(1).map(t=>t.querySelectorAll('td')).forEach(t=>{let p=t[4].textContent.split(','),a=p[0];t[1].textContent=`${(Math.floor(a/60/60)+'').padStart(2,0)}:${(Math.floor(a/60%60)+'').padStart(2,0)}:${(a%60).toFixed(3).padStart(6,0)}`;t[2].innerHTML=`&lt;a target=_blank rel=""nofollow noreferrer"" href=""https://space.bilibili.com/${p[6]}""&gt;${p[6]}&lt;/a&gt;`})</script><h2 id=""guard"">舰长购买</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>舰长等级</th><th>购买数量</th><th>出现时间</th></tr><z:for-each select=""/i/guard""><tr><td><z:value-of select=""@user""/></td><td><a rel=""nofollow noreferrer""><z:attribute name=""href""><z:text>https://space.bilibili.com/</z:text><z:value-of select=""@uid"" /></z:attribute><z:value-of select=""@uid""/></a></td><td><z:value-of select=""@level""/></td><td><z:value-of select=""@count""/></td><td><z:value-of select=""@ts""/></td></tr></z:for-each></table></div><h2 id=""sc"">SuperChat 醒目留言</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>内容</th><th>显示时长</th><th>价格</th><th>出现时间</th></tr><z:for-each select=""/i/sc""><tr><td><z:value-of select=""@user""/></td><td><a rel=""nofollow noreferrer""><z:attribute name=""href""><z:text>https://space.bilibili.com/</z:text><z:value-of select=""@uid"" /></z:attribute><z:value-of select=""@uid""/></a></td><td><z:value-of select="".""/></td><td><z:value-of select=""@time""/></td><td><z:value-of select=""@price""/></td><td><z:value-of select=""@ts""/></td></tr></z:for-each></table></div><h2 id=""gift"">礼物</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>礼物名</th><th>礼物数量</th><th>出现时间</th></tr><z:for-each select=""/i/gift""><tr><td><z:value-of select=""@user""/></td><td><a rel=""nofollow noreferrer""><z:attribute name=""href""><z:text>https://space.bilibili.com/</z:text><z:value-of select=""@uid"" /></z:attribute><z:value-of select=""@uid""/></a></td><td><z:value-of select=""@giftname""/></td><td><z:value-of select=""@giftcount""/></td><td><z:value-of select=""@ts""/></td></tr></z:for-each></table></div></html></z:template></z:stylesheet>";

            writer.WriteStartElement("BililiveRecorderXmlStyle");
            writer.WriteRaw(style);
            writer.WriteEndElement();
            writer.Flush();
        }

        private volatile bool disposedValue;

        [SuppressMessage("Usage", "VSTHRD002", Justification = "Cancel and join the single writer pump before disposing its semaphore; the pump never captures a synchronization context.")]
        protected virtual void Dispose(bool disposing)
        {
            if (!this.disposedValue)
            {
                if (disposing)
                {
                    this.Disable();
                    lock (this.pumpGate) { this.disposedValue = true; this.pumpCancellation.Cancel(); }
                    this.pump?.GetAwaiter().GetResult();
                    this.pumpCancellation.Dispose();
                    this.semaphoreSlim.Dispose();
                    this.xmlWriter?.Close();
                    this.xmlWriter?.Dispose();
                    this.xmlWriter = null;
                }

                // free unmanaged resources (unmanaged objects) and override finalizer
                // set large fields to null
                this.disposedValue = true;
            }
        }

        public void Dispose()
        {
            // Do not change this code. Put cleanup code in 'Dispose(bool disposing)' method
            this.Dispose(disposing: true);
            GC.SuppressFinalize(this);
        }
    }
}
