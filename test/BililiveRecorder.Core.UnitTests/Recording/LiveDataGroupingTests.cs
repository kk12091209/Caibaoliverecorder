using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using BililiveRecorder.Core.ProcessingRules;
using BililiveRecorder.Core.Recording;
using BililiveRecorder.Flv;
using BililiveRecorder.Flv.Pipeline;
using BililiveRecorder.Flv.Pipeline.Actions;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Recording
{
    public class LiveDataGroupingTests
    {
        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public async Task LongGopAndAudioOnlyDataAreWrittenInBoundedBatchesAsync(bool video)
        {
            var tags = Enumerable.Range(0, 1200).Select(i => new Tag
            {
                Type = video ? TagType.Video : TagType.Audio, Timestamp = i * 33,
                Flag = video && i == 0 ? TagFlag.Keyframe : TagFlag.None
            }).ToList();
            using var reader = new TagGroupReaderFactory().CreateTagGroupReader(new BililiveRecorder.Flv.Xml.FlvTagListReader(tags));
            var received = new List<Tag>(); var count = 0;
            while (await reader.ReadGroupAsync(default) is PipelineDataAction batch)
            {
                Assert.True(batch.Tags.Last().Timestamp - batch.Tags.First().Timestamp < 4000);
                received.AddRange(batch.Tags); count++;
            }
            Assert.True(count >= 9); Assert.Equal(tags, received);
        }

        [Fact]
        public void BatchingPreservesNormalKeyframeBoundariesAndCapsInvalidTimestamps()
        {
            var rule = new LiveDataGroupingRule();
            var keyframe = new Tag { Type = TagType.Video, Flag = TagFlag.Keyframe, Timestamp = 0 };
            Assert.False(rule.CanAppendWith(new Tag { Type = TagType.Video, Flag = TagFlag.Keyframe, Timestamp = 2000 }, new List<Tag> { keyframe }));
            Assert.False(rule.CanAppendWith(new Tag { Type = TagType.Video }, Enumerable.Repeat(keyframe, 4096).ToList()));
        }

        [Fact]
        public void FileSplitWaitsThroughContinuationBatchesUntilAKeyframe()
        {
            var split = new SplitRule(); var context = new FlvProcessingContext(); var session = new Dictionary<object, object?>();
            split.SetSplitBeforeFlag();
            context.Reset(new PipelineDataAction(new[] { new Tag { Type = TagType.Video, Timestamp = 4000 } }), session);
            split.Run(context, () => { });
            Assert.DoesNotContain(context.Actions, a => a is PipelineNewFileAction);
            context.Reset(new PipelineDataAction(new[] { new Tag { Type = TagType.Video, Flag = TagFlag.Keyframe, Timestamp = 20000 } }), session);
            split.Run(context, () => { });
            Assert.IsType<PipelineNewFileAction>(context.Actions[0]);
        }
    }
}
