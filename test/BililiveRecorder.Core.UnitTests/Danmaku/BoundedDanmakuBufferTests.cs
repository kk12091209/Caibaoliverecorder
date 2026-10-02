using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using BililiveRecorder.Core.Danmaku;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Danmaku
{
    [CollectionDefinition("Danmaku budget", DisableParallelization = true)]
    public class DanmakuBudgetCollection { }

    [Collection("Danmaku budget")]
    public class BoundedDanmakuBufferTests
    {
        [Fact]
        public void BurstKeepsBoundedSampleAndOriginalDensity()
        {
            var buffer = new BoundedDanmakuBuffer<int>(); var generation = buffer.Begin();
            for (var i = 0; i < 10000; i++) buffer.Add(i, 100, 0, generation, true);
            using (var current = buffer.Take(0, false)) Assert.Empty(current.Items);
            using (var batch = buffer.Take(1, false))
            {
                Assert.Equal(50, batch.Items.Count);
                Assert.Equal(50, batch.Items.Distinct().Count());
                Assert.Equal(10000, Assert.Single(batch.Density).Count);
                Assert.Equal(50, batch.Density[0].Kept);
            }
            Assert.Equal(0, DanmakuBufferBudget.Bytes);
        }

        [Fact]
        public void InFlightBatchRetainsBudgetAcrossRecordingGenerations()
        {
            var buffer = new BoundedDanmakuBuffer<int>(); var generation = buffer.Begin();
            for (var i = 0; i < 512; i++) Assert.True(buffer.Add(i, 16384, i / 50, generation, true));
            var old = buffer.Take(100, true);
            buffer.End(); generation = buffer.Begin();
            Assert.False(buffer.Add(1, 1, 0, generation, true));
            Assert.False(buffer.Add(1, 1, 0, generation - 1, true));
            Assert.Equal(8 * 1024 * 1024, DanmakuBufferBudget.Bytes);
            old.Dispose(); old.Dispose();
            Assert.True(buffer.Add(1, 1, 0, generation, true));
            buffer.Clear(); Assert.Equal(0, DanmakuBufferBudget.Bytes);
        }

        [Fact]
        public void ProcessBudgetIsSharedAcrossPayloadTypesAndRooms()
        {
            var rooms = new List<BoundedDanmakuBuffer<int>>();
            try
            {
                for (var room = 0; room < 4; room++)
                {
                    var buffer = new BoundedDanmakuBuffer<int>(); rooms.Add(buffer); var generation = buffer.Begin();
                    for (var i = 0; i < 512; i++) Assert.True(buffer.Add(i, 16384, i / 50, generation, true));
                }
                var other = new BoundedDanmakuBuffer<string>(); var otherGeneration = other.Begin();
                Assert.False(other.Add("blocked", 1, 0, otherGeneration, true));
                rooms[0].Clear();
                Assert.True(other.Add("available", 1, 0, otherGeneration, true));
                other.Clear();
            }
            finally { foreach (var room in rooms) room.Clear(); }
            Assert.Equal(0, DanmakuBufferBudget.Bytes);
        }

        [Fact]
        public void ConcurrentWritersAreBoundedAndEndFlushesCurrentSecond()
        {
            var buffer = new BoundedDanmakuBuffer<int>(); var generation = buffer.Begin();
            Parallel.For(0, 10000, i => buffer.Add(i, 1, i / 50, generation, true));
            buffer.End(); Assert.False(buffer.Add(1, 1, 300, generation, true));
            using (var batch = buffer.Take(0, true))
            {
                Assert.Equal(2000, batch.Items.Count);
                Assert.Equal(10000, batch.Density.Sum(point => point.Count));
            }
            Assert.Equal(0, DanmakuBufferBudget.Bytes);
        }

        [Theory]
        [InlineData("[菜包表情包_开心]", true)]
        [InlineData(" [菜包表情包_开心] [测试表情包_你好] ", true)]
        [InlineData("这是[菜包表情包_开心]", false)]
        [InlineData("[表情包_开心]", false)]
        [InlineData("[菜包表情包_]", false)]
        [InlineData("[菜包表情包_开心]\n", false)]
        [InlineData("[[菜包表情包_开心]", false)]
        [InlineData(null, false)]
        public void StickerFilterKeepsAmbiguousChat(string? text, bool expected)
            => Assert.Equal(expected, StickerPlaceholder.IsMatch(text));
    }
}
