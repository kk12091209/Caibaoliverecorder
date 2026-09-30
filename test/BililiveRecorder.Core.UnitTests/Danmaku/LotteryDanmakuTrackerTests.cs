using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Xml;
using System.Xml.Linq;
using BililiveRecorder.Core.Api.Danmaku;
using BililiveRecorder.Core.Config.V3;
using BililiveRecorder.Core.Danmaku;
using BililiveRecorder.Core.Scripting;
using Serilog;
using Newtonsoft.Json.Linq;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Danmaku
{
    public class LotteryDanmakuTrackerTests
    {
        private const long Start = 1800000000;
        private static JObject Anchor(long id = 1, string text = "测试抽奖口令", int room = 42) => new JObject
        {
            ["cmd"] = "ANCHOR_LOT_START",
            ["data"] = new JObject { ["id"] = id, ["room_id"] = room, ["danmu"] = text, ["current_time"] = Start, ["time"] = 10 }
        };
        private static JObject Chat(string text, long stamp = Start * 1000 + 1000) => new JObject
        {
            ["cmd"] = "DANMU_MSG",
            ["info"] = new JArray(new JArray(0, 1, 25, 16777215, stamp, 0, 0, "", 0, 1), text)
        };
        private static JObject End(string cmd = "ANCHOR_LOT_END", long id = 1) => new JObject { ["cmd"] = cmd, ["data"] = new JObject { ["id"] = id } };

        [Fact]
        public void NormalRepeatedChatAndAmbiguousFlagsAreNeverEvidence()
        {
            var tracker = new LotteryDanmakuTracker(() => 0);
            for (var i = 0; i < 1000; i++) Assert.Null(tracker.Process(Chat("哈哈哈"), 42));
            Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
        }

        [Fact]
        public void MatchesExactPhraseOnlyInsideServerTimeWindow()
        {
            var tracker = new LotteryDanmakuTracker(() => 0);
            Assert.Null(tracker.Process(Anchor(), 42));
            Assert.Null(tracker.Process(Chat("测试抽奖口令", Start * 1000 - 1), 42));
            Assert.Equal("anchor:1", tracker.Process(Chat("测试抽奖口令", Start * 1000), 42));
            Assert.Equal("anchor:1", tracker.Process(Chat("测试抽奖口令", Start * 1000 + 9999), 42));
            Assert.Null(tracker.Process(Chat("测试抽奖口令", Start * 1000 + 10000), 42));
            Assert.Null(tracker.Process(Chat(" 测试抽奖口令"), 42));
            Assert.Null(tracker.Process(Chat("测试抽奖口令！"), 42));
            Assert.Null(tracker.Process(Chat("普通聊天"), 42));
        }

        [Fact]
        public void SupportsHistoricalSecondsAndDanmuCommandSuffix()
        {
            var tracker = new LotteryDanmakuTracker(() => 0);
            tracker.Process(Anchor(), 42);
            var chat = Chat("测试抽奖口令", Start + 1);
            chat["cmd"] = "DANMU_MSG:4:0:2:2:2:0";
            Assert.Equal("anchor:1", tracker.Process(chat, 42));
        }

        [Fact]
        public void EndAndAwardCloseActivityAndRejectDelayedStart()
        {
            foreach (var cmd in new[] { "ANCHOR_LOT_END", "ANCHOR_LOT_AWARD" })
            {
                var tracker = new LotteryDanmakuTracker(() => 0);
                tracker.Process(Anchor(), 42);
                tracker.Process(End(cmd), 42);
                tracker.Process(Anchor(), 42);
                Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
            }
        }

        [Fact]
        public void ExpiredWindowCannotBeReusedByStaleChatAfterReconnect()
        {
            long elapsed = 0;
            var tracker = new LotteryDanmakuTracker(() => elapsed);
            tracker.Process(Anchor(), 42);
            elapsed = 10000;
            Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
        }

        [Fact]
        public void RoomsAreIsolatedIncludingBroadcastAndRoomChanges()
        {
            var tracker = new LotteryDanmakuTracker(() => 0);
            tracker.Process(Anchor(room: 43), 42);
            Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
            var wrongEnvelope = Anchor(); wrongEnvelope["roomid"] = 43;
            tracker.Process(wrongEnvelope, 42);
            Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
            tracker.Process(Anchor(), 42);
            Assert.Null(tracker.Process(Chat("测试抽奖口令"), 43));
            Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
        }

        [Fact]
        public void RejectsInvalidTimesIdsAndOverlongOrEmptyPhrases()
        {
            var invalid = new[] { Anchor(id: 0), Anchor(id: -1), Anchor(text: ""), Anchor(text: new string('字', 1025)), Anchor(text: "   ") };
            foreach (var item in invalid)
            {
                var tracker = new LotteryDanmakuTracker(() => 0);
                tracker.Process(item, 42);
                Assert.Null(tracker.Process(Chat((string)item["data"]!["danmu"]!), 42));
            }
            foreach (var key in new[] { "time", "current_time", "room_id", "id" })
            foreach (var value in new JToken[] { JValue.CreateNull(), new JValue("1"), new JValue(0), new JObject(), new JArray(), new JValue(1.5) })
            {
                var tracker = new LotteryDanmakuTracker(() => 0); var item = Anchor(); item["data"]![key] = value.DeepClone();
                tracker.Process(item, 42);
                Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
            }
            var overlong = Anchor(); overlong["data"]!["time"] = 86401;
            var finalTracker = new LotteryDanmakuTracker(() => 0); finalTracker.Process(overlong, 42);
            Assert.Null(finalTracker.Process(Chat("测试抽奖口令"), 42));
        }

        [Fact]
        public void MalformedUnknownAndMissingTimestampMessagesRemainUnmarked()
        {
            var tracker = new LotteryDanmakuTracker(() => 0); tracker.Process(Anchor(), 42);
            foreach (var item in new JObject?[] { null, new JObject(), new JObject { ["cmd"] = new JObject() }, new JObject { ["cmd"] = "DANMU_MSG", ["info"] = new JArray() }, new JObject { ["cmd"] = "DANMU_MSG", ["info"] = new JArray(new JObject(), "测试抽奖口令") } })
                Assert.Null(tracker.Process(item, 42));
            Assert.Null(tracker.Process(Chat("测试抽奖口令", 0), 42));
            var bad = Chat("测试抽奖口令"); bad["info"]![0]![4] = "1800000001000";
            Assert.Null(tracker.Process(bad, 42));
        }

        [Fact]
        public void RedPocketUsesExplicitPhraseAndStartEndAndStopsOnWinnerList()
        {
            var tracker = new LotteryDanmakuTracker(() => 0);
            tracker.Process(new JObject { ["cmd"] = "POPULARITY_RED_POCKET_START", ["data"] = new JObject { ["lot_id"] = 23, ["danmu"] = "测试红包口令", ["current_time"] = Start, ["start_time"] = Start + 1, ["end_time"] = Start + 10 } }, 42);
            Assert.Null(tracker.Process(Chat("测试红包口令", Start * 1000), 42));
            Assert.Equal("red-pocket:23", tracker.Process(Chat("测试红包口令"), 42));
            tracker.Process(new JObject { ["cmd"] = "POPULARITY_RED_POCKET_WINNER_LIST", ["data"] = new JObject { ["lot_id"] = 23 } }, 42);
            Assert.Null(tracker.Process(Chat("测试红包口令"), 42));
        }

        [Fact]
        public void LiveBoundaryClearsPriorActivity()
        {
            foreach (var cmd in new[] { "LIVE", "PREPARING" })
            {
                var tracker = new LotteryDanmakuTracker(() => 0); tracker.Process(Anchor(), 42);
                tracker.Process(new JObject { ["cmd"] = cmd }, 42);
                Assert.Null(tracker.Process(Chat("测试抽奖口令"), 42));
            }
        }

        [Fact]
        public async Task WriterKeepsAllOriginalTextAndAddsMarkerWithoutRawPayload()
        {
            var global = new GlobalConfig();
            var config = new RoomConfig { RoomId = 42, RecordDanmakuRaw = false };
            config.SetParent(global);
            using var logger = new LoggerConfiguration().CreateLogger();
            using var writer = new BasicDanmakuWriter(logger, new UserScriptRunner(global));
            using var output = new StringWriter();
            var xml = XmlWriter.Create(output, new XmlWriterSettings { Async = true, CloseOutput = false });
            xml.WriteStartElement("i");
            typeof(BasicDanmakuWriter).GetField("xmlWriter", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(writer, xml);
            typeof(BasicDanmakuWriter).GetField("config", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(writer, config);
            static DanmakuModel Comment(string text)
            {
                var raw = Chat(text); var info = (JArray)raw["info"]!;
                info.Add(new JArray(123, "测试用户", 0, 0));
                while (info.Count < 7) info.Add(new JArray());
                info.Add(0);
                return new DanmakuModel(raw.ToString());
            }
            await writer.WriteAsync(Comment("测试抽奖口令"));
            await writer.WriteAsync(new DanmakuModel(Anchor().ToString()));
            await writer.WriteAsync(Comment("测试抽奖口令"));
            await writer.WriteAsync(Comment("哈哈哈"));
            await writer.WriteAsync(Comment("哈哈哈"));
            await writer.WriteAsync(new DanmakuModel(End().ToString()));
            await writer.WriteAsync(Comment("测试抽奖口令"));
            writer.Disable();
            var comments = XDocument.Parse(output.ToString()).Root!.Elements("d").ToArray();
            Assert.Equal(5, comments.Length);
            Assert.Null(comments[0].Attribute("lottery"));
            Assert.Equal("anchor:1", (string?)comments[1].Attribute("lottery"));
            Assert.Equal("测试抽奖口令", comments[1].Value);
            Assert.Null(comments[2].Attribute("lottery"));
            Assert.Null(comments[3].Attribute("lottery"));
            Assert.Null(comments[4].Attribute("lottery"));
            foreach (var comment in comments) Assert.Null(comment.Attribute("raw"));
        }
        [Fact]
        public void ActivityCapacityIsBoundedAndFailsOpen()
        {
            var tracker = new LotteryDanmakuTracker(() => 0);
            for (var i = 1; i <= 65; i++) tracker.Process(Anchor(i, "口令" + i), 42);
            Assert.Equal("anchor:64", tracker.Process(Chat("口令64"), 42));
            Assert.Null(tracker.Process(Chat("口令65"), 42));
        }
    }
}