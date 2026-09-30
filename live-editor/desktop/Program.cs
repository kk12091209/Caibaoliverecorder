using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LiveRecorderDesktop;

internal static class Program
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
    [STAThread]
    private static void Main()
    {
        var root = RuntimeDependencies.ProjectRoot(Environment.GetEnvironmentVariable("RECORDER_PROJECT_ROOT") ?? AppContext.BaseDirectory);
        InitializeRuntime(root);
        RunApplication(root);
    }

    internal static void InitializeRuntime(string root)
    {
        // Register before the JIT encounters MainWindow or its WebView2 fields.
        var configuration = Path.Combine(root, "程序组件", "录播机.exe.config");
        if (File.Exists(configuration)) AppDomain.CurrentDomain.SetData("APP_CONFIG_FILE", configuration);
        AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
        {
            var name = new AssemblyName(args.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            var file = RuntimeDependencies.DesktopFile(root, name + ".dll");
            return file is null ? null : Assembly.LoadFrom(file);
        };
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunApplication(string root)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var sha = SHA256.Create();
        var key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-", "").Substring(0, 16);
        using var instance = new Mutex(true, "Local\\BiliLiveEditor-" + key, out var first);
        if (!first)
        {
            foreach (var other in Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName))
            {
                if (other.Id == Process.GetCurrentProcess().Id || other.MainWindowHandle == IntPtr.Zero) continue;
                ShowWindow(other.MainWindowHandle, 9); SetForegroundWindow(other.MainWindowHandle); break;
            }
            return;
        }
        Application.Run(new MainWindow(root));
    }
}

internal sealed class MainWindow : Form
{
    private const string Origin = "http://127.0.0.1:17860";
    private readonly string root;
    private readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(16, 20, 24) };
    private readonly Label splash = new() { Dock = DockStyle.Fill, Text = "正在打开菜播·录包机…", TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 14) };
    private bool choosingFolder;
    private static readonly JavaScriptSerializer Json = new() { MaxJsonLength = 16 * 1024 * 1024 };

    public MainWindow(string projectRoot)
    {
        root = projectRoot; Text = "菜播·录包机";
        BackColor = Color.FromArgb(16, 20, 24); StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1460, 960); MinimumSize = new Size(1100, 720);
        using (var stream = typeof(MainWindow).Assembly.GetManifestResourceStream("LiveRecorderDesktop.app.ico")
            ?? throw new InvalidOperationException("未找到应用图标资源。"))
        using (var applicationIcon = new Icon(stream))
            Icon = (Icon)applicationIcon.Clone();
        Controls.Add(web); Controls.Add(splash);
        Shown += async (_, _) => await InitializeAsync();
    }


    private async Task InitializeAsync()
    {
        try
        {
            var app = RuntimeDependencies.ApplicationDirectory(root);
            if (!await IsServerReadyAsync(app))
            {
                var node = RuntimeDependencies.Resolve(root, "node", "node.exe", "NODE_EXE", "Node.js 24 或更新版本");
                var recorder = RuntimeDependencies.Resolve(root, "recorder", "BililiveRecorder.Cli.exe", "RECORDER_PATH", "录制核心");
                var ffmpeg = RuntimeDependencies.Resolve(root, "ffmpeg", "ffmpeg.exe", "FFMPEG_PATH", "FFmpeg");
                var ffprobe = RuntimeDependencies.Resolve(root, "ffmpeg", "ffprobe.exe", "FFPROBE_PATH", "FFprobe");
                RuntimeDependencies.CheckNodeVersion(node);
                var start = new ProcessStartInfo(node) { WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true };
                start.Arguments = "\"" + Path.Combine(app, "server", "index.js") + "\"";
                start.EnvironmentVariables["EDITOR_DATA"] = Path.Combine(app, "data");
                start.EnvironmentVariables["EDITOR_PROJECT_ROOT"] = root;
                start.EnvironmentVariables["EDITOR_PORT"] = "17860";
                start.EnvironmentVariables["RECORDER_PORT"] = "17861";
                start.EnvironmentVariables["RECORDER_PATH"] = recorder;
                start.EnvironmentVariables["FFMPEG_PATH"] = ffmpeg;
                start.EnvironmentVariables["FFPROBE_PATH"] = ffprobe;
                Process.Start(start)?.Dispose();
                var ready = false;
                for (var n = 0; n < 60 && !IsDisposed; n++)
                {
                    await Task.Delay(250);
                    if (await IsServerReadyAsync(app)) { ready = true; break; }
                }
                if (!ready) throw new IOException("后台服务未能启动，请检查项目的运行组件与端口 17860。");
            }
            // Windows supplies .NET Framework; ship only the small WebView2 interop files.
            var loader = RuntimeDependencies.DesktopFile(root, "WebView2Loader.dll") ?? throw new IOException("缺少 WebView2Loader.dll，请恢复程序组件/runtime/desktop 文件夹。");
            CoreWebView2Environment.SetLoaderDllFolderPath(Path.GetDirectoryName(loader)!);
            var profile = Environment.GetEnvironmentVariable("RECORDER_DESKTOP_PROFILE") ?? Path.Combine(app, "data", "desktop-profile");
            CoreWebView2Environment environment;
            try { environment = await CoreWebView2Environment.CreateAsync(null, profile); }
            catch (WebView2RuntimeNotFoundException)
            {
                throw new IOException("缺少 Microsoft Edge WebView2 Runtime。请安装微软官方 Evergreen WebView2 Runtime (x64)，然后重新打开菜播·录包机。下载地址：https://developer.microsoft.com/microsoft-edge/webview2/");
            }
            await web.EnsureCoreWebView2Async(environment);
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.IsZoomControlEnabled = false;
            web.CoreWebView2.NavigationStarting += (_, e) => { if (!IsLocal(e.Uri)) e.Cancel = true; };
            web.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
            web.CoreWebView2.WebMessageReceived += OnWebMessage;
            web.CoreWebView2.NavigationCompleted += (_, e) =>
            {
                if (e.IsSuccess) { splash.Hide(); web.Focus(); }
                else splash.Text = "界面加载失败，请关闭窗口后重新打开。\n后台录制不会因关闭窗口而停止。";
            };
            web.CoreWebView2.Navigate(Origin);
        }
        catch (Exception error)
        {
            splash.Text = "菜播·录包机暂时无法打开\n" + error.Message;
            try { File.AppendAllText(Path.Combine(RuntimeDependencies.ApplicationDirectory(root), "desktop-error.log"), $"{DateTimeOffset.Now:O} {error}\n"); } catch { }
            MessageBox.Show(this, error.Message, "菜播·录包机", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static bool IsLocal(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.GetLeftPart(UriPartial.Authority) == Origin;
    private static async Task<bool> IsServerReadyAsync(string app)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        string json;
        try { json = await client.GetStringAsync(Origin + "/api/state"); }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
        var state = Json.Deserialize<Dictionary<string, object>>(json);
        if (!state.TryGetValue("dataPath", out var data) || data is not string path || !string.Equals(Path.GetFullPath(path), Path.GetFullPath(Path.Combine(app, "data")), StringComparison.OrdinalIgnoreCase))
            throw new IOException("端口 17860 正由另一份项目使用。请先关闭另一份编辑服务，再打开此项目。");
        return true;
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsLocal(e.Source) || choosingFolder) return;
        string? id = null;
        try
        {
            var request = Json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            id = request.TryGetValue("id", out var rawId) ? rawId as string : null;
            if (id is null || id.Length > 100 || !request.TryGetValue("action", out var action) || action as string != "pickExportFolder") return;
            var initial = request.TryGetValue("initial", out var value) ? value as string : null;
            using var dialog = new FolderBrowserDialog { Description = "选择导出视频的保存文件夹", ShowNewFolderButton = true };
            if (initial is not null && initial.Length >= 3 && char.IsLetter(initial[0]) && initial[1] == ':' && (initial[2] == '\\' || initial[2] == '/') && Directory.Exists(initial)) dialog.SelectedPath = initial;
            choosingFolder = true;
            var selected = dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : null;
            web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new { id, value = selected }));
        }
        catch (Exception error) { if (id is not null) web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new { id, error = error.Message })); }
        finally { choosingFolder = false; }
    }
}
