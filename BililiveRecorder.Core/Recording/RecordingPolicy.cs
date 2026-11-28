using System;
using System.Globalization;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace BililiveRecorder.Core.Recording
{
    internal static class RecordingPolicy
    {
        public static string? FilePath => Environment.GetEnvironmentVariable("CAIBO_RECORDING_POLICY_FILE");

        public static bool Allows(long uid, bool continuesBroadcast)
        {
            var file = FilePath;
            if (string.IsNullOrEmpty(file))
                return true;

            // The editor validates the signed policy and atomically replaces this
            // local projection before applying changes to monitoring entries.
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            using var reader = new StreamReader(stream);
            var entries = JArray.Parse(reader.ReadToEnd());
            return entries.Count == 0 || (uid > 0 && (continuesBroadcast ||
                !entries.Any(entry => entry.Value<string>() == uid.ToString(CultureInfo.InvariantCulture))));
        }
    }
}
