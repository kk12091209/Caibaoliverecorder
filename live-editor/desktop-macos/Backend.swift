import Foundation
import CryptoKit
import Darwin

struct Endpoint: Decodable {
    let `protocol`: Int
    let instance: String
    let token: String
    let pid: Int32
    let origin: String
    let dataPath: String
    let build: String
}
func problem(_ message: String) -> NSError { NSError(domain: "Caibo", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
struct MissingComponent: LocalizedError {
    let name: String
    var errorDescription: String? { "运行组件缺失或损坏：\(name)。正在准备自动修复。" }
}
struct StartupPaused: LocalizedError {
    var errorDescription: String? { "后台连续启动失败，已暂停自动重启。请打开日志查看原因。" }
}

@MainActor final class Backend {
    let resources: URL
    let data: URL
    let exports: URL
    let client = UUID().uuidString
    var endpoint: Endpoint?
    var process: Process?
    var expectedBuild = ""
    var connecting = false
    var exitRequested = false
    var onDiagnostic: ((String) -> Void)?
    var connectionDetail = "正在检查本地后台"
    var connectionProgress: String {
        if connectionDetail.hasPrefix("本地连接异常") || connectionDetail.hasPrefix("后台回复") { return "正在等待本地服务响应" }
        if connectionDetail.contains("校验未通过") { return "正在确认本地服务连接" }
        if connectionDetail == "打开素材数据库" { return "正在读取素材信息" }
        return connectionDetail
    }
    private var connectionIssue = ""
    private(set) var ownedRecoveryAttempted = false
    var ownedIdentity: OwnedProcess?
    private var bundleIntegrityChecked = false
    private(set) var launchAttempts = 0
    private var protectedStateKey = ""
    private var protectedStateSince: TimeInterval = 0
    private let session: URLSession
    var appRoot: URL { resources.appendingPathComponent("live-editor") }
    var origin: URL? { endpoint.flatMap { URL(string: $0.origin) } }
    func resetRecoveryBudget() { launchAttempts = 0 }

    init(resources: URL, data: URL, exports: URL) {
        self.resources = resources; self.data = data; self.exports = exports
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 5
        session = URLSession(configuration: config)
    }
    func prepare() throws {
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: data.appendingPathComponent("temp"), withIntermediateDirectories: true)
        expectedBuild = (try? computeBuild()) ?? ""
    }
    func computeBuild() throws -> String {
        var hash = SHA256()
        let files = ["package.json"] + (try FileManager.default.contentsOfDirectory(atPath: appRoot.appendingPathComponent("server").path)).filter { $0.hasSuffix(".js") }.sorted().map { "server/" + $0 }
        for name in files {
            hash.update(data: Data((name + "\n").utf8))
            hash.update(data: try Data(contentsOf: appRoot.appendingPathComponent(name)))
            hash.update(data: Data([0]))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    func validateComponents() async throws {
        for name in ["node/node", "recorder/BililiveRecorder.Cli", "ffmpeg/ffmpeg", "ffmpeg/ffprobe"] {
            if !FileManager.default.isExecutableFile(atPath: resources.appendingPathComponent("runtime/" + name).path) { throw MissingComponent(name: URL(fileURLWithPath: name).lastPathComponent) }
        }
        for name in ["BililiveRecorder.Cli.dll", "BililiveRecorder.Core.dll", "BililiveRecorder.Cli.deps.json", "BililiveRecorder.Cli.runtimeconfig.json", "libhostfxr.dylib", "libcoreclr.dylib"] {
            if !FileManager.default.isReadableFile(atPath: resources.appendingPathComponent("runtime/recorder/" + name).path) { throw MissingComponent(name: name) }
        }
        do { expectedBuild = try computeBuild() } catch { throw MissingComponent(name: "本地服务文件") }
        try validateInterface()
        let bundle = resources.deletingLastPathComponent().deletingLastPathComponent()
        if bundle.pathExtension == "app" && !bundleIntegrityChecked {
            connectionDetail = "正在检查应用组件完整性"
            do { try await Task.detached { _ = try OwnedProcess.command("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle.path]) }.value }
            catch { throw MissingComponent(name: "应用组件完整性校验") }
            bundleIntegrityChecked = true
        }
    }
    func validateInterface() throws {
        let directory = appRoot.appendingPathComponent("dist")
        let message = MissingComponent(name: "界面文件")
        guard let bytes = try? Data(contentsOf: directory.appendingPathComponent("index.html")),
              bytes.count < 262144, let html = String(data: bytes, encoding: .utf8),
              html.contains("id=\"app\"") else { throw message }
        let expression = try NSRegularExpression(pattern: "(?:src|href)=[\"'](/assets/[^\"']+)[\"']")
        let matches = expression.matches(in: html, range: NSRange(html.startIndex..., in: html))
        var hasScript = false
        for match in matches {
            guard let range = Range(match.range(at: 1), in: html),
                  let reference = String(html[range]).removingPercentEncoding,
                  !reference.contains(".."), !reference.contains("\\"),
                  let contents = try? Data(contentsOf: directory.appendingPathComponent(String(reference.dropFirst()))),
                  !contents.isEmpty else { throw message }
            if reference.hasSuffix(".js") { hasScript = true }
        }
        guard hasScript else { throw message }
    }
    @discardableResult func readEndpoint() -> Bool {
        guard let bytes = readStateFile("desktop-service.json", limit: 16384),
              let value = try? JSONDecoder().decode(Endpoint.self, from: bytes), value.protocol == 1, value.pid > 0,
              URL(fileURLWithPath: value.dataPath).resolvingSymlinksInPath().path == data.resolvingSymlinksInPath().path,
              let url = URLComponents(string: value.origin), url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port, port > 0, port < 65536, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
              value.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              value.instance.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { return false }
        endpoint = value; return true
    }
    private func readStateFile(_ name: String, limit: Int) -> Data? {
        guard let file = try? FileHandle(forReadingFrom: data.appendingPathComponent(name)) else { return nil }
        defer { try? file.close() }
        guard let bytes = try? file.read(upToCount: limit + 1), bytes.count <= limit else { return nil }
        return bytes
    }
    func call(_ action: [String: Any]? = nil, timeout: TimeInterval = 5) async -> [String: Any]? {
        guard let endpoint, let url = URL(string: endpoint.origin + "/internal/desktop") else { return nil }
        let checking = action == nil || action?["action"] as? String == "heartbeat"
        func failed(_ detail: String) -> [String: Any]? {
            if checking, detail != connectionIssue {
                connectionIssue = detail; connectionDetail = detail
                onDiagnostic?("后台连接检查：\(detail)；后台 PID \(endpoint.pid)")
            }
            return nil
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(endpoint.token, forHTTPHeaderField: "X-Caibo-Instance")
        if let action {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: action)
        }
        do {
            let (bytes, response) = try await session.data(for: request)
            guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return failed("后台回复格式无效") }
            if (response as? HTTPURLResponse)?.statusCode != 200 {
                if action?["action"] as? String == "applyUpdate" { return ["error": value["error"] as? String ?? "更新准备失败。"] }
                return failed("后台回复 HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            guard value["protocol"] as? Int == 1, value["instance"] as? String == endpoint.instance,
                  value["dataPath"] as? String == endpoint.dataPath else { return failed("后台实例或数据目录校验未通过") }
            if checking {
                if !connectionIssue.isEmpty { onDiagnostic?("后台连接已恢复；PID \(endpoint.pid)") }
                connectionIssue = ""; connectionDetail = "本地后台已连接"
            }
            return value
        } catch {
            let issue = error as NSError
            return failed("本地连接异常（\(issue.domain)/\(issue.code)）")
        }
    }
    func startupState() -> [String: Any]? {
        guard let bytes = readStateFile("desktop-startup-state.json", limit: 8192),
              let state = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              state["dataPath"] as? String == data.path,
              let pid = state["pid"] as? Int32, pid == process?.processIdentifier || pid == endpoint?.pid else { return nil }
        return state
    }
    func refreshConnectionDetail() {
        if let state = startupState(), state["ready"] as? Bool != true, let phase = state["phase"] as? String {
            connectionDetail = String(phase.prefix(100))
        }
    }
    // Stop gracefully first, then escalate only a captured, unchanged identity.
    // The owned child tree is captured before stopping its parent.
    func recoverOwnedProcess(grace: TimeInterval = 10) async -> Bool {
        ownedRecoveryAttempted = false
        guard !exitRequested else { return false }
        var identity = ownedIdentity
        if let child = process, child.isRunning { identity = identity ?? OwnedProcess.inspect(child.processIdentifier) }
        if identity == nil, readEndpoint(), let endpoint, let state = startupState(), state["instance"] as? String == endpoint.instance {
            let node = resources.appendingPathComponent("runtime/node/node").path
            let script = appRoot.appendingPathComponent("server/index.js").path
            if let command = try? OwnedProcess.command("/bin/ps", ["-ww", "-p", String(endpoint.pid), "-o", "command="]), command.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/private/tmp/", with: "/tmp/").replacingOccurrences(of: "/private/var/", with: "/var/") == OwnedProcess.normalPath(node) + " " + OwnedProcess.normalPath(script) { identity = OwnedProcess.inspect(endpoint.pid) }
        }
        guard let identity, identity.unchanged else { return await recoverOrphanedComponents(grace: grace) }
        if let state = startupState(), state["recoverable"] as? Bool == false {
            let updated = (state["updatedAt"] as? String).flatMap { ISO8601DateFormatter.caibo.date(from: $0) }
            let age = updated.map { Date().timeIntervalSince($0) }
            // A corrupt or future timestamp must not protect a deadlocked
            // writer forever. Observe an unchanged state with a monotonic clock.
            let key = identity.identity + "|" + String(describing: state["phase"]) + "|" + String(describing: state["updatedAt"])
            if key != protectedStateKey { protectedStateKey = key; protectedStateSince = ProcessInfo.processInfo.systemUptime }
            let recent = age.map { $0 >= 0 && $0 < 120 } ?? false
            let untrustedTime = age == nil || age! < 0
            if recent || (untrustedTime && ProcessInfo.processInfo.systemUptime - protectedStateSince < 120) {
                onDiagnostic?("后台仍在恢复待保存视频；不打断文件保存，继续保留数据")
                return false
            }
            onDiagnostic?("保存恢复阶段持续超过两分钟且未更新进度；保留原始文件后回收卡死组件")
        } else { protectedStateKey = "" }
        connectionDetail = "正在恢复本地后台"
        var children = OwnedProcess.descendants(of: identity.pid, resources: resources)
        onDiagnostic?("受控恢复自己启动的后台；PID \(identity.pid)；发送停止请求，等待安全退出")
        ownedRecoveryAttempted = true
        guard identity.signal(SIGTERM) else { return false }
        let deadline = Date().addingTimeInterval(grace)
        while identity.unchanged && Date() < deadline && !exitRequested { try? await Task.sleep(nanoseconds: 100_000_000) }
        guard !exitRequested else { return false }
        if identity.unchanged {
            for child in OwnedProcess.descendants(of: identity.pid, resources: resources) where !children.contains(child) { children.append(child) }
        }
        if identity.unchanged || children.contains(where: { $0.unchanged }) {
            connectionDetail = "正在回收无响应组件"
            onDiagnostic?("正常停止超时；强制回收已核实的后台及 \(children.count) 个子组件；原始文件保留，未完成任务将在启动后恢复")
            for child in children { _ = child.signal(SIGINT) }
            try? await Task.sleep(nanoseconds: 500_000_000)
            for child in children { _ = child.signal(SIGKILL) }
            _ = identity.signal(SIGKILL)
            for _ in 0..<30 {
                if !identity.unchanged && !children.contains(where: { $0.unchanged }) { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        guard !identity.unchanged && !children.contains(where: { $0.unchanged }) else { onDiagnostic?("组件仍未退出，停止自动重启；文件已保留"); return false }
        ownedIdentity = nil
        onDiagnostic?("旧后台已退出，准备重新启动")
        return !exitRequested
    }
    func recoverOrphanedComponents(grace: TimeInterval = 3) async -> Bool {
        guard !exitRequested else { return false }
        let children = OwnedProcess.orphanedComponents(resources: resources, data: data)
        guard !children.isEmpty else { return false }
        ownedRecoveryAttempted = true
        onDiagnostic?("回收已核实归属本应用和当前数据目录的遗留组件；数量 \(children.count)")
        for child in children { _ = child.signal(SIGINT) }
        let deadline = Date().addingTimeInterval(grace)
        while children.contains(where: { $0.unchanged }) && Date() < deadline && !exitRequested { try? await Task.sleep(nanoseconds: 100_000_000) }
        guard !exitRequested else { return false }
        for child in children { _ = child.signal(SIGKILL) }
        for _ in 0..<30 {
            if !children.contains(where: { $0.unchanged }) { onDiagnostic?("遗留组件已退出，准备重新启动"); return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return false
    }
    func heartbeat(timeout: TimeInterval = 5) async -> [String: Any]? {
        await call(["action": "heartbeat", "clientKind": "desktop", "client": client, "pid": ProcessInfo.processInfo.processIdentifier], timeout: timeout)
    }
    func waitForExit(timeout: TimeInterval = 60) async throws {
        guard let expected = endpoint else { throw problem("无法确认正在退出的后台，请重试。") }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Darwin.kill(expected.pid, 0) != 0 && errno == ESRCH { return }
            if let status = await call(), let error = status["quitError"] as? String, !error.isEmpty {
                let detail = error.trimmingCharacters(in: CharacterSet(charactersIn: "。.!！ "))
                throw problem("退出未完成：\(detail)。请再次选择退出重试。")
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw problem("后台仍在收尾，暂未完全退出。请稍后再次选择退出；录像文件会保留。")
    }
    func start() throws {
        let runtime = resources.appendingPathComponent("runtime")
        let node = runtime.appendingPathComponent("node/node")
        let tools = ["RECORDER_PATH": "recorder/BililiveRecorder.Cli", "FFMPEG_PATH": "ffmpeg/ffmpeg", "FFPROBE_PATH": "ffmpeg/ffprobe"]
        for file in [node] + tools.values.map({ runtime.appendingPathComponent($0) }) {
            guard FileManager.default.isExecutableFile(atPath: file.path) else { throw MissingComponent(name: file.lastPathComponent) }
        }
        var env = ProcessInfo.processInfo.environment
        // The bundled backend always uses bundled tools, never a user's PATH.
        env["EDITOR_DATA"] = data.path; env["EDITOR_PROJECT_ROOT"] = resources.path
        env["EDITOR_EXPORT_ROOT"] = exports.path
        let logs = data.appendingPathComponent("logs")
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        env["BILILIVERECORDER_LOG_FILE_PATH"] = logs.appendingPathComponent("bilirec.txt").path
        env["EDITOR_PORT"] = "0"; env["RECORDER_PORT"] = "0"; env["EDITOR_DESKTOP_MANAGED"] = "1"
        for (key, file) in tools { env[key] = runtime.appendingPathComponent(file).path }
        for key in ["TMPDIR", "TMP", "TEMP"] { env[key] = data.appendingPathComponent("temp").path }
        let task = Process(); task.executableURL = node
        task.arguments = [appRoot.appendingPathComponent("server/index.js").path]
        task.currentDirectoryURL = appRoot; task.environment = env; task.standardInput = FileHandle.nullDevice
        let logURL = data.appendingPathComponent("desktop-backend.log")
        if let attributes = try? FileManager.default.attributesOfItem(atPath: logURL.path), let size = attributes[.size] as? NSNumber, size.intValue > 512 * 1024 { try? FileManager.default.removeItem(at: logURL) }
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let log = try FileHandle(forWritingTo: logURL); try log.seekToEnd()
        task.standardOutput = log; task.standardError = log
        task.terminationHandler = { [weak self] child in
            let pid = child.processIdentifier, status = child.terminationStatus
            Task { @MainActor in self?.onDiagnostic?("后台进程已退出；PID \(pid)；退出码 \(status)") }
        }
        defer { try? log.close() }
        launchAttempts += 1
        try task.run(); process = task
        ownedIdentity = OwnedProcess.inspect(task.processIdentifier)
        connectionDetail = "正在启动本地后台"
        onDiagnostic?("已启动本地后台；PID \(task.processIdentifier)")
    }
    func ensure(timeout: TimeInterval = 60) async throws -> [String: Any] {
        guard !connecting else { throw problem("后台正在连接，请稍候。") }
        connecting = true; defer { connecting = false }
        onDiagnostic?("开始检查后台连接；等待时限 \(Int(timeout)) 秒")
        var restartInstance = "", launchedAt = Date.distantPast
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if exitRequested { throw problem("软件正在退出。") }
            refreshConnectionDetail()
            if readEndpoint(), let status = await heartbeat(timeout: min(5, max(0.01, deadline.timeIntervalSinceNow))) {
                if status["stopping"] as? Bool != true {
                    if status["build"] as? String == expectedBuild { onDiagnostic?("后台连接就绪；PID \(endpoint?.pid ?? 0)"); return status }
                    if restartInstance != endpoint?.instance {
                        restartInstance = endpoint?.instance ?? ""
                        if Date() < deadline { _ = await call(["action": "restart"], timeout: min(5, max(0.01, deadline.timeIntervalSinceNow))) }
                    }
                    if status["busy"] as? Bool == true { return status }
                }
            } else if Date() < deadline && process?.isRunning != true && Date().timeIntervalSince(launchedAt) > 3 {
                guard launchAttempts < 3 else { onDiagnostic?("后台连续启动失败，暂停自动重启；启动次数 \(launchAttempts)"); throw StartupPaused() }
                try start(); launchedAt = Date()
            }
            let remaining = deadline.timeIntervalSinceNow
            if remaining > 0 { try await Task.sleep(nanoseconds: UInt64(min(0.25, remaining) * 1_000_000_000)) }
        }
        refreshConnectionDetail()
        onDiagnostic?("后台启动超时；阶段：\(connectionDetail)；当前子进程运行：\(process?.isRunning == true ? "是" : "否")；\(connectionIssue.isEmpty ? "未取得可用后台回复" : connectionIssue)")
        throw problem("后台启动超时。请查看数据目录中的 desktop-backend.log：\(data.path)")
    }
}
