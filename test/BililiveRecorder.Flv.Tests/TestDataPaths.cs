using System;
using System.IO;
using VerifyTests;

namespace BililiveRecorder.Flv.Tests
{
    internal static class TestDataPaths
    {
        // Isolated source checkouts may share an already verified, pinned test
        // data submodule without replacing local files in either checkout.
        internal static string Resolve(string path)
        {
            var root = Environment.GetEnvironmentVariable("CAIBAO_TEST_DATA_ROOT");
            var relative = path.Replace('\\', '/');
            return !string.IsNullOrWhiteSpace(root) && relative.StartsWith("../data/", StringComparison.Ordinal)
                ? Path.GetFullPath(Path.Combine(root, relative.Substring("../data/".Length)))
                : Path.GetFullPath(Path.Combine(AttributeReader.GetProjectDirectory(), path));
        }
    }
}
