using System.Diagnostics;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace LiveRecorderDesktop;

internal sealed class BackendStatus
{
    internal bool Busy, Background, QuitAccepted, RequiresExitConfirmation, Stopping;
    internal string QuitError = "";
    internal string Reason = "", Pending = "", Build = "", CloseAction = "ask";
}

internal sealed class BackendService : IDisposable
{
    private readonly string root, app, data;
    private string build;
    private readonly string client = Guid.NewGuid().ToString("N");
    private readonly HttpClient http = new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(3) };
    private readonly JavaScriptSerializer json = new() { MaxJsonLength = 16 * 1024 * 1024 };
    private string token = "", instance = "";
    private Task<BackendStatus>? connecting;
    internal string Origin { get; private set; } = "";
    internal bool ExitRequested { get; private set; }

    internal BackendService(string projectRoot)
    {
        root = projectRoot; app = RuntimeDependencies.ApplicationDirectory(root); data = Path.GetFullPath(Path.Combine(app, "data"));
        build = ComputeBuild(app);
    }
    internal static string ComputeBuild(string app)
    {
        using var bytes = new MemoryStream();
        var names = new[] { "package.json" }.Concat(Directory.GetFiles(Path.Combine(app, "server"), "*.js")
            .Select(file => "server/" + Path.GetFileName(file)).OrderBy(name => name, StringComparer.Ordinal));
        foreach (var name in names)
        {
            var label = Encoding.UTF8.GetBytes(name + "\n"); bytes.Write(label, 0, label.Length);
            var content = File.ReadAllBytes(Path.Combine(app, name.Replace('/', Path.DirectorySeparatorChar))); bytes.Write(content, 0, content.Length);
            bytes.WriteByte(0);
        }
        using var sha = SHA256.Create(); return BitConverter.ToString(sha.ComputeHash(bytes.ToArray())).Replace("-", "").ToLowerInvariant();
    }
    private static bool SamePath(string a, string b) => string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
    private static bool Flag(Dictionary<string, object> value, string key) => value.TryGetValue(key, out var flag) && flag is true;
    private static string Text(Dictionary<string, object> value, string key) => value.TryGetValue(key, out var text) ? text as string ?? "" : "";
    private bool ReadEndpoint()
    {
        try
        {
            var value = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(data, "desktop-service.json")));
            if (!value.TryGetValue("protocol", out var protocol) || Convert.ToInt32(protocol) != 1 || !SamePath(Text(value, "dataPath"), data)) return false;
            var address = Text(value, "origin");
            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port < 1 || uri.AbsolutePath != "/" || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "") return false;
            var secret = Text(value, "token"); var id = Text(value, "instance");
            if (secret.Length != 64 || id.Length != 32 || !secret.All(Uri.IsHexDigit) || !id.All(Uri.IsHexDigit)) return false;
            Origin = address.TrimEnd('/'); token = secret; instance = id; return true;
        }
        catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is InvalidOperationException || error is FormatException) { return false; }
    }
    internal bool IsProcessAlive()
    {
        try
        {
            var value = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(data, "desktop-service.json")));
            using var process = Process.GetProcessById(Convert.ToInt32(value["pid"]));
            return !process.HasExited && string.Equals(process.MainModule?.FileName, RuntimeDependencies.Resolve(root, "node", "node.exe", "NODE_EXE", "Node.js"), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }
    private async Task<BackendStatus?> CallAsync(object? action = null)
    {
        if (Origin == "" || token == "") return null;
        try
        {
            using var request = new HttpRequestMessage(action is null ? HttpMethod.Get : HttpMethod.Post, Origin + "/internal/desktop");
            request.Headers.Add("X-Caibo-Instance", token);
            if (action is not null) request.Content = new StringContent(json.Serialize(action), Encoding.UTF8, "application/json");
            using var response = await http.SendAsync(request); if (!response.IsSuccessStatusCode) return null;
            var value = json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
            if (Convert.ToInt32(value["protocol"]) != 1 || Text(value, "instance") != instance || !SamePath(Text(value, "dataPath"), data)) return null;
            return new BackendStatus { Busy = Flag(value, "busy"), Background = Flag(value, "background"), QuitAccepted = Flag(value, "quitAccepted"), RequiresExitConfirmation = Flag(value, "requiresExitConfirmation"), Stopping = Flag(value, "stopping"), QuitError = Text(value, "quitError"), Reason = Text(value, "reason"), Pending = Text(value, "pending"), Build = Text(value, "build"), CloseAction = Text(value, "closeAction") };
        }
        catch (Exception error) when (error is HttpRequestException || error is TaskCanceledException || error is IOException || error is ArgumentException || error is KeyNotFoundException || error is FormatException || error is InvalidOperationException) { return null; }
    }
    internal async Task ApplyUpdateAsync(string target)
    {
        if (Origin == "" || token == "") throw new IOException("后台尚未连接。");
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(120) };
        using var request = new HttpRequestMessage(HttpMethod.Post, Origin + "/internal/desktop");
        request.Headers.Add("X-Caibo-Instance", token);
        request.Content = new StringContent(json.Serialize(new { action = "applyUpdate", target, guiPid = Process.GetCurrentProcess().Id }), Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        var value = json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
        if (!response.IsSuccessStatusCode) throw new IOException(Text(value, "error"));
        if (Convert.ToInt32(value["protocol"]) != 1 || Text(value, "instance") != instance || !SamePath(Text(value, "dataPath"), data) || !Flag(value, "quitAccepted")) throw new IOException("更新准备失败，请稍后重试。");
        ExitRequested = true;
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (IsProcessAlive())
        {
            var status = await CallAsync();
            if (status?.QuitError?.Length > 0 || DateTime.UtcNow > deadline)
            {
                await CallAsync(new { action = "cancelUpdate" }); ExitRequested = false;
                throw new IOException(status?.QuitError ?? "更新退出未完成，原版本已保留。");
            }
            await Task.Delay(200);
        }
    }
    internal Task<BackendStatus?> HeartbeatAsync() => CallAsync(new { action = "heartbeat", client, pid = Process.GetCurrentProcess().Id });
    internal Task<BackendStatus?> RegisterRecoveryAsync(int pid) => CallAsync(new { action = "heartbeat", client = Guid.NewGuid().ToString(), pid });
    internal async Task SaveCloseActionAsync(string closeAction)
    {
        var status = await CallAsync(new { action = "setCloseAction", closeAction });
        if (status?.CloseAction != closeAction) throw new IOException("设置保存失败，请重试。");
    }
    private bool HasDataWriter()
    {
        var file = Path.Combine(data, "desktop-service.lock.sqlite");
        if (!File.Exists(file)) return false;
        try { using var check = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None); return false; }
        catch (IOException) { return true; }
        catch (UnauthorizedAccessException) { return true; }
    }
    private bool DesktopActive()
    {
        try { using var mutex = Mutex.OpenExisting("Local\\CaiboDesktop-" + Program.InstanceKey(root)); if (!mutex.WaitOne(0)) return true; mutex.ReleaseMutex(); return false; }
        catch (WaitHandleCannotBeOpenedException) { return false; }
        catch (AbandonedMutexException) { return false; }
    }
    private bool LegacyProcessActive()
    {
        var executable = Path.Combine(root, "录播机.exe");
        var version = File.Exists(executable) ? FileVersionInfo.GetVersionInfo(executable) : null;
        if (version is not null && new Version(version.FileMajorPart, version.FileMinorPart, version.FileBuildPart, version.FilePrivatePart) >= new Version(0, 1, 1, 0)) return false;
        // Older desktop builds cannot receive the shutdown event. Never launch
        // them with an unknown command-line switch or replace their live files.
        var paths = new[] { executable, Path.Combine(root, "程序组件", "runtime", "node", "node.exe"), Path.Combine(root, "程序组件", "runtime", "recorder", "BililiveRecorder.Cli.exe") };
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (process.Id == Process.GetCurrentProcess().Id) continue;
                try { if (paths.Any(file => SamePath(file, process.MainModule?.FileName ?? ""))) return true; }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                catch (ArgumentException) { }
            }
        }
        return false;
    }
    private bool InstallationRuntimeActive()
    {
        var paths = new[] {
            Path.Combine(root, "程序组件", "runtime", "node", "node.exe"),
            Path.Combine(root, "程序组件", "runtime", "recorder", "BililiveRecorder.Cli.exe"),
            Path.Combine(root, "程序组件", "runtime", "ffmpeg", "ffmpeg.exe"),
            Path.Combine(root, "程序组件", "runtime", "ffmpeg", "ffprobe.exe")
        };
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try { if (paths.Any(file => SamePath(file, process.MainModule?.FileName ?? ""))) return true; }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                catch (ArgumentException) { }
            }
        }
        return false;
    }
    internal async Task<int> PrepareMaintenanceAsync()
    {
        // Install/uninstall must never launch a service or interrupt work.
        if (LegacyProcessActive()) return 2;
        if (ReadEndpoint())
        {
            BackendStatus? status = null;
            for (var n = 0; n < 5; n++) { status = await CallAsync(); if (status is null || !status.Busy || status.Reason != "") break; await Task.Delay(150); }
            if (status?.Busy == true) return 2;
            if (status is null && HasDataWriter()) return 3;
        }
        else if (HasDataWriter()) return 3;
        using var shutdown = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CaiboShutdown-" + Program.InstanceKey(root));
        shutdown.Set(); await RequestExitAsync();
        for (var n = 0; n < 120; n++)
        {
            if (!HasDataWriter() && !DesktopActive() && !InstallationRuntimeActive()) return 0;
            await Task.Delay(250);
        }
        return 3;
    }
    internal async Task<BackendStatus?> RequestExitAsync()
    {
        ExitRequested = true;
        return await CallAsync(new { action = "exit" });
    }
    internal async Task<BackendStatus?> RequestQuitAsync(bool confirmed)
    {
        var status = await CallAsync(new { action = "quit", confirmed });
        if (status?.QuitAccepted == true) ExitRequested = true;
        return status;
    }
    internal Task<BackendStatus> EnsureAsync() => connecting ??= EnsureCoreAsync();
    private async Task<BackendStatus> EnsureCoreAsync()
    {
        Process? launched = null;
        string restartRequested = "";
        try
        {
            for (var attempt = 0; attempt < 480; attempt++)
            {
                if (ExitRequested) throw new IOException("软件正在退出。");
                if (ReadEndpoint())
                {
                    var status = await HeartbeatAsync();
                    if (status is not null)
                    {
                        if (status.Stopping || status.Pending == "quit") { await Task.Delay(100); continue; }
                        if (status.Build == build) return status;
                        if (restartRequested != instance)
                        {
                            restartRequested = instance; status = await CallAsync(new { action = "restart" }) ?? status;
                        }
                        // Existing work remains available; the managed backend
                        // switches only after recording/export/preparation settles.
                        if (status.Busy) return status;
                    }
                    else if (!IsProcessAlive() && (launched is null || launched.HasExited)) launched = StartBackend();
                }
                else if (launched is null || launched.HasExited) launched = StartBackend();
                await Task.Delay(250);
            }
            throw new IOException("后台服务仍在启动或切换，请稍后重新打开软件。运行记录位于程序组件/live-editor/data。");
        }
        finally { launched?.Dispose(); connecting = null; }
    }
    private Process StartBackend()
    {
        var node = RuntimeDependencies.Resolve(root, "node", "node.exe", "NODE_EXE", "Node.js 24 或更新版本");
        RuntimeDependencies.CheckNodeVersion(node);
        var temporary = Path.Combine(data, "temp"); Directory.CreateDirectory(temporary);
        var start = new ProcessStartInfo(node) { WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        start.Arguments = "\"" + Path.Combine(app, "server", "index.js") + "\"";
        start.EnvironmentVariables["EDITOR_DATA"] = data; start.EnvironmentVariables["EDITOR_PROJECT_ROOT"] = root;
        start.EnvironmentVariables["EDITOR_PORT"] = "0"; start.EnvironmentVariables["RECORDER_PORT"] = "0";
        start.EnvironmentVariables["EDITOR_DESKTOP_MANAGED"] = "1";
        start.EnvironmentVariables["RECORDER_PATH"] = RuntimeDependencies.Resolve(root, "recorder", "BililiveRecorder.Cli.exe", "RECORDER_PATH", "录制核心");
        start.EnvironmentVariables["FFMPEG_PATH"] = RuntimeDependencies.Resolve(root, "ffmpeg", "ffmpeg.exe", "FFMPEG_PATH", "FFmpeg");
        start.EnvironmentVariables["FFPROBE_PATH"] = RuntimeDependencies.Resolve(root, "ffmpeg", "ffprobe.exe", "FFPROBE_PATH", "FFprobe");
        start.EnvironmentVariables["TEMP"] = temporary; start.EnvironmentVariables["TMP"] = temporary;
        return Process.Start(start) ?? throw new IOException("后台服务未能启动。");
    }
    internal void RefreshBuild() { try { build = ComputeBuild(app); } catch (IOException) { } }
    internal bool MatchesBuild(BackendStatus status) => status.Build == build;
    public void Dispose() => http.Dispose();
}
