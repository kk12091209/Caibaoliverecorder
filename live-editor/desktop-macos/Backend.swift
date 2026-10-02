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
    private let session: URLSession
    var appRoot: URL { resources.appendingPathComponent("live-editor") }
    var origin: URL? { endpoint.flatMap { URL(string: $0.origin) } }

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
        var hash = SHA256()
        let files = ["package.json"] + (try FileManager.default.contentsOfDirectory(atPath: appRoot.appendingPathComponent("server").path)).filter { $0.hasSuffix(".js") }.sorted().map { "server/" + $0 }
        for name in files {
            hash.update(data: Data((name + "\n").utf8))
            hash.update(data: try Data(contentsOf: appRoot.appendingPathComponent(name)))
            hash.update(data: Data([0]))
        }
        expectedBuild = hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    @discardableResult func readEndpoint() -> Bool {
        guard let bytes = try? Data(contentsOf: data.appendingPathComponent("desktop-service.json")),
              let value = try? JSONDecoder().decode(Endpoint.self, from: bytes), value.protocol == 1, value.pid > 0,
              URL(fileURLWithPath: value.dataPath).resolvingSymlinksInPath().path == data.resolvingSymlinksInPath().path,
              let url = URLComponents(string: value.origin), url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port, port > 0, port < 65536, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
              value.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              value.instance.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { return false }
        endpoint = value; return true
    }
    func call(_ action: [String: Any]? = nil, timeout: TimeInterval = 5) async -> [String: Any]? {
        guard let endpoint, let url = URL(string: endpoint.origin + "/internal/desktop") else { return nil }
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
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  value["protocol"] as? Int == 1, value["instance"] as? String == endpoint.instance,
                  value["dataPath"] as? String == endpoint.dataPath else { return nil }
            return value
        } catch { return nil }
    }
    func heartbeat() async -> [String: Any]? {
        await call(["action": "heartbeat", "client": client, "pid": ProcessInfo.processInfo.processIdentifier])
    }
    func waitForExit(timeout: TimeInterval = 60) async throws {
        guard let expected = endpoint else { throw problem("无法确认正在退出的后台，请重试。") }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Darwin.kill(expected.pid, 0) != 0 && errno == ESRCH { return }
            if let status = await call(), let error = status["quitError"] as? String, !error.isEmpty {
                throw problem("退出未完成：\(error)。请再次选择退出重试。")
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
            guard FileManager.default.isExecutableFile(atPath: file.path) else { throw problem("运行组件缺失或不可执行：\(file.lastPathComponent)。请重新下载完整应用。") }
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
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let log = try FileHandle(forWritingTo: logURL); try log.seekToEnd()
        task.standardOutput = log; task.standardError = log
        try task.run(); try log.close(); process = task
    }
    func ensure() async throws -> [String: Any] {
        guard !connecting else { throw problem("后台正在连接，请稍候。") }
        connecting = true; defer { connecting = false }
        var restartInstance = "", launchedAt = Date.distantPast
        for _ in 0..<240 {
            if exitRequested { throw problem("软件正在退出。") }
            if readEndpoint(), let status = await heartbeat() {
                if status["stopping"] as? Bool != true {
                    if status["build"] as? String == expectedBuild { return status }
                    if restartInstance != endpoint?.instance {
                        restartInstance = endpoint?.instance ?? ""
                        _ = await call(["action": "restart"])
                    }
                    if status["busy"] as? Bool == true { return status }
                }
            } else if process?.isRunning != true && Date().timeIntervalSince(launchedAt) > 3 {
                try start(); launchedAt = Date()
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw problem("后台启动超时。请查看数据目录中的 desktop-backend.log：\(data.path)")
    }
}
