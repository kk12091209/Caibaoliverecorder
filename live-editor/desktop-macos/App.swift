import AppKit
import WebKit
import UniformTypeIdentifiers
import Darwin
import IOKit.pwr_mgt

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var backend: Backend!
    var statusItem: NSStatusItem!
    var timer: Timer?
    var polling = false, choosing = false, terminating = false, ready = false
    var fontPanelOpen = false
    var lockFD: Int32 = -1
    var sleepAssertion: IOPMAssertionID = 0
    var hasSleepAssertion = false
    var lastStatus: [String: Any] = [:]
    var connectionErrorShown = false
    var startupPanel: NSView!
    var startupTitle: NSTextField!
    var startupDetail: NSTextField!
    var startupRetry: NSButton!
    var startupLogs: NSButton!
    var pageNavigation: WKNavigation?
    var pageLoading = false, pageReady = false, pageFailed = false
    var pageDeadline: Date?
    var pageReadySince: Date?
    var pageGeneration = 0, pageRetries = 0
    let authorURL = "https://space.bilibili.com/5162836"

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let env = ProcessInfo.processInfo.environment
            pageRetries = min(3, max(0, Int(env["CAIBO_UI_RECOVERY_ATTEMPT"] ?? "0") ?? 0))
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            let data = URL(fileURLWithPath: env["CAIBO_DATA_ROOT"] ?? support.appendingPathComponent("Caibo/data").path).standardizedFileURL.resolvingSymlinksInPath()
            let movies = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
            let exports = URL(fileURLWithPath: env["CAIBO_EXPORT_ROOT"] ?? movies.appendingPathComponent("菜播·录包机").path)
            guard let resources = Bundle.main.resourceURL else { throw problem("应用资源目录不存在。") }
            backend = Backend(resources: resources, data: data, exports: exports)
            try backend.prepare()
            lockFD = Darwin.open(data.appendingPathComponent("desktop-window.lock").path, O_CREAT | O_RDWR, 0o600)
            guard lockFD >= 0 else { throw problem("无法创建窗口锁：\(data.path)") }
            if flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
                for app in NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "") where app.processIdentifier != ProcessInfo.processInfo.processIdentifier { app.activate(options: [.activateAllWindows]) }
                terminating = true; NSApp.terminate(nil); return
            }
            buildMenu(); buildWindow(); buildStatusItem()
            logStartup("开始启动；应用路径：\(Bundle.main.bundleURL.path)")
            Task { await connect() }
            timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in Task { @MainActor in await self?.poll() } }
        } catch { showError(error); terminating = true; NSApp.terminate(nil) }
    }
    func buildMenu() {
        let menu = NSMenu(); let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于菜播·录包机", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "显示主窗口", action: #selector(showWindow), keyEquivalent: "0").target = self
        appMenu.addItem(withTitle: "打开导出文件夹", action: #selector(openExports), keyEquivalent: "") .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏菜播·录包机", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出菜播·录包机", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let editItem = NSMenuItem(); let edit = NSMenu(title: "编辑")
        for (name, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] { edit.addItem(withTitle: name, action: Selector(selector), keyEquivalent: key) }
        editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
    }
    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "caibo")
        // Let the page report liveness. Waiting for evaluateJavaScript on a
        // hung engine can retain the old view even after it is replaced.
        let heartbeat = """
        (() => {
            const report = () => {
                if (document.getElementById('app')?.childElementCount > 0)
                    window.webkit.messageHandlers.caibo.postMessage({action: 'interfaceReady'});
            };
            document.addEventListener('DOMContentLoaded', report, {once: true});
            setInterval(report, 2000);
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: heartbeat, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self; view.uiDelegate = self
        if #available(macOS 13.3, *) { view.isInspectable = ProcessInfo.processInfo.environment["CAIBO_INSPECT"] == "1" }
        return view
    }
    func buildWindow() {
        web = makeWebView()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 880), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "菜播·录包机"; window.minSize = NSSize(width: 980, height: 660)
        let content = NSView(frame: window.contentLayoutRect)
        web.frame = content.bounds; web.autoresizingMask = [.width, .height]
        content.addSubview(web)
        startupPanel = NSView(frame: content.bounds); startupPanel.autoresizingMask = [.width, .height]
        startupPanel.wantsLayer = true; startupPanel.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        startupTitle = NSTextField(labelWithString: "正在启动菜播·录包机")
        startupTitle.font = .systemFont(ofSize: 22, weight: .semibold)
        startupDetail = NSTextField(wrappingLabelWithString: "正在连接本地服务，请稍候。")
        startupDetail.font = .systemFont(ofSize: 14); startupDetail.alignment = .center
        startupRetry = NSButton(title: "重试", target: self, action: #selector(retryStartup))
        startupLogs = NSButton(title: "打开日志文件夹", target: self, action: #selector(openStartupLogs))
        let buttons = NSStackView(views: [startupRetry, startupLogs]); buttons.orientation = .horizontal; buttons.spacing = 12
        let stack = NSStackView(views: [startupTitle, startupDetail, buttons])
        stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false; startupPanel.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: startupPanel.centerXAnchor), stack.centerYAnchor.constraint(equalTo: startupPanel.centerYAnchor), startupDetail.widthAnchor.constraint(equalToConstant: 560)])
        startupRetry.isHidden = true; startupLogs.isHidden = true
        content.addSubview(startupPanel)
        window.contentView = content; window.delegate = self; window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("CaiboMainWindow"); window.center()
        showWindow()
    }
    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: "菜播·录包机")
        statusItem.button?.toolTip = "菜播·录包机"
        let menu = NSMenu()
        menu.addItem(withTitle: "显示主窗口", action: #selector(showWindow), keyEquivalent: "").target = self
        menu.addItem(withTitle: "打开导出文件夹", action: #selector(openExports), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem.menu = menu
    }
    @objc func showWindow() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func openExports() {
        Task {
            guard let origin = backend.origin else { return }
            var request = URLRequest(url: origin.appendingPathComponent("api/folders/open"))
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{\"kind\":\"exports\"}".utf8)
            do { let (_,response) = try await URLSession.shared.data(for: request); if (response as? HTTPURLResponse)?.statusCode != 200 { throw problem("无法打开导出文件夹，请在设置中检查保存路径。") } } catch { showError(error) }
        }
    }
    func connect() async {
        guard !backend.connecting, !backend.exitRequested, !terminating else { return }
        do {
            try backend.validateInterface()
            let wasReady = ready
            lastStatus = try await backend.ensure(); ready = true; connectionErrorShown = false
            if pageRetries >= 3 { pageFailed = true; showStartupFailure("自动恢复连续失败，已暂停重试。原有录像和设置会保留。") }
            else if let origin = backend.origin, !wasReady || web.url?.host != origin.host || web.url?.port != origin.port || (!pageReady && !pageLoading && !pageFailed) { loadPage(origin) }
            updateSleep(lastStatus)
        } catch {
            if !connectionErrorShown { connectionErrorShown = true; logStartup("启动失败：\(error.localizedDescription)") }
            ready = false; pageLoading = false; pageDeadline = nil; pageFailed = true
            showStartupFailure(error.localizedDescription)
        }
    }
    func poll() async {
        // A stuck WebContent process must not block the native timeout or the
        // backend heartbeat. Keep this check outside the in-flight guards.
        if (pageLoading || pageReady), !choosing, !terminating, !backend.exitRequested, let deadline = pageDeadline, Date() >= deadline {
            failPage(pageReady ? "界面暂时无响应。" : "界面加载超时。", retry: true)
        }
        if pageReady, let since = pageReadySince, Date().timeIntervalSince(since) >= 60 { pageRetries = 0 }
        // Browsing fonts can take longer than the backend client timeout.
        guard !polling, (!choosing || fontPanelOpen), !backend.connecting, !backend.exitRequested, !terminating else { return }
        polling = true; defer { polling = false }
        backend.readEndpoint()
        if let status = await backend.heartbeat(), status["stopping"] as? Bool != true {
            lastStatus = status; updateSleep(status)
            if let origin = backend.origin, !pageFailed && (web.url?.host != origin.host || web.url?.port != origin.port) && !pageLoading { loadPage(origin) }
            if status["build"] as? String != backend.expectedBuild { await connect() }
        } else { await connect() }
    }
    func logStartup(_ message: String) {
        let file = backend.data.appendingPathComponent("desktop-startup.log")
        let text = "\(ISO8601DateFormatter().string(from: Date())) [\(getpid())] \(message.prefix(2000))\n"
        do {
            if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let log = try FileHandle(forWritingTo: file); defer { try? log.close() }
            try log.seekToEnd(); try log.write(contentsOf: Data(text.utf8))
        } catch { /* A diagnostic failure must never prevent startup. */ }
    }
    func loadPage(_ origin: URL) {
        pageGeneration += 1; pageLoading = true; pageReady = false; pageFailed = false; pageReadySince = nil
        pageDeadline = Date().addingTimeInterval(30)
        startupPanel.isHidden = false; startupTitle.stringValue = "正在打开界面"
        startupDetail.stringValue = "本地服务已连接，正在加载界面，请稍候。"
        startupRetry.isHidden = true; startupLogs.isHidden = true
        window.title = "菜播·录包机 · 正在加载"
        logStartup("加载界面；尝试 \(pageRetries + 1)")
        pageNavigation = web.load(URLRequest(url: origin))
    }
    func showStartupFailure(_ message: String) {
        startupPanel.isHidden = false; startupTitle.stringValue = "暂时无法打开界面"
        startupDetail.stringValue = message + "\n可点击“重试”重新连接，录像和设置会保留。"
        startupRetry.isHidden = false; startupLogs.isHidden = false
        window.title = "菜播·录包机 · 启动未完成"
    }
    func failPage(_ message: String, retry: Bool) {
        guard !terminating, !pageFailed else { return }
        pageGeneration += 1; pageLoading = false; pageReady = false; pageFailed = true; pageDeadline = nil; pageReadySince = nil
        web.stopLoading(); logStartup("界面加载失败：\(message)")
        guard retry, let origin = backend.origin else { showStartupFailure(message); return }
        if pageRetries >= 2 {
            Task { @MainActor in
                do { try await self.restartInterface(attempt: 3) }
                catch { self.showStartupFailure(message + "\n" + error.localizedDescription) }
            }
            return
        }
        pageRetries += 1
        startupPanel.isHidden = false; startupTitle.stringValue = "正在自动恢复界面"
        startupDetail.stringValue = "正在重新连接，请稍候。录像和后台任务会继续保留。"
        startupRetry.isHidden = true; startupLogs.isHidden = true
        window.title = "菜播·录包机 · 正在恢复"
        logStartup("自动恢复界面；恢复 \(pageRetries)")
        let generation = pageGeneration
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !self.terminating, !self.backend.exitRequested, generation == self.pageGeneration, self.backend.origin == origin else { return }
            do { try self.backend.validateInterface(); try await self.restartInterface(attempt: self.pageRetries) }
            catch { self.logStartup("界面文件检查失败：\(error.localizedDescription)"); self.showStartupFailure(error.localizedDescription) }
        }
    }
    func restartInterface(attempt: Int) async throws {
        let helper = Process()
        helper.executableURL = backend.resources.appendingPathComponent("runtime/node/node")
        helper.arguments = [backend.appRoot.appendingPathComponent("server/interface-recovery.js").path, String(getpid()), Bundle.main.bundleURL.path, backend.data.path, String(attempt)]
        var env = ProcessInfo.processInfo.environment; env["CAIBO_EXPORT_ROOT"] = backend.exports.path
        helper.environment = env
        let log = try FileHandle(forWritingTo: backend.data.appendingPathComponent("desktop-startup.log"))
        try log.seekToEnd(); helper.standardOutput = log; helper.standardError = log
        do { try helper.run(); try log.close() } catch { try? log.close(); throw error }
        guard await backend.call(["action": "heartbeat", "client": UUID().uuidString, "pid": Int(helper.processIdentifier)]) != nil else { throw problem("后台连接暂时中断，请稍后重试。") }
        // The independent helper retains the backend lease until the new UI
        // connects. Exiting our GUI also releases its stuck WebKit processes.
        logStartup("自动重启界面；恢复 \(attempt)")
        terminating = true; NSApp.terminate(nil)
    }
    func resetWebView() {
        // A blocked JavaScript engine may never answer reload/evaluation.
        // Replace only the view; the recording service and its data stay live.
        let previous = web!
        previous.navigationDelegate = nil; previous.uiDelegate = nil
        previous.configuration.userContentController.removeScriptMessageHandler(forName: "caibo")
        web = makeWebView(); web.frame = previous.frame; web.autoresizingMask = [.width, .height]
        previous.superview?.addSubview(web, positioned: .below, relativeTo: startupPanel)
        previous.removeFromSuperview(); pageNavigation = nil
    }
    @objc func retryStartup() {
        guard !backend.connecting, !backend.exitRequested, !choosing, !terminating else { return }
        resetWebView()
        pageGeneration += 1; pageRetries = 0; pageReady = false; pageLoading = false; pageFailed = false
        connectionErrorShown = false; logStartup("用户重试启动")
        startupTitle.stringValue = "正在重新连接"; startupDetail.stringValue = "正在重新连接本地服务，请稍候。"
        startupRetry.isHidden = true; startupLogs.isHidden = true
        Task { await connect() }
    }
    @objc func openStartupLogs() { NSWorkspace.shared.open(backend.data) }
    func updateSleep(_ status: [String: Any]) {
        let busy = status["busy"] as? Bool == true
        if busy && !hasSleepAssertion {
            hasSleepAssertion = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "菜播正在录制或处理视频" as CFString, &sleepAssertion) == kIOReturnSuccess
        } else if !busy && hasSleepAssertion { IOPMAssertionRelease(sleepAssertion); hasSleepAssertion = false }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func windowShouldClose(_ sender: NSWindow) -> Bool { Task { await requestClose() }; return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateNow }
        Task { await requestQuit() }; return .terminateCancel
    }
    func requestClose() async {
        guard !choosing, !terminating else { return }
        choosing = true; defer { choosing = false }
        guard ready, let status = await backend.call() else { await quitCore(); return }
        var action = status["closeAction"] as? String ?? "ask"
        if action == "ask" {
            let alert = NSAlert(); alert.messageText = "关闭窗口时"; alert.informativeText = "退出会安全停止任务，下次启动可继续；后台运行会保持录制与导出。"
            alert.addButton(withTitle: "后台运行"); alert.addButton(withTitle: "退出"); alert.addButton(withTitle: "取消")
            alert.showsSuppressionButton = true; alert.suppressionButton?.title = "不再提示"
            let result = alert.runModal(); if result == .alertThirdButtonReturn { return }
            action = result == .alertFirstButtonReturn ? "background" : "exit"
            if alert.suppressionButton?.state == .on { _ = await backend.call(["action": "setCloseAction", "closeAction": action]) }
        }
        if action == "background" { window.orderOut(nil) } else { await quitCore() }
    }
    func requestQuit() async {
        guard !choosing, !terminating else { return }
        choosing = true; defer { choosing = false }; await quitCore()
    }
    func quitCore() async {
        guard let status = await backend.call() else {
            // On startup failure only our known child can keep running. Do not
            // terminate a guessed PID or abandon a possibly live data writer.
            let hasEndpoint = backend.readEndpoint()
            let serviceAlive = hasEndpoint && backend.endpoint.map { Darwin.kill($0.pid, 0) == 0 || errno != ESRCH } == true
            if backend.process?.isRunning != true && !serviceAlive { backend.exitRequested = true; terminating = true; NSApp.terminate(nil) }
            else { showError(problem("无法连接后台确认任务状态，请稍后重试。")) }
            return
        }
        var confirmed = false
        if status["requiresExitConfirmation"] as? Bool == true {
            let alert = NSAlert(); alert.messageText = "退出菜播·录包机？"; alert.informativeText = "正在录制或导出。退出后会停止当前任务，下次启动恢复；关闭期间的直播无法补录。"
            alert.addButton(withTitle: "继续运行"); alert.addButton(withTitle: "退出")
            guard alert.runModal() == .alertSecondButtonReturn else { return }; confirmed = true
        }
        guard let result = await backend.call(["action": "quit", "confirmed": confirmed]), result["quitAccepted"] as? Bool == true else {
            showError(problem("任务状态已变化或退出尚未受理，请重试。")); return
        }
        backend.exitRequested = true
        window.title = "菜播·录包机 · 正在停止任务并退出…"
        statusItem.button?.toolTip = "正在停止任务并退出…"
        do {
            try await backend.waitForExit()
            terminating = true; NSApp.terminate(nil)
        } catch {
            backend.exitRequested = false
            window.title = "菜播·录包机 · 退出未完成"
            statusItem.button?.toolTip = "退出未完成，请重试"
            showWindow(); showError(error)
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if hasSleepAssertion { IOPMAssertionRelease(sleepAssertion) }
        if lockFD >= 0 { Darwin.close(lockFD) }
    }
    func trusted(_ url: URL?) -> Bool { guard let url, let origin = backend.origin else { return false }; return url.scheme == "http" && url.host == "127.0.0.1" && url.port == origin.port }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.request.url?.absoluteString == authorURL { NSWorkspace.shared.open(URL(string: authorURL)!); decisionHandler(.cancel) }
        else { decisionHandler(trusted(navigationAction.request.url) ? .allow : .cancel) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.request.url?.absoluteString == authorURL { NSWorkspace.shared.open(URL(string: authorURL)!) }; return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard webView === web, frame.isMainFrame, trusted(frame.request.url), trusted(webView.url), !choosing, !terminating else { completionHandler(nil); return }
        choosing = true; fontPanelOpen = true
        let origin = backend.endpoint?.origin
        let panel = NSOpenPanel()
        panel.title = "选择弹幕字体文件"; panel.prompt = "导入字体"
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = ["ttf", "otf"].compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self else { completionHandler(nil); return }
            self.fontPanelOpen = false; self.choosing = false
            guard !self.terminating, self.backend.endpoint?.origin == origin, self.trusted(self.web.url) else { completionHandler(nil); return }
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard navigation === pageNavigation, (error as NSError).code != NSURLErrorCancelled else { return }
        failPage("界面连接失败：\(error.localizedDescription)", retry: true)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard navigation === pageNavigation, (error as NSError).code != NSURLErrorCancelled else { return }
        failPage("界面加载中断：\(error.localizedDescription)", retry: true)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === web else { return }
        failPage("界面进程意外停止，正在尝试恢复。", retry: true)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard controller === web.configuration.userContentController, message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), let input = message.body as? [String: Any] else { return }
        if input["action"] as? String == "interfaceReady" {
            guard (pageLoading || pageReady), !pageFailed, !terminating, !backend.exitRequested else { return }
            let wasReady = pageReady
            pageLoading = false; pageReady = true; pageDeadline = Date().addingTimeInterval(30)
            if !wasReady {
                pageReadySince = Date(); startupPanel.isHidden = true; window.title = "菜播·录包机"
                logStartup("界面已就绪")
            }
            return
        }
        if input["action"] as? String == "openExternal", input["url"] as? String == authorURL { NSWorkspace.shared.open(URL(string: authorURL)!); return }
        if input["action"] as? String == "applyUpdate", let id = input["id"] as? String, id.count <= 100, !choosing {
            choosing = true
            Task { @MainActor in
                defer { self.choosing = false }
                var reply: [String: Any] = ["id": id]
                let result = await self.backend.call(["action": "applyUpdate", "target": Bundle.main.bundleURL.resolvingSymlinksInPath().path, "guiPid": Int(getpid())], timeout: 120)
                if result?["quitAccepted"] as? Bool == true {
                    self.backend.exitRequested = true
                    self.window.title = "菜播·录包机 · 正在更新"
                    do {
                        try await self.backend.waitForExit()
                        self.terminating = true
                        NSApp.terminate(nil)
                    } catch {
                        self.backend.exitRequested = false
                        _ = await self.backend.call(["action": "cancelUpdate"])
                        reply["error"] = "更新退出未完成：\(error.localizedDescription)。原版本保留，请重试。"
                    }
                } else { reply["error"] = result?["error"] as? String ?? "更新准备失败。请稍后重试。" }
                if let bytes = try? JSONSerialization.data(withJSONObject: reply), let json = String(data: bytes, encoding: .utf8) { _ = try? await self.web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('caibo-native',{detail:\(json)}))") }
            }
            return
        }
        guard input["action"] as? String == "pickExportFolder", let id = input["id"] as? String, !choosing else { return }
        choosing = true
        let origin = backend.endpoint?.origin
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true; panel.allowsMultipleSelection = false; panel.prompt = "选择文件夹"
        if let initial = input["initial"] as? String, initial.hasPrefix("/") { panel.directoryURL = URL(fileURLWithPath: initial) }
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self else { return }; self.choosing = false
            guard self.backend.endpoint?.origin == origin, self.trusted(self.web.url) else { return }
            let value: Any = result == .OK ? (panel.url?.path as Any? ?? NSNull()) : NSNull()
            if let bytes = try? JSONSerialization.data(withJSONObject: ["id": id, "value": value]), let json = String(data: bytes, encoding: .utf8) { self.web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('caibo-native',{detail:\(json)}))", completionHandler: nil) }
        }
    }
    func showError(_ error: Error) { let alert = NSAlert(); alert.messageText = "菜播·录包机"; alert.informativeText = error.localizedDescription; alert.addButton(withTitle: "好"); alert.runModal() }
}
@main struct CaiboMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
