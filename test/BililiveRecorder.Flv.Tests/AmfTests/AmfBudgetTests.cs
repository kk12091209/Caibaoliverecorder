using System;
using System.IO;
using System.Linq;
using System.Text;
using BililiveRecorder.Flv.Amf;
using BililiveRecorder.Flv.Parser;
using Xunit;

namespace BililiveRecorder.Flv.Tests.AmfTests
{
    public class AmfBudgetTests
    {
        private static byte[] Nested(int count, byte type)
        {
            using var stream = new MemoryStream();
            for (int i = 0; i < count; i++)
            {
                stream.WriteByte(type);
                if (type == 10 || type == 8) stream.Write(new byte[] { 0, 0, 0, 1 }, 0, 4);
                if (type != 10) stream.Write(new byte[] { 0, 1, 120 }, 0, 3);
            }
            stream.WriteByte(5);
            if (type != 10) for (int i = 0; i < count; i++) stream.Write(new byte[] { 0, 0, 9 }, 0, 3);
            return stream.ToArray();
        }

        [Theory]
        [InlineData(3)]
        [InlineData(8)]
        [InlineData(10)]
        public void DepthIsBoundedAcrossAllContainers(byte type)
        {
            Assert.NotNull(ScriptTagBody.Parse(Nested(64, type)));
            Assert.Throws<AmfException>(() => ScriptTagBody.Parse(Nested(65, type)));
            using var reader = new BigEndianBinaryReader(new MemoryStream(Nested(65, type)), Encoding.UTF8, false);
            Assert.Throws<AmfException>(() => ScriptTagBody.ParseValue(reader));
        }

        [Theory]
        [InlineData(new byte[] { 12, 0, 0, 0, 3, 65 })]
        [InlineData(new byte[] { 2, 0, 3, 65 })]
        [InlineData(new byte[] { 3, 0, 3, 65 })]
        public void TruncatedStringsAndNamesAreRejected(byte[] input) =>
            Assert.Throws<AmfException>(() => ScriptTagBody.Parse(input));

        [Fact]
        public void FlatTopLevelAndDuplicatePropertyValuesShareNodeBudget()
        {
            Assert.NotNull(ScriptTagBody.Parse(Enumerable.Repeat((byte)5, 100000).ToArray()));
            Assert.Throws<AmfException>(() => ScriptTagBody.Parse(Enumerable.Repeat((byte)5, 100001).ToArray()));
            using var stream = new MemoryStream();
            stream.WriteByte(3);
            for (int i = 0; i < 100000; i++) stream.Write(new byte[] { 0, 1, 120, 5 }, 0, 4);
            stream.Write(new byte[] { 0, 0, 9 }, 0, 3);
            Assert.Throws<AmfException>(() => ScriptTagBody.Parse(stream.ToArray()));
        }

        [Fact]
        public void RecorderSizedKeyframeArraysAndTrailingNullRemainCompatible()
        {
            var keys = new ScriptDataObject();
            foreach (var name in new[] { "times", "filepositions", "spacer" })
            {
                var array = new ScriptDataStrictArray();
                for (int i = 0; i < 4200; i++) array.Add((ScriptDataNumber)i);
                keys[name] = array;
            }
            var body = new ScriptTagBody();
            body.Values.Add((ScriptDataString)"onMetaData");
            body.Values.Add(new ScriptDataEcmaArray { ["keyframes"] = keys });
            body.Values.Add(new ScriptDataNull());
            var bytes = body.ToBytes();
            Assert.Equal(bytes, ScriptTagBody.Parse(bytes).ToBytes());
        }

        private sealed class NonSeekable : MemoryStream
        {
            public NonSeekable(byte[] bytes) : base(bytes) { }
            public override bool CanSeek => false;
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override long Length => throw new NotSupportedException();
        }
        [Fact]
        public void SingleValueStillSupportsNonSeekableStreamsAndTrailingData()
        {
            using var reader = new BigEndianBinaryReader(new NonSeekable(new byte[] { 5, 0xff }), Encoding.UTF8, false);
            Assert.IsType<ScriptDataNull>(ScriptTagBody.ParseValue(reader));
            Assert.Equal(255, reader.ReadByte());
        }
    }
}
