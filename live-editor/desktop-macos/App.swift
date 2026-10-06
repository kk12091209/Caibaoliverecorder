import AppKit
import WebKit
import UniformTypeIdentifiers
import Darwin
import SQLite3
import IOKit.pwr_mgt

@MainActor struct UninstallDataLease {
    private var handles: [OpaquePointer] = []
    static func acquire(data: URL) throws -> UninstallDataLease {
        var lease = UninstallDataLease()
        do {
            for (index, name) in ["desktop-recovery.lock.sqlite", "desktop-service.lock.sqlite"].enumerated() {
                let file = data.appendingPathComponent(name)
                if let attributes = try? FileManager.default.attributesOfItem(atPath: file.path), attributes[.type] as? FileAttributeType == .typeSymbolicLink { throw problem("后台锁文件异常，卸载已取消，数据保留。") }
                var handle: OpaquePointer?
                let opened = sqlite3_open_v2(file.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil)
                guard opened == SQLITE_OK, let handle else { if let handle { sqlite3_close(handle) }; throw problem("无法核实后台锁，卸载已取消，数据保留。") }
                lease.handles.append(handle)
                let result = sqlite3_exec(handle, "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;", nil, nil, nil)
                // The repair lock is always required. A damaged primary lease
                // cannot have a normal owner; retain it while preventing any
                // new backend from repairing/opening the data during removal.
                guard result == SQLITE_OK || index == 1 && [SQLITE_NOTADB, SQLITE_CORRUPT].contains(result) else { throw problem("后台仍在使用数据或锁无法读取，卸载已取消，文件保留。") }
            }
            return lease
        } catch { lease.close(); throw error }
    }
    mutating func close() {
        for handle in handles.reversed() { sqlite3_exec(handle, "ROLLBACK;", nil, nil, nil); sqlite3_close(handle) }
        handles.removeAll()
    }
}

@MainActor enum CompleteUninstall {
    static func validate(app: URL, data: URL) throws {
        let files = FileManager.default, home = files.homeDirectoryForCurrentUser.standardizedFileURL
        guard app.pathExtension == "app", files.fileExists(atPath: app.path),
              data.lastPathComponent == "data", data.path != home.path, data.path != "/",
              !app.path.hasPrefix(data.path + "/"), !data.path.hasPrefix(app.path + "/"),
              OwnedProcess.samePath(app.path, app.resolvingSymlinksInPath().path),
              OwnedProcess.samePath(data.path, data.resolvingSymlinksInPath().path),
              files.isWritableFile(atPath: app.deletingLastPathComponent().path),
              files.isWritableFile(atPath: data.deletingLastPathComponent().path) else {
            throw problem("无法安全移除此安装或数据目录，请先将应用安装到可写入的应用程序文件夹。")
        }
        let volume = try app.resourceValues(forKeys: [.volumeIsReadOnlyKey])
        guard volume.volumeIsReadOnly != true else { throw problem("当前应用位于只读安装盘，请从应用程序文件夹运行后完整卸载。") }
    }
    static func recycle(app: URL, data: URL) async throws {
        try validate(app: app, data: data)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            NSWorkspace.shared.recycle([app, data]) { _, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }
}

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
    var connectionInFlight = false, retryRequested = false
    var connectionPaused = false
    var connectionStarted: Date?
    var backendRecoveryAttempts = 0
    var repairing = false, repairAttempted = ProcessInfo.processInfo.environment["CAIBO_REPAIR_ATTEMPT"] == "1"
    var repairProgress = "", bundleChecked = false
    var nextReconnectAt = Date.distantPast
    var reconnectDelay: TimeInterval = 5
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
            backend.onDiagnostic = { [weak self] message in self?.logStartup(message, forward: false) }
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(systemDidWake), name: NSWorkspace.didWakeNotification, object: nil)
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
        appMenu.addItem(withTitle: "打开原始录像文件夹", action: #selector(openOriginals), keyEquivalent: "").target = self
        appMenu.addItem(withTitle: "完整卸载…", action: #selector(completeUninstall), keyEquivalent: "").target = self
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
        let originals = NSButton(title: "打开原始录像文件夹", target: self, action: #selector(openOriginals))
        let buttons = NSStackView(views: [startupRetry, startupLogs, originals]); buttons.orientation = .horizontal; buttons.spacing = 12
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
    func renewInterfaceDeadline() { if pageLoading || pageReady { pageDeadline = Date().addingTimeInterval(30) } }
    @objc func showWindow() { renewInterfaceDeadline(); window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func applicationDidBecomeActive(_ notification: Notification) { renewInterfaceDeadline() }
    func windowDidDeminiaturize(_ notification: Notification) { renewInterfaceDeadline() }
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
        guard !connectionInFlight, !connectionPaused, !backend.connecting, !backend.exitRequested, !terminating else { return }
        connectionInFlight = true; connectionStarted = Date()
        defer {
            connectionInFlight = false; connectionStarted = nil
            let queued = retryRequested; retryRequested = false
            if queued && !ready && !backend.exitRequested && !terminating { Task { await connect() } }
        }
        if !pageReady { showConnecting() }
        while !backend.exitRequested && !terminating {
          do {
            try await backend.validateComponents()
            let wasReady = ready
            lastStatus = try await backend.ensure(); ready = true
            reconnectDelay = 5; nextReconnectAt = .distantPast
            if pageRetries >= 3 { pageFailed = true; showStartupFailure("自动恢复连续失败，已暂停重试。原有录像和设置会保留。") }
            else if let origin = backend.origin, !wasReady || web.url?.host != origin.host || web.url?.port != origin.port || (!pageReady && !pageLoading && !pageFailed) { loadPage(origin) }
            updateSleep(lastStatus)
            logStartup("后台重连成功；\(pageLoading ? "正在加载界面" : "界面状态已检查")")
            return
          } catch {
            if backend.exitRequested || terminating { logStartup("后台连接检查结束：软件正在退出"); return }
            logStartup("启动失败：\(error.localizedDescription)")
            ready = false; pageLoading = false; pageReady = false; pageReadySince = nil; pageDeadline = nil; pageFailed = true
            if error is MissingComponent {
                await repairComponents(error.localizedDescription); return
            }
            if !(error is StartupPaused), !backend.exitRequested && !terminating && backendRecoveryAttempts < 2 {
                let recovered = await backend.recoverOwnedProcess()
                if backend.ownedRecoveryAttempted { backendRecoveryAttempts += 1 }
                if recovered {
                    resetWebView(); showConnecting(); continue
                }
            }
            if (backendRecoveryAttempts >= 2 || backend.launchAttempts >= 3) && !bundleChecked {
                bundleChecked = true
                do { try await Task.detached { _ = try OwnedProcess.command("/usr/bin/codesign", ["--verify", "--deep", "--strict", Bundle.main.bundleURL.path]) }.value }
                catch { await repairComponents("应用组件完整性检查未通过"); return }
            }
            if error is StartupPaused || backendRecoveryAttempts >= 2 || backend.launchAttempts >= 3 {
                connectionPaused = true
                logStartup("连续恢复失败，已暂停自动重启；保留录像和设置，等待用户重试或后台自行恢复")
                showStartupFailure(StartupPaused().localizedDescription)
                return
            }
            nextReconnectAt = Date().addingTimeInterval(reconnectDelay)
            logStartup("本次重连未成功；\(Int(reconnectDelay)) 秒后再次检查；录像和设置保留")
            reconnectDelay = min(30, reconnectDelay * 2)
            showStartupFailure(error.localizedDescription)
            return
          }
        }
    }
    func showConnecting() {
        startupPanel.isHidden = false; startupTitle.stringValue = "正在尝试重新连接"
        let seconds = Int(Date().timeIntervalSince(connectionStarted ?? Date()))
        startupDetail.stringValue = "\(backend.connectionProgress)\(seconds > 0 ? "，已等待 \(seconds) 秒" : "")。\n录像和设置会保留，请稍候。"
        startupRetry.isHidden = false; startupRetry.isEnabled = false
        startupLogs.isHidden = false
        window.title = "菜播·录包机 · 正在重连"
    }
    func poll() async {
        // A stuck WebContent process must not block the native timeout or the
        // backend heartbeat. Keep this check outside the in-flight guards.
        let visible = window.isVisible && window.occlusionState.contains(.visible) && !window.isMiniaturized && !NSApp.isHidden
        if !visible { renewInterfaceDeadline() }
        if visible, (pageLoading || pageReady), !choosing, !terminating, !backend.exitRequested, let deadline = pageDeadline, Date() >= deadline {
            failPage(pageReady ? "界面暂时无响应。" : "界面加载超时。", retry: true)
        }
        if pageReady, let since = pageReadySince, Date().timeIntervalSince(since) >= 60 { pageRetries = 0; backendRecoveryAttempts = 0; backend.resetRecoveryBudget(); bundleChecked = false }
        if repairing {
            _ = await backend.heartbeat(); showRepairProgress(); return
        }
        if connectionInFlight && !pageReady { backend.refreshConnectionDetail(); showConnecting() }
        // Browsing fonts can take longer than the backend client timeout.
        guard !polling, (!choosing || fontPanelOpen), !connectionInFlight, !backend.connecting, !backend.exitRequested, !terminating else { return }
        polling = true; defer { polling = false }
        backend.readEndpoint()
        if let status = await backend.heartbeat(), status["stopping"] as? Bool != true {
            lastStatus = status; updateSleep(status)
            // A backend timeout is different from an exhausted WebKit retry.
            // Re-enter connect even when the recovered backend has the same build.
            if !ready { connectionPaused = false; await connect(); return }
            if let origin = backend.origin, !pageFailed && (web.url?.host != origin.host || web.url?.port != origin.port) && !pageLoading { loadPage(origin) }
            if status["build"] as? String != backend.expectedBuild { await connect() }
        } else if !connectionPaused && Date() >= nextReconnectAt { await connect() }
    }
    func logStartup(_ message: String, forward: Bool = true) {
        if forward { Task { _ = await backend.call(["action": "diagnostic", "message": String(message.prefix(2000)), "warning": message.contains("失败") || message.contains("异常")]) } }
        let file = backend.data.appendingPathComponent("desktop-startup.log")
        let text = "\(ISO8601DateFormatter().string(from: Date())) [\(getpid())] \(message.prefix(2000))\n"
        do {
            if let attributes = try? FileManager.default.attributesOfItem(atPath: file.path), let size = attributes[.size] as? NSNumber, size.intValue > 512 * 1024 { try? FileManager.default.removeItem(at: file) }
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
        startupRetry.isEnabled = true
        window.title = "菜播·录包机 · 启动未完成"
    }
    func showRepairProgress() {
        startupPanel.isHidden = false; startupTitle.stringValue = "正在自动修复"
        startupDetail.stringValue = repairProgress + "\n录像、设置和日志会保留，请稍候。"
        startupRetry.isHidden = false; startupRetry.isEnabled = false; startupLogs.isHidden = false
        window.title = "菜播·录包机 · 正在修复"
    }
    func repairComponents(_ reason: String) async {
        guard !repairing, !backend.exitRequested, !terminating else { return }
        let ledger = backend.data.appendingPathComponent("desktop-repair-attempt.json")
        if let bytes = try? Data(contentsOf: ledger), let item = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
           let time = item["time"] as? Double, (0..<600).contains(Date().timeIntervalSince1970 - time) { repairAttempted = true }
        guard !repairAttempted else { connectionPaused = true; showStartupFailure("自动修复未完成，已暂停重复下载。请检查网络或安装目录权限后点击重试。\n" + reason); return }
        repairAttempted = true; repairing = true
        defer { repairing = false }
        try? JSONSerialization.data(withJSONObject: ["time": Date().timeIntervalSince1970]).write(to: ledger, options: .atomic)
        repairProgress = "正在检查官方修复包"; showRepairProgress(); logStartup("触发组件自动修复：\(reason)")
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let repair = ComponentRepair(target: Bundle.main.bundleURL, data: backend.data, version: version, progress: { [weak self] message in
            self?.repairProgress = message; self?.showRepairProgress()
        }, log: { [weak self] message in self?.logStartup(message, forward: false) })
        var staged: URL?
        defer {
            if !terminating, let staged { try? Data().write(to: staged.deletingLastPathComponent().appendingPathComponent("cancel")) }
        }
        do {
            let request = try await repair.stage()
            staged = request
            guard !backend.exitRequested, !terminating else { return }
            // Ask a healthy writer to checkpoint its tasks before replacement.
            if await backend.call() != nil {
                guard await backend.call(["action": "quit", "confirmed": true])?["quitAccepted"] as? Bool == true else { throw problem("后台尚未完成任务保存，已保留原应用。") }
                try await backend.waitForExit()
            } else if backend.process?.isRunning == true || (backend.readEndpoint() && OwnedProcess.inspect(backend.endpoint?.pid ?? 0) != nil) {
                guard await backend.recoverOwnedProcess() else { throw problem("无法确认后台已停止，修复包已暂存，原应用已保留。") }
            }
            _ = await backend.recoverOrphanedComponents()
            guard !backend.exitRequested, !terminating else { return }
            let helper = Process(); helper.executableURL = request.deletingLastPathComponent().appendingPathComponent("repair-helper")
            helper.arguments = ["--repair-apply", request.path]
            var env = ProcessInfo.processInfo.environment; env["CAIBO_DATA_ROOT"] = backend.data.path; env["CAIBO_EXPORT_ROOT"] = backend.exports.path
            helper.environment = env; helper.standardInput = FileHandle.nullDevice; helper.standardOutput = FileHandle.nullDevice; helper.standardError = FileHandle.nullDevice
            try helper.run()
            for _ in 0..<300 {
                let status = (try? Data(contentsOf: request.deletingLastPathComponent().appendingPathComponent("status.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                if status?["status"] as? String == "ready" {
                    logStartup("修复包已校验并暂存；自动退出界面、替换组件并重新启动")
                    terminating = true; NSApp.terminate(nil); return
                }
                if !helper.isRunning || status?["status"] as? String == "error" { throw problem(status?["error"] as? String ?? "修复助手未能启动。") }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw problem("修复准备超时，原应用和数据已保留。")
        } catch {
            connectionPaused = true
            logStartup("自动修复失败：\(error.localizedDescription)", forward: false)
            showStartupFailure("自动修复暂未完成：\(error.localizedDescription)")
        }
    }
    func failPage(_ message: String, retry: Bool) {
        guard !terminating, !pageFailed else { return }
        if retry, !window.isVisible || !window.occlusionState.contains(.visible) || window.isMiniaturized || NSApp.isHidden {
            pageLoading = true; pageDeadline = Date().addingTimeInterval(30)
            return
        }
        pageGeneration += 1; pageLoading = false; pageReady = false; pageFailed = true; pageDeadline = nil; pageReadySince = nil
        web.stopLoading(); logStartup("界面加载失败：\(message)")
        guard retry, let origin = backend.origin else { showStartupFailure(message); return }
        if pageRetries >= 2 {
            Task { @MainActor in
                do { try await self.restartInterface(attempt: 3) }
                catch {
                    if error is MissingComponent { await self.repairComponents(error.localizedDescription) }
                    else { self.showStartupFailure(message + "\n" + error.localizedDescription) }
                }
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
            catch {
                self.logStartup("界面文件检查失败：\(error.localizedDescription)")
                if error is MissingComponent { await self.repairComponents(error.localizedDescription) }
                else { self.showStartupFailure(error.localizedDescription) }
            }
        }
    }
    func restartInterface(attempt: Int) async throws {
        try await backend.validateComponents()
        let helper = Process()
        helper.executableURL = backend.resources.appendingPathComponent("runtime/node/node")
        helper.arguments = [backend.appRoot.appendingPathComponent("server/interface-recovery.js").path, String(getpid()), Bundle.main.bundleURL.path, backend.data.path, String(attempt)]
        var env = ProcessInfo.processInfo.environment; env["CAIBO_EXPORT_ROOT"] = backend.exports.path
        helper.environment = env
        let log = try FileHandle(forWritingTo: backend.data.appendingPathComponent("desktop-startup.log"))
        try log.seekToEnd(); helper.standardOutput = log; helper.standardError = log
        do { try helper.run(); try log.close() } catch { try? log.close(); throw error }
        guard await backend.call(["action": "heartbeat", "clientKind": "recovery", "client": UUID().uuidString, "pid": Int(helper.processIdentifier)]) != nil else { throw problem("后台连接暂时中断，请稍后重试。") }
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
        guard !backend.exitRequested, !choosing, !terminating else { return }
        logStartup("用户重试启动")
        if repairing { showRepairProgress(); return }
        if connectionInFlight || backend.connecting {
            retryRequested = true; showConnecting()
            logStartup("已收到用户重试；后台检查正在进行，失败后继续重试，不重复启动进程")
            return
        }
        resetWebView()
        repairAttempted = false
        try? FileManager.default.removeItem(at: backend.data.appendingPathComponent("desktop-repair-attempt.json"))
        pageGeneration += 1; pageRetries = 0; pageReady = false; pageLoading = false; pageFailed = false
        ready = false; backendRecoveryAttempts = 0; backend.resetRecoveryBudget(); connectionPaused = false; nextReconnectAt = .distantPast; reconnectDelay = 5
        showConnecting()
        Task { await connect() }
    }
    @objc func openStartupLogs() { NSWorkspace.shared.open(backend.data) }
    @objc func openOriginals() {
        // Works even when the embedded web page or backend cannot start.
        for relative in ["originals", "recovery/safe-data/originals"] {
            let folder = backend.data.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: folder.path) { NSWorkspace.shared.open(folder) }
        }
    }
    @objc func completeUninstall() {
        Task { @MainActor in
            guard !choosing, !terminating, !connectionInFlight, !repairing else { return }
            choosing = true; defer { choosing = false }
            let alert = NSAlert(); alert.alertStyle = .warning
            alert.messageText = "完整卸载菜播·录包机？"
            alert.informativeText = "会先停止录制和任务，再将此应用、内部录像、弹幕、设置及缓存移到废纸篓。数据目录之外的导出视频保留。重新安装会从干净状态开始。\n\n内部数据：\(backend.data.path)"
            alert.addButton(withTitle: "取消"); alert.addButton(withTitle: "移到废纸篓并退出")
            guard alert.runModal() == .alertSecondButtonReturn else { return }
            do {
                try CompleteUninstall.validate(app: Bundle.main.bundleURL, data: backend.data)
                if let status = await backend.call() {
                    if status["stopping"] as? Bool != true {
                        guard let result = await backend.call(["action": "quit", "confirmed": true]), result["quitAccepted"] as? Bool == true else { throw problem("后台尚未安全停止，卸载已取消，文件保留。") }
                    }
                    backend.exitRequested = true
                    try await backend.waitForExit()
                } else {
                    _ = await backend.recoverOwnedProcess()
                    let valid = backend.readEndpoint()
                    let alive = valid && backend.endpoint.map { Darwin.kill($0.pid, 0) == 0 || errno != ESRCH } == true
                    guard backend.process?.isRunning != true, !alive else { throw problem("后台仍在使用数据，卸载已取消，文件保留。") }
                    backend.exitRequested = true
                }
                // Do not move a data directory while any owned recorder still
                // writes into it, including an orphan left by a failed start.
                guard OwnedProcess.orphanedComponents(resources: backend.resources, data: backend.data).isEmpty else { throw problem("录制组件仍在运行，卸载已取消，文件保留。") }
                var lease = try UninstallDataLease.acquire(data: backend.data)
                defer { lease.close() }
                logStartup("用户确认完整卸载：停止后台后移入废纸篓")
                try await CompleteUninstall.recycle(app: Bundle.main.bundleURL, data: backend.data)
                if let identifier = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: identifier) }
                terminating = true; NSApp.terminate(nil)
            } catch { backend.exitRequested = false; showError(error) }
        }
    }
    @objc func systemDidWake(_ notification: Notification) {
        renewInterfaceDeadline(); pageReadySince = nil
        if hasSleepAssertion { IOPMAssertionRelease(sleepAssertion); hasSleepAssertion = false }
        logStartup("系统已唤醒：恢复后台检查，休眠期间无法录制")
        Task { await poll() }
    }
    func updateSleep(_ status: [String: Any]) {
        let busy = status["background"] as? Bool == true && status["stopping"] as? Bool != true
        if busy && !hasSleepAssertion {
            hasSleepAssertion = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "菜播正在监控直播或处理视频" as CFString, &sleepAssertion) == kIOReturnSuccess
            logStartup(hasSleepAssertion ? "监控或任务运行中：已请求防止系统空闲休眠（允许关闭屏幕）" : "请求休眠保护失败，请检查系统电源设置")
        } else if !busy && hasSleepAssertion { IOPMAssertionRelease(sleepAssertion); hasSleepAssertion = false; logStartup("任务与监控空闲：已解除休眠保护") }
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
        if action == "background" { logStartup("关闭窗口，继续后台运行"); window.orderOut(nil) } else { await quitCore() }
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
        NSWorkspace.shared.notificationCenter.removeObserver(self)
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
                ComponentRepair.cleanup(data: backend.data, target: Bundle.main.bundleURL)
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
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--repair-apply" {
            do { try ComponentRepair.apply(URL(fileURLWithPath: CommandLine.arguments[2])) } catch { Darwin.exit(1) }
            return
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
