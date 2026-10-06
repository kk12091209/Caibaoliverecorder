import AppKit
import WebKit
import Foundation
import Darwin

@main struct Checks {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let data = root.appendingPathComponent("data")
        let healthy = root.appendingPathComponent("healthy")
        let stateFile = data.appendingPathComponent("desktop-startup-state.json")
        let fm = FileManager.default
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        var logs: [String] = []
        func available(_ enabled: Bool) throws {
            if enabled { try Data("ready".utf8).write(to: healthy) }
            else if fm.fileExists(atPath: healthy.path) { try fm.removeItem(at: healthy) }
        }
        func controller() throws -> AppDelegate {
            let value = AppDelegate()
            value.backend = Backend(resources: root.appendingPathComponent("resources"), data: data, exports: root.appendingPathComponent("exports"))
            try value.backend.prepare()
            value.backend.onDiagnostic = { [weak value] message in logs.append(message); value?.logStartup(message, forward: false) }
            value.window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480), styleMask: [.titled], backing: .buffered, defer: true)
            value.web = WKWebView(frame: .zero)
            value.startupPanel = NSView()
            value.startupTitle = NSTextField(labelWithString: "")
            value.startupDetail = NSTextField(labelWithString: "")
            value.startupRetry = NSButton()
            value.startupLogs = NSButton()
            return value
        }
        func until(_ check: () -> Bool) async throws {
            for _ in 0..<200 {
                if check() { return }
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            throw problem("Test state did not settle")
        }
        func state(_ child: Process, recoverable: Bool) throws {
            try JSONSerialization.data(withJSONObject: ["pid": Int(child.processIdentifier), "dataPath": data.path, "phase": "恢复待保存视频", "ready": false, "recoverable": recoverable, "updatedAt": ISO8601DateFormatter.caibo.string(from: Date())]).write(to: stateFile)
        }
        func sleeper() throws -> Process {
            let child = Process(); child.executableURL = URL(fileURLWithPath: "/bin/sleep"); child.arguments = ["20"]
            try child.run(); return child
        }

        try available(false)
        let delayed = try controller()
        await delayed.connect()
        guard delayed.pageFailed && !delayed.ready && delayed.startupRetry.isEnabled && delayed.backendRecoveryAttempts == 0 else { throw problem("Missing timeout state or consumed recovery budget without a child") }
        try available(true)
        await delayed.poll()
        guard delayed.ready && !delayed.pageFailed && delayed.pageLoading && delayed.pageNavigation != nil else { throw problem("Late backend failed to load interface automatically") }
        delayed.web.stopLoading()
        print("PASS late backend automatically loads interface")

        try available(false)
        let retry = try controller()
        retry.backend.connectionDetail = "后台回复 HTTP 503"
        retry.showConnecting()
        guard !retry.startupDetail.stringValue.contains("503") && retry.startupDetail.stringValue.contains("正在等待本地服务响应") else { throw problem("Technical connection detail leaked into progress UI") }
        try? fm.removeItem(at: root.appendingPathComponent("blocked-request"))
        let initialChecks = logs.filter { $0.contains("开始检查后台连接") }.count
        let operation = Task { await retry.connect() }
        try await until { retry.backend.connecting && fm.fileExists(atPath: root.appendingPathComponent("blocked-request").path) }
        for _ in 0..<3 { retry.retryStartup() }
        guard retry.retryRequested && retry.startupTitle.stringValue == "正在尝试重新连接" && !retry.startupRetry.isEnabled else { throw problem("Retry click did not report progress") }
        try available(true)
        await operation.value
        try await until { retry.ready && !retry.connectionInFlight }
        guard logs.filter({ $0.contains("开始检查后台连接") }).count - initialChecks == 2 else { throw problem("Retry clicks were not coalesced into one pending attempt") }
        let log = try String(contentsOf: data.appendingPathComponent("desktop-startup.log"), encoding: .utf8)
        guard log.contains("用户重试启动") && log.contains("已收到用户重试") && log.contains("后台重连成功") else { throw problem("Missing retry lifecycle log") }
        retry.web.stopLoading()
        print("PASS active retry gives feedback and coalesces clicks")

        let limited = try controller()
        limited.pageRetries = 3; limited.pageFailed = true
        await limited.poll()
        guard limited.ready && limited.pageFailed && !limited.pageLoading && limited.pageNavigation == nil else { throw problem("WebKit retry budget was bypassed") }
        print("PASS WebKit recovery budget remains bounded")

        let owned = try controller()
        let child = try sleeper(); owned.backend.process = child
        defer { if child.isRunning { child.terminate() } }
        try state(child, recoverable: false)
        guard await owned.backend.recoverOwnedProcess(grace: 0.2) == false && child.isRunning else { throw problem("Interrupted pending video recovery") }
        try state(child, recoverable: true)
        guard await owned.backend.recoverOwnedProcess(grace: 0.5) && !child.isRunning else { throw problem("Owned child did not recover") }
        try fm.removeItem(at: stateFile)
        print("PASS only owned child stops and pending saves are protected")

        let foreign = try controller()
        foreign.backend.readEndpoint()
        let foreignRecovery = await foreign.backend.recoverOwnedProcess(grace: 0.1)
        let foreignStatus = await foreign.backend.heartbeat()
        guard !foreignRecovery && foreignStatus != nil else { throw problem("Recovery affected a reused backend") }
        print("PASS reused backend is never signalled")

        let stubborn = try controller()
        let ignored = Process(), output = Pipe()
        ignored.executableURL = URL(fileURLWithPath: CommandLine.arguments[2])
        ignored.arguments = ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"]
        ignored.standardOutput = output; ignored.standardError = FileHandle.nullDevice
        try ignored.run()
        defer { if ignored.isRunning { Darwin.kill(ignored.processIdentifier, SIGKILL); ignored.waitUntilExit() } }
        guard output.fileHandleForReading.readData(ofLength: 5) == Data("ready".utf8) else { throw problem("Stubborn fixture did not start") }
        stubborn.backend.process = ignored
        guard await stubborn.backend.recoverOwnedProcess(grace: 0.15) && !ignored.isRunning else { throw problem("Recovery did not force-stop a verified non-responsive child") }
        print("PASS verified non-responsive child is force-stopped")

        let tree = try controller(), parent = Process()
        let component = root.appendingPathComponent("resources/runtime/recorder/BililiveRecorder.Cli")
        try fm.removeItem(at: component); try fm.copyItem(at: URL(fileURLWithPath: CommandLine.arguments[2]), to: component)
        let childrenFile = root.appendingPathComponent("tree.json"), childReady = root.appendingPathComponent("tree-child-ready")
        let script = "const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.argv[1],['-e',\"process.on('SIGINT',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)\",process.argv[3]],{stdio:'ignore'});const foreign=spawn('/bin/sleep',['20'],{stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);fs.writeFileSync(process.argv[2],JSON.stringify({child:child.pid,foreign:foreign.pid}));"
        parent.executableURL = URL(fileURLWithPath: CommandLine.arguments[2]); parent.arguments = ["-e", script, component.path, childrenFile.path, childReady.path]
        parent.standardOutput = FileHandle.nullDevice; parent.standardError = FileHandle.standardError; try parent.run()
        do { try await until { fm.fileExists(atPath: childrenFile.path) && fm.fileExists(atPath: childReady.path) } } catch { throw problem("Tree did not start; parent running: \(parent.isRunning); pids: \((try? String(contentsOf: childrenFile)) ?? "none")") }
        let pids = try JSONSerialization.jsonObject(with: Data(contentsOf: childrenFile)) as! [String: Int32]
        defer { for pid in pids.values { if let value = OwnedProcess.inspect(pid) { _ = value.signal(SIGKILL) } }; if parent.isRunning { parent.terminate() } }
        tree.backend.process = parent
        guard await tree.backend.recoverOwnedProcess(grace: 0.15), !parent.isRunning, OwnedProcess.inspect(pids["child"]!) == nil, OwnedProcess.inspect(pids["foreign"]!) != nil else { throw problem("Owned tree recovery failed or affected an unrelated child") }
        print("PASS owned child tree reclaimed and unrelated child preserved")

        try available(false)
        let automatic = try controller()
        await automatic.connect()
        guard automatic.backendRecoveryAttempts == 0 else { throw problem("Earlier connection failure consumed owned recovery budget") }
        let oldChild = try sleeper(); automatic.backend.process = oldChild
        defer { if oldChild.isRunning { oldChild.terminate() } }
        try state(oldChild, recoverable: true)
        var recoveries = 0
        automatic.backend.onDiagnostic = { [weak automatic] message in
            logs.append(message); automatic?.logStartup(message, forward: false)
            if message.contains("旧后台已退出") { recoveries += 1; try? available(true) }
        }
        await automatic.connect()
        guard automatic.ready && automatic.pageLoading && recoveries == 1 && !oldChild.isRunning else { throw problem("Owned startup recovery did not reconnect exactly once") }
        automatic.web.stopLoading()
        guard try String(contentsOf: data.appendingPathComponent("existing-recording.flv"), encoding: .utf8) == "existing recording" else { throw problem("Recording changed during recovery") }
        guard !logs.contains(where: { $0.contains(String(repeating: "b", count: 64)) }) else { throw problem("Authentication token leaked into diagnostics") }
        print("PASS owned startup recovery reconnects and retains recording")
        for value in [delayed, retry, limited, owned, foreign, stubborn, tree, automatic] { value.web.configuration.userContentController.removeScriptMessageHandler(forName: "caibo"); value.window.orderOut(nil) }
    }
}
