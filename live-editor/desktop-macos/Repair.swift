import Foundation
import CryptoKit
import Darwin

enum RepairTrust {
    static let repository = "kk12091209/Caibaoliverecorder"
    static func version(_ value: String) -> Bool { value.range(of: "^\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}$", options: .regularExpression) != nil }
    static func allowed(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "https", parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil else { return false }
        if parts.host == "api.github.com" { return parts.path.hasPrefix("/repos/" + repository + "/releases/tags/v") && parts.query == nil }
        if parts.host == "github.com" { return parts.path.hasPrefix("/" + repository + "/releases/download/") && parts.query == nil }
        return ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(parts.host ?? "")
    }
    static func asset(_ release: [String: Any], version: String) throws -> (URL, Int64, String) {
        guard self.version(version), release["tag_name"] as? String == "v" + version,
              release["draft"] as? Bool == false, release["prerelease"] as? Bool == false,
              let assets = release["assets"] as? [[String: Any]] else { throw problem("官方修复版本信息无效。") }
        let name = "Caibo-\(version)-macos-arm64.dmg", candidates = assets.filter { $0["name"] as? String == name }
        guard candidates.count == 1, let item = candidates.first,
              item["state"] as? String == "uploaded", let address = item["browser_download_url"] as? String,
              address == "https://github.com/\(repository)/releases/download/v\(version)/\(name)", let url = URL(string: address),
              let number = item["size"] as? NSNumber, number.doubleValue == Double(number.int64Value), number.int64Value > 0, number.int64Value <= 512 * 1024 * 1024,
              let digest = item["digest"] as? String, digest.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil else { throw problem("官方修复包尚未准备完整或缺少校验信息。") }
        return (url, number.int64Value, String(digest.dropFirst(7)))
    }
    static func digest(_ file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var hash = SHA256()
        while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty { hash.update(data: bytes) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

final class RepairTransfer: NSObject, URLSessionTaskDelegate, URLSessionDownloadDelegate {
    let limit: Int64
    let progress: (Int64) -> Void
    var redirects = 0, lastProgress: Int64 = -1
    init(limit: Int64, progress: @escaping (Int64) -> Void) { self.limit = limit; self.progress = progress }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        completionHandler(redirects <= 5 && request.url.map(RepairTrust.allowed) == true ? request : nil)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit || totalBytesExpectedToWrite > limit { downloadTask.cancel(); return }
        let step = max(1, limit / 100)
        if totalBytesWritten / step != lastProgress { lastProgress = totalBytesWritten / step; progress(totalBytesWritten) }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}

@MainActor final class ComponentRepair {
    let target: URL, data: URL, version: String
    let progress: (String) -> Void
    let log: (String) -> Void
    let downloader: ((URL, URL, Int64, Int64?) async throws -> Void)?
    let helperExecutable: URL?
    init(target: URL, data: URL, version: String, helperExecutable: URL? = nil, downloader: ((URL, URL, Int64, Int64?) async throws -> Void)? = nil, progress: @escaping (String) -> Void, log: @escaping (String) -> Void) {
        self.target = target; self.data = data; self.version = version; self.progress = progress; self.log = log
        self.helperExecutable = helperExecutable; self.downloader = downloader
    }
    func transfer(_ url: URL, to destination: URL, limit: Int64, expected: Int64? = nil) async throws {
        guard RepairTrust.allowed(url) else { throw problem("修复下载地址不受信任。") }
        if let downloader {
            try await downloader(url, destination, limit, expected)
            let size = (try FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
            guard size > 0, size <= limit, expected == nil || size == expected else { throw problem("修复文件下载不完整。") }
            return
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45; configuration.timeoutIntervalForResource = 1800
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.setValue("Caibo-Native-Repair", forHTTPHeaderField: "User-Agent")
        let delegate = RepairTransfer(limit: limit) { [weak self] bytes in
            guard let expected else { return }
            Task { @MainActor in self?.progress("正在下载官方修复包 \(min(100, bytes * 100 / expected))%") }
        }
        let (temporary, response) = try await session.download(for: request, delegate: delegate)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let final = response.url, RepairTrust.allowed(final),
              let size = (try FileManager.default.attributesOfItem(atPath: temporary.path)[.size] as? NSNumber)?.int64Value,
              size > 0, size <= limit, expected == nil || size == expected else { throw problem("修复文件下载不完整或来源无效，请稍后重试。") }
        try FileManager.default.moveItem(at: temporary, to: destination)
    }
    nonisolated static func validateBundle(_ bundle: URL, version: String) throws {
        let info = NSDictionary(contentsOf: bundle.appendingPathComponent("Contents/Info.plist"))
        guard info?["CFBundleIdentifier"] as? String == "io.github.kk12091209.caibo", info?["CFBundleShortVersionString"] as? String == version,
              info?["CFBundleExecutable"] as? String == "CaiboDesktop" else { throw problem("修复包应用身份或版本不匹配。") }
        _ = try OwnedProcess.command("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle.path])
        let executable = bundle.appendingPathComponent("Contents/MacOS/CaiboDesktop")
        guard try OwnedProcess.command("/usr/bin/lipo", ["-archs", executable.path]).trimmingCharacters(in: .whitespacesAndNewlines) == "arm64" else { throw problem("修复包不适用于当前芯片。") }
        let resources = bundle.appendingPathComponent("Contents/Resources")
        let files = ["runtime/node/node", "runtime/ffmpeg/ffmpeg", "runtime/ffmpeg/ffprobe", "runtime/recorder/BililiveRecorder.Cli", "live-editor/server/index.js", "live-editor/dist/index.html"]
        for name in files {
            let file = resources.appendingPathComponent(name)
            guard FileManager.default.isReadableFile(atPath: file.path), OwnedProcess.normalPath(file.resolvingSymlinksInPath().path).hasPrefix(OwnedProcess.normalPath(bundle.path) + "/") else { throw problem("修复包组件不完整。") }
            if name.hasPrefix("runtime/"), !FileManager.default.isExecutableFile(atPath: file.path) { throw problem("修复包组件不可执行。") }
        }
        let package = try JSONSerialization.jsonObject(with: Data(contentsOf: resources.appendingPathComponent("live-editor/package.json"))) as? [String: Any]
        guard package?["version"] as? String == version else { throw problem("修复包组件版本不匹配。") }
    }
    func stage() async throws -> URL {
        let fm = FileManager.default
        guard RepairTrust.version(version) else { throw problem("当前应用的版本信息缺失，无法选择官方修复包。") }
        guard target.pathExtension == "app", OwnedProcess.samePath(target.resolvingSymlinksInPath().path, target.path) else { throw problem("安装位置包含目录链接或路径异常，无法自动替换。") }
        guard OwnedProcess.normalPath(data.path) != OwnedProcess.normalPath(target.path), !OwnedProcess.normalPath(data.path).hasPrefix(OwnedProcess.normalPath(target.path) + "/") else { throw problem("数据目录位于应用内部，已停止自动替换以保留文件。") }
        guard fm.isWritableFile(atPath: target.deletingLastPathComponent().path) else { throw problem("安装位置不可写，请将应用放到可写的“应用程序”文件夹后重试。") }
        guard let executable = helperExecutable ?? Bundle.main.executableURL else { throw problem("无法确认原生启动器，原应用已保留。") }
        let repairs = data.appendingPathComponent("repairs", isDirectory: true)
        try fm.createDirectory(at: repairs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard OwnedProcess.samePath(repairs.resolvingSymlinksInPath().path, repairs.path) else { throw problem("修复缓存目录异常。") }
        let ticket = UUID().uuidString.lowercased(), root = repairs.appendingPathComponent(ticket, isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let stage = target.deletingLastPathComponent().appendingPathComponent(".Caibo-repair-\(ticket).app")
        let mount = root.appendingPathComponent("mount", isDirectory: true)
        var mounted = false, succeeded = false, stageCreated = false
        defer {
            if mounted { _ = try? OwnedProcess.command("/usr/bin/hdiutil", ["detach", mount.path]) }
            if !succeeded { if stageCreated { try? fm.removeItem(at: stage) }; try? fm.removeItem(at: root) }
        }
        progress("正在检查官方修复包"); log("自动修复开始；版本 \(version)；仅替换应用组件，用户数据保留")
        let metadata = root.appendingPathComponent("release.json")
        try await transfer(URL(string: "https://api.github.com/repos/\(RepairTrust.repository)/releases/tags/v\(version)")!, to: metadata, limit: 1024 * 1024)
        let release = try JSONSerialization.jsonObject(with: Data(contentsOf: metadata)) as? [String: Any] ?? [:]
        let (url, size, hash) = try RepairTrust.asset(release, version: version)
        let package = root.appendingPathComponent("repair.dmg")
        try await transfer(url, to: package, limit: size, expected: size)
        try Task.checkCancellation(); progress("正在校验修复包")
        let downloadedHash = try await Task.detached { try RepairTrust.digest(package) }.value
        guard downloadedHash == hash else { throw problem("修复包校验失败，原应用和数据已保留。") }
        try fm.createDirectory(at: mount, withIntermediateDirectories: false)
        try await Task.detached { _ = try OwnedProcess.command("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount.path, package.path]) }.value
        mounted = true
        let source = mount.appendingPathComponent("菜播·录包机.app")
        try await Task.detached { try Self.validateBundle(source, version: self.version) }.value
        progress("正在准备修复并重新启动")
        guard !fm.fileExists(atPath: stage.path) else { throw problem("修复暂存位置异常。") }
        stageCreated = true
        try await Task.detached {
            _ = try OwnedProcess.command("/usr/bin/ditto", ["--norsrc", "--noextattr", source.path, stage.path])
            try Self.validateBundle(stage, version: self.version)
            _ = try OwnedProcess.command("/usr/bin/hdiutil", ["detach", mount.path])
        }.value
        mounted = false
        try Task.checkCancellation()
        let helper = root.appendingPathComponent("repair-helper")
        try fm.copyItem(at: executable, to: helper)
        let request = root.appendingPathComponent("request.json")
        guard let gui = OwnedProcess.inspect(getpid()) else { throw problem("无法确认当前应用进程。") }
        let object: [String: Any] = ["schema": 1, "ticket": ticket, "target": target.path, "data": data.path, "stage": stage.path, "version": version, "guiPid": Int(getpid()), "guiIdentity": gui.identity]
        try JSONSerialization.data(withJSONObject: object).write(to: request, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: request.path)
        succeeded = true
        return request
    }
    static func apply(_ request: URL) throws {
        let fm = FileManager.default, root = request.deletingLastPathComponent()
        let status = root.appendingPathComponent("status.json")
        func report(_ value: String, _ error: String = "") { try? JSONSerialization.data(withJSONObject: ["status": value, "error": error, "helperPid": Int(getpid())]).write(to: status, options: .atomic) }
        var target: URL?, stage: URL?, backup: URL?, swapped = false
        func relaunch(_ url: URL) throws {
            let env = ProcessInfo.processInfo.environment
            let forwarded = ["CAIBO_DATA_ROOT", "CAIBO_EXPORT_ROOT", "NO_RECORDER"].flatMap { key in env[key].map { ["--env", key + "=" + $0] } ?? [] }
            _ = try OwnedProcess.command("/usr/bin/open", ["-n"] + forwarded + ["--env", "CAIBO_REPAIR_ATTEMPT=1", url.path])
        }
        do {
            let bytes = try Data(contentsOf: request)
            guard bytes.count <= 16384, let item = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], item["schema"] as? Int == 1,
                  let ticket = item["ticket"] as? String, UUID(uuidString: ticket) != nil, root.lastPathComponent == ticket,
                  let targetPath = item["target"] as? String, let dataPath = item["data"] as? String, let stagePath = item["stage"] as? String,
                  let version = item["version"] as? String, RepairTrust.version(version), let pid = item["guiPid"] as? Int32,
                  let identity = item["guiIdentity"] as? String else { throw problem("修复请求无效。") }
            let destination = URL(fileURLWithPath: targetPath), data = URL(fileURLWithPath: dataPath), candidate = URL(fileURLWithPath: stagePath)
            guard destination.pathExtension == "app", OwnedProcess.samePath(destination.resolvingSymlinksInPath().path, destination.path),
                  root.path == data.appendingPathComponent("repairs/" + ticket).path, OwnedProcess.samePath(root.resolvingSymlinksInPath().path, root.path),
                  candidate.path == destination.deletingLastPathComponent().appendingPathComponent(".Caibo-repair-\(ticket).app").path,
                  OwnedProcess.samePath(candidate.resolvingSymlinksInPath().path, candidate.path), OwnedProcess.normalPath(data.path) != OwnedProcess.normalPath(destination.path), !OwnedProcess.normalPath(data.path).hasPrefix(OwnedProcess.normalPath(destination.path) + "/") else { throw problem("修复安装位置无效。") }
            try validateBundle(candidate, version: version)
            target = destination; stage = candidate; backup = URL(fileURLWithPath: candidate.path + ".backup")
            guard !fm.fileExists(atPath: backup!.path) else { throw problem("修复备份位置已存在。") }
            report("ready")
            let gui = OwnedProcess(pid: pid, identity: identity), deadline = Date().addingTimeInterval(60)
            while gui.unchanged && Date() < deadline {
                if fm.fileExists(atPath: root.appendingPathComponent("cancel").path) { report("cancelled"); return }
                Thread.sleep(forTimeInterval: 0.1)
            }
            if fm.fileExists(atPath: root.appendingPathComponent("cancel").path) { report("cancelled"); return }
            guard !gui.unchanged else { throw problem("界面尚未退出，原应用已保留。") }
            // Do not replace files while any verified installation runtime remains.
            let running = try OwnedProcess.command("/bin/ps", ["-ww", "-axo", "comm="])
            guard !running.components(separatedBy: "\n").contains(where: { OwnedProcess.normalPath($0.trimmingCharacters(in: .whitespaces)).hasPrefix(OwnedProcess.normalPath(destination.appendingPathComponent("Contents/Resources/runtime").path) + "/") }) else { throw problem("后台组件仍在运行，原应用已保留。") }
            try validateBundle(candidate, version: version)
            try fm.moveItem(at: destination, to: backup!)
            do { try fm.moveItem(at: candidate, to: destination); swapped = true; try validateBundle(destination, version: version) }
            catch { try? fm.removeItem(at: destination); try fm.moveItem(at: backup!, to: destination); swapped = false; throw error }
            try relaunch(destination); report("done")
            // Retain the previous bundle until the replacement reports UI ready.
        } catch {
            if swapped, let target, let backup { try? fm.removeItem(at: target); try? fm.moveItem(at: backup, to: target) }
            report("error", error.localizedDescription)
            if let target { try? relaunch(target) }
            if let stage { try? fm.removeItem(at: stage) }
            throw error
        }
    }
    static func cleanup(data: URL, target: URL) {
        let fm = FileManager.default, repairs = data.appendingPathComponent("repairs")
        guard OwnedProcess.samePath(repairs.resolvingSymlinksInPath().path, repairs.path), let tickets = try? fm.contentsOfDirectory(atPath: repairs.path) else { return }
        for ticket in tickets where UUID(uuidString: ticket) != nil {
            let root = repairs.appendingPathComponent(ticket)
            guard OwnedProcess.samePath(root.resolvingSymlinksInPath().path, root.path),
                  let bytes = try? Data(contentsOf: root.appendingPathComponent("request.json")), bytes.count < 16384,
                  let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], OwnedProcess.samePath(request["target"] as? String ?? "", target.path), OwnedProcess.samePath(request["data"] as? String ?? "", data.path),
                  let statusBytes = try? Data(contentsOf: root.appendingPathComponent("status.json")),
                  let status = try? JSONSerialization.jsonObject(with: statusBytes) as? [String: Any],
                  let pid = status["helperPid"] as? Int32, OwnedProcess.inspect(pid) == nil,
                  ["done", "error", "cancelled"].contains(status["status"] as? String ?? "") else { continue }
            let stage = target.deletingLastPathComponent().appendingPathComponent(".Caibo-repair-\(ticket).app")
            guard OwnedProcess.samePath(request["stage"] as? String ?? "", stage.path) else { continue }
            // A backup is removed only after this process has rendered the UI.
            if status["status"] as? String == "done" { try? fm.removeItem(at: URL(fileURLWithPath: stage.path + ".backup")) }
            try? fm.removeItem(at: stage); try? fm.removeItem(at: root)
        }
    }
}
