using System.IO;
using BililiveRecorder.Core.Recording;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Recording
{
    public class RecordingPolicyTests
    {
        [Fact]
        public void EmptyRulesPreserveLegacyRoomsAndOnlyTheSameBroadcastCanResumeWhenRestricted()
        {
            var file = Path.GetTempFileName();
            try
            {
                File.WriteAllText(file, "[]");
                Assert.True(RecordingPolicy.Allows(file, 0, false));

                File.WriteAllText(file, "[\"900\"]");
                Assert.False(RecordingPolicy.Allows(file, 0, false));
                Assert.False(RecordingPolicy.Allows(file, 900, false));
                Assert.True(RecordingPolicy.Allows(file, 900, true));
                Assert.True(RecordingPolicy.Allows(file, 901, false));

                File.WriteAllText(file, "[]");
                Assert.True(RecordingPolicy.Allows(file, 900, false));
            }
            finally
            {
                File.Delete(file);
            }
        }
    }
}
