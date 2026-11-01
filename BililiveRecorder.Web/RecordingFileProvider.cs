using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;

namespace BililiveRecorder.Web
{
    // The optional legacy browser shares recording files, never configuration,
    // backups, credentials, executables or diagnostic logs from WorkDirectory.
    public sealed class RecordingFileProvider : IFileProvider, IDisposable
    {
        private readonly PhysicalFileProvider inner;
        private static readonly HashSet<string> Extensions = new(StringComparer.OrdinalIgnoreCase)
            { ".flv", ".mp4", ".mkv", ".webm", ".xml", ".ass", ".srt", ".aac", ".m4a" };
        public RecordingFileProvider(string root) => this.inner = new PhysicalFileProvider(root);
        private bool SafePath(string physicalPath)
        {
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            var root = this.inner.Root.TrimEnd(Path.DirectorySeparatorChar);
            if (!physicalPath.StartsWith(root + Path.DirectorySeparatorChar, comparison) && !string.Equals(physicalPath, root, comparison)) return false;
            try {
                for (var current = physicalPath; current.Length >= root.Length; current = Path.GetDirectoryName(current)!)
                {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return false;
                    if (string.Equals(current, root, comparison)) break;
                }
                return true;
            } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
        }
        private bool Safe(IFileInfo info) => info.Exists && info.PhysicalPath != null &&
            (info.IsDirectory || Extensions.Contains(Path.GetExtension(info.Name))) && this.SafePath(info.PhysicalPath);
        public IFileInfo GetFileInfo(string subpath)
        {
            var info = this.inner.GetFileInfo(subpath);
            return this.Safe(info) ? info : new NotFoundFileInfo(subpath);
        }
        public IDirectoryContents GetDirectoryContents(string subpath)
        {
            var directory = Path.GetFullPath(Path.Combine(this.inner.Root, subpath.TrimStart('/', '\\'))).TrimEnd(Path.DirectorySeparatorChar);
            if (!Directory.Exists(directory) || !this.SafePath(directory)) return NotFoundDirectoryContents.Singleton;
            var entries = this.inner.GetDirectoryContents(subpath);
            return new Contents(entries.Where(this.Safe).ToArray());
        }
        public IChangeToken Watch(string filter) => NullChangeToken.Singleton;
        public void Dispose() => this.inner.Dispose();
        private sealed class Contents : IDirectoryContents
        {
            private readonly IFileInfo[] entries;
            public Contents(IFileInfo[] entries) => this.entries = entries;
            public bool Exists => true;
            public IEnumerator<IFileInfo> GetEnumerator() => ((IEnumerable<IFileInfo>)this.entries).GetEnumerator();
            IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
        }
    }
}
