using BililiveRecorder.Flv;
using BililiveRecorder.Flv.Grouping;
using BililiveRecorder.Flv.Grouping.Rules;

namespace BililiveRecorder.Core.Recording
{
    internal class TagGroupReaderFactory : ITagGroupReaderFactory
    {
        public ITagGroupReader CreateTagGroupReader(IFlvTagReader flvTagReader)
        {
            var reader = new TagGroupReader(flvTagReader);
            for (var i = 0; i < reader.GroupingRules.Count; i++)
                if (reader.GroupingRules[i] is DataGroupingRule)
                    reader.GroupingRules[i] = new LiveDataGroupingRule();
            return reader;
        }
    }
}
