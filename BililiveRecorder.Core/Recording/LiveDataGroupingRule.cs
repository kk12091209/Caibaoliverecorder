using System.Collections.Generic;
using BililiveRecorder.Flv;
using BililiveRecorder.Flv.Grouping.Rules;
using BililiveRecorder.Flv.Pipeline.Actions;

namespace BililiveRecorder.Core.Recording
{
    // Keep normal GOP boundaries, but don't hold a long GOP (or audio-only
    // data) in memory indefinitely. This is a write batch, not a new file.
    internal sealed class LiveDataGroupingRule : IGroupingRule
    {
        private readonly DataGroupingRule inner = new();
        public bool CanStartWith(Tag tag) => this.inner.CanStartWith(tag);
        public bool CanAppendWith(Tag tag, List<Tag> tags) =>
            tags.Count < 4096 && (tags.Count == 0 || (long)tag.Timestamp - tags[0].Timestamp < 4000)
            && this.inner.CanAppendWith(tag, tags);
        public PipelineAction CreatePipelineAction(List<Tag> tags) => this.inner.CreatePipelineAction(tags);
    }
}
