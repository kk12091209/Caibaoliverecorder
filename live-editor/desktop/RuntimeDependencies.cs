namespace LiveRecorderDesktop;

internal static class RuntimeDependencies
{
    internal static string ProjectRoot(string candidate)
    {
        var root = Path.GetFullPath(candidate);
        var trimmed = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var parent = Path.GetDirectoryName(trimmed);
        if (parent is not null && Path.GetFileName(trimmed) == "源码" &&
            File.Exists(Path.Combine(parent, "程序组件", "live-editor", "server", "index.js"))) return parent;
        return root;
    }

    internal static string ApplicationDirectory(string root)
    {
        foreach (var directory in new[] { Path.Combine(root, "程序组件", "live-editor"), Path.Combine(root, "live-editor") })
            if (File.Exists(Path.Combine(directory, "server", "index.js"))) return directory;
        throw new IOException("找不到项目组件。请完整解压发布包，保留录播机.exe 旁的程序组件文件夹。");
    }

    internal static string? DesktopFile(string root, string name)
    {
        foreach (var file in new[] {
            Path.Combine(root, "程序组件", "runtime", "desktop", name),
            Path.Combine(root, "runtime", "desktop", name),
            Path.Combine(AppContext.BaseDirectory, name)
        })
            if (File.Exists(file)) return file;
        return null;
    }

    internal static void CheckNodeVersion(string executable)
    {
        var start = new System.Diagnostics.ProcessStartInfo(executable, "--version")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using var process = System.Diagnostics.Process.Start(start);
        if (process is null || !process.WaitForExit(5000)) throw new IOException("Node.js 无法启动，请恢复 程序组件/runtime\\node 组件。");
        var version = process.StandardOutput.ReadToEnd().Trim().TrimStart('v').Split('.')[0];
        if (process.ExitCode != 0 || !int.TryParse(version, out var major) || major < 24)
            throw new IOException("需要 Node.js 24 或更新版本。请恢复发布包的 程序组件/runtime\\node 组件。");
    }

    // A portable package must use its own matching tools before machine-wide installations.
    internal static string Resolve(string root, string component, string executable, string variable, string displayName)
    {
        foreach (var bundled in new[] { Path.Combine(root, "程序组件", "runtime", component, executable), Path.Combine(root, "runtime", component, executable) })
            if (File.Exists(bundled)) return Path.GetFullPath(bundled);
        var configured = Environment.GetEnvironmentVariable(variable)?.Trim().Trim('"');
        if (!string.IsNullOrEmpty(configured))
        {
            var resolved = Find(root, configured!);
            if (resolved is not null) return resolved;
            throw new IOException($"{displayName} 路径无效：{configured}。请修正环境变量 {variable}，或恢复 程序组件/runtime\\{component}\\{executable}。");
        }
        var fromPath = FindOnPath(executable);
        if (fromPath is not null) return fromPath;
        throw new IOException($"缺少 {displayName}。请完整解压发布包，保留 程序组件/runtime\\{component}\\{executable}；自行配置时可使用 {variable} 环境变量或 PATH。");
    }

    private static string? Find(string root, string executable)
    {
        if (Path.IsPathRooted(executable) || executable.IndexOfAny(new[] { '/', '\\' }) >= 0)
        {
            var full = Path.GetFullPath(Path.Combine(root, executable));
            return File.Exists(full) ? full : null;
        }
        return FindOnPath(executable);
    }

    private static string? FindOnPath(string executable)
    {
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(directory)) continue;
            try
            {
                var full = Path.GetFullPath(Path.Combine(directory.Trim().Trim('"'), executable));
                if (File.Exists(full)) return full;
                if (!Path.HasExtension(executable) && File.Exists(full + ".exe")) return full + ".exe";
            }
            catch (ArgumentException) { }
            catch (NotSupportedException) { }
            catch (PathTooLongException) { }
        }
        return null;
    }
}
