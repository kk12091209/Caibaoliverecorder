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
    [STAThread]
    private static int Main(string[] args)
    {
        var maintenance = args.Length >= 1 && args[0] == "--prepare-maintenance";
        var root = RuntimeDependencies.ProjectRoot(maintenance ? (args.Length == 2 ? args[1] : AppContext.BaseDirectory) : Environment.GetEnvironmentVariable("RECORDER_PROJECT_ROOT") ?? AppContext.BaseDirectory);
        InitializeRuntime(root);
        if (maintenance) return PrepareMaintenance(root);
        RunApplication(root);
        return 0;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int PrepareMaintenance(string root) { try { using var backend = new BackendService(root); return backend.PrepareMaintenanceAsync().GetAwaiter().GetResult(); } catch { return 3; } }

    internal static string InstanceKey(string root)
    {
        using var sha = SHA256.Create();
        var data = Path.GetFullPath(Path.Combine(RuntimeDependencies.ApplicationDirectory(root), "data")).TrimEnd('\\', '/');
        return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(data.ToUpperInvariant()))).Replace("-", "").Substring(0, 32);
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
        var key = InstanceKey(root);
        using var activation = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CaiboActivate-" + key);
        using var shutdown = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CaiboShutdown-" + key);
        using var instance = new Mutex(true, "Local\\CaiboDesktop-" + key, out var first);
        if (!first)
        {
            activation.Set();
            return;
        }
        Application.Run(new MainWindow(root, activation, shutdown));
    }
}

internal sealed class MainWindow : Form
{
    private readonly string root;
    private readonly BackendService backend;
    private readonly EventWaitHandle activation;
    private readonly EventWaitHandle shutdownSignal;
    private readonly System.Windows.Forms.Timer health = new() { Interval = 2000 };
    private readonly NotifyIcon tray = new() { Text = "菜播·录包机" };
    private bool checking, closing, exitWhenReady, ready;
    private readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(20, 16, 18) };
    private readonly Label splash = new() { Dock = DockStyle.Fill, Text = "正在打开菜播·录包机…", TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 14) };
    private bool choosingFolder, choosingClose;
    private static readonly JavaScriptSerializer Json = new() { MaxJsonLength = 16 * 1024 * 1024 };

    public MainWindow(string projectRoot, EventWaitHandle activationSignal, EventWaitHandle shutdown)
    {
        root = projectRoot; Text = "菜播·录包机";
        activation = activationSignal; backend = new BackendService(root);
        shutdownSignal = shutdown;
        BackColor = Color.FromArgb(20, 16, 18); StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1460, 960); MinimumSize = new Size(1100, 720);
        using (var stream = typeof(MainWindow).Assembly.GetManifestResourceStream("LiveRecorderDesktop.app.ico")
            ?? throw new InvalidOperationException("未找到应用图标资源。"))
        using (var applicationIcon = new Icon(stream))
            Icon = (Icon)applicationIcon.Clone();
        tray.Icon = Icon;
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开菜播·录包机", null, (_, _) => RestoreWindow());
        menu.Items.Add("退出软件", null, async (_, _) => await RequestCloseAsync(true));
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => RestoreWindow();
        health.Tick += async (_, _) => await CheckBackendAsync();
        FormClosing += async (_, e) => { if (closing) return; e.Cancel = true; var external = e.CloseReason != CloseReason.UserClosing; await RequestCloseAsync(external, external); };
        FormClosed += (_, _) => { health.Stop(); health.Dispose(); tray.Visible = false; tray.Dispose(); backend.Dispose(); };
        Controls.Add(web); Controls.Add(splash);
        health.Start();
        Shown += async (_, _) => await InitializeAsync();
    }


    private async Task InitializeAsync()
    {
        try
        {
            var app = RuntimeDependencies.ApplicationDirectory(root);
            await backend.EnsureAsync();
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
            web.CoreWebView2.NewWindowRequested += (_, e) => { e.Handled = true; if (IsAuthorPage(e.Uri)) OpenAuthorPage(e.Uri); };
            web.CoreWebView2.WebMessageReceived += OnWebMessage;
            web.CoreWebView2.NavigationCompleted += (_, e) =>
            {
                if (e.IsSuccess) { splash.Hide(); web.Focus(); }
                else splash.Text = "界面加载失败，请关闭窗口后重新打开。\n后台录制不会因关闭窗口而停止。";
            };
            web.CoreWebView2.Navigate(backend.Origin);
            ready = true;
        }
        catch (Exception error)
        {
            if (IsDisposed || closing) return;
            splash.Text = "菜播·录包机暂时无法打开\n" + error.Message;
            try { File.AppendAllText(Path.Combine(RuntimeDependencies.ApplicationDirectory(root), "data", "desktop-error.log"), $"{DateTimeOffset.Now:O} {error}\n"); } catch { }
            MessageBox.Show(this, error.Message, "菜播·录包机", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private bool IsLocal(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.GetLeftPart(UriPartial.Authority) == backend.Origin;
    private static bool IsAuthorPage(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return false;
        return uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)
            && uri.Host.Equals("space.bilibili.com", StringComparison.OrdinalIgnoreCase)
            && uri.AbsolutePath.TrimEnd('/') == "/3546729402076115";
    }
    private static void OpenAuthorPage(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    private void RestoreWindow()
    {
        if (closing) return;
        Show(); WindowState = FormWindowState.Normal; Activate(); tray.Visible = false;
    }
    private void KeepInTray(string message)
    {
        tray.Visible = true; Hide();
        tray.ShowBalloonTip(4000, "菜播·录包机", message, ToolTipIcon.Info);
    }
    private async Task RequestCloseAsync(bool fullExit, bool maintenance = false)
    {
        if (choosingClose || closing || exitWhenReady) return;
        choosingClose = true;
        try
        {
            var status = await backend.HeartbeatAsync();
            var action = fullExit ? "exit" : status?.CloseAction;
            if (action != "exit" && action != "background")
            {
                using var dialog = new CloseChoiceDialog { Icon = Icon };
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                action = dialog.SelectedAction;
                if (dialog.RememberSelection) await backend.SaveCloseActionAsync(action);
            }
            if (action == "background")
            {
                KeepInTray("已在后台运行。"); return;
            }
            if (maintenance)
            {
                exitWhenReady = true;
                status = await backend.RequestExitAsync();
                if (status is null) { closing = true; Close(); }
                return;
            }
            status = await backend.RequestQuitAsync(false);
            if (status?.RequiresExitConfirmation == true)
            {
                using var confirmation = new ExitConfirmationDialog { Icon = Icon };
                if (confirmation.ShowDialog(this) != DialogResult.OK) return;
                status = await backend.RequestQuitAsync(true);
            }
            if (status?.QuitAccepted != true)
            {
                if (status is null && !backend.IsProcessAlive()) { closing = true; Close(); return; }
                throw new IOException("退出失败，请重试。");
            }
            closing = true; Close();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "菜播·录包机", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { choosingClose = false; }
    }
    private async Task CheckBackendAsync()
    {
        if (activation.WaitOne(0)) { RestoreWindow(); backend.RefreshBuild(); }
        if (checking || closing) return;
        if (!choosingClose && shutdownSignal.WaitOne(0)) { await RequestCloseAsync(true, true); return; }
        checking = true;
        try
        {
            var status = await backend.HeartbeatAsync();
            if (exitWhenReady)
            {
                if (status is null && !backend.IsProcessAlive()) { closing = true; Close(); }
                return;
            }
            if (status is not null && backend.MatchesBuild(status)) return;
            if (!ready) return;
            var previous = backend.Origin;
            await backend.EnsureAsync();
            if (!IsDisposed && backend.Origin != previous) web.CoreWebView2.Navigate(backend.Origin);
        }
        catch (Exception error)
        {
            if (!IsDisposed && Visible) { splash.Text = "正在恢复后台连接…\n" + error.Message; splash.Show(); }
        }
        finally { checking = false; }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsLocal(e.Source) || choosingFolder) return;
        string? id = null;
        try
        {
            var request = Json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            id = request.TryGetValue("id", out var rawId) ? rawId as string : null;
            var actionName = request.TryGetValue("action", out var action) ? action as string : null;
            if (actionName == "openExternal")
            {
                var url = request.TryGetValue("url", out var rawUrl) ? rawUrl as string : null;
                if (IsAuthorPage(url)) OpenAuthorPage(url!);
                return;
            }
            if (id is null || id.Length > 100 || actionName != "pickExportFolder") return;
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
