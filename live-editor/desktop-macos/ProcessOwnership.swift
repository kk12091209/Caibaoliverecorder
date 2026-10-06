import Foundation
import Darwin

extension ISO8601DateFormatter {
    static var caibo: ISO8601DateFormatter {
        let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value
    }
}

// Capture launch time as well as executable. A recycled PID is never a match.
struct OwnedProcess: Equatable {
    let pid: Int32
    let identity: String
    static func normalPath(_ value: String) -> String {
        // Foundation shortens these macOS system aliases; user-created links
        // remain different and are rejected by the installation checks.
        if value == "/private/tmp" || value.hasPrefix("/private/tmp/") || value == "/private/var" || value.hasPrefix("/private/var/") { return String(value.dropFirst(8)) }
        return value
    }
    static func samePath(_ a: String, _ b: String) -> Bool { normalPath(a) == normalPath(b) }

    static func inspect(_ pid: Int32) -> OwnedProcess? {
        guard pid > 1, let output = try? command("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=,comm="]), !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return OwnedProcess(pid: pid, identity: output.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    var unchanged: Bool { Self.inspect(pid) == self }
    func signal(_ value: Int32) -> Bool { pid != getpid() && unchanged && Darwin.kill(pid, value) == 0 }

    static func command(_ executable: String, _ arguments: [String]) throws -> String {
        let task = Process(), output = Pipe()
        task.executableURL = URL(fileURLWithPath: executable); task.arguments = arguments
        task.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "en_US.UTF-8"]
        task.standardInput = FileHandle.nullDevice; task.standardOutput = output; task.standardError = FileHandle.nullDevice
        try task.run()
        let timeout = DispatchWorkItem {
            guard task.isRunning else { return }
            task.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                if task.isRunning { _ = Darwin.kill(task.processIdentifier, SIGKILL) }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: timeout)
        defer { timeout.cancel() }
        let bytes = output.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
        guard task.terminationStatus == 0 else { throw problem("\(URL(fileURLWithPath: executable).lastPathComponent) 维护步骤未完成（退出码 \(task.terminationStatus)）。") }
        return String(data: bytes, encoding: .utf8) ?? ""
    }
    static func descendants(of root: Int32, resources: URL) -> [OwnedProcess] {
        guard let table = try? command("/bin/ps", ["-ww", "-axo", "pid=,ppid=,comm="]) else { return [] }
        let allowed = Set(["node/node", "recorder/BililiveRecorder.Cli", "ffmpeg/ffmpeg", "ffmpeg/ffprobe"].map { normalPath(resources.appendingPathComponent("runtime/" + $0).path) })
        let expression = try! NSRegularExpression(pattern: "^\\s*(\\d+)\\s+(\\d+)\\s+(.+)$")
        var rows: [(Int32, Int32, String)] = []
        for line in table.components(separatedBy: "\n") {
            guard let match = expression.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
                  let a = Range(match.range(at: 1), in: line), let b = Range(match.range(at: 2), in: line), let c = Range(match.range(at: 3), in: line),
                  let pid = Int32(line[a]), let parent = Int32(line[b]) else { continue }
            rows.append((pid, parent, String(line[c])))
        }
        var family: Set<Int32> = [root], result: [OwnedProcess] = []
        for _ in 0..<32 {
            let next = rows.filter { family.contains($0.1) && !family.contains($0.0) }
            if next.isEmpty { break }
            for row in next {
                family.insert(row.0)
                if allowed.contains(normalPath(row.2)), let value = inspect(row.0) { result.insert(value, at: 0) }
            }
        }
        return result
    }
    static func orphanedComponents(resources: URL, data: URL) -> [OwnedProcess] {
        guard let table = try? command("/bin/ps", ["-ww", "-axo", "pid=,comm="]) else { return [] }
        let core = normalPath(resources.appendingPathComponent("runtime/recorder/BililiveRecorder.Cli").path)
        let media = Set(["ffmpeg", "ffprobe"].map { normalPath(resources.appendingPathComponent("runtime/ffmpeg/" + $0).path) })
        let dataRoots = [data, data.appendingPathComponent("recovery/safe-data")]
        let originalPaths = dataRoots.map { normalPath($0.appendingPathComponent("originals").path) }
        var result: [OwnedProcess] = []
        for line in table.components(separatedBy: "\n") {
            let text = line.trimmingCharacters(in: .whitespaces), parts = text.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            guard parts.count == 2, let pid = Int32(parts[0]) else { continue }
            let executable = normalPath(String(parts[1]).trimmingCharacters(in: .whitespaces))
            guard executable == core || media.contains(executable), let identity = inspect(pid), let raw = try? command("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]) else { continue }
            let argv = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/private/tmp/", with: "/tmp/").replacingOccurrences(of: "/private/var/", with: "/var/")
            if executable == core {
                guard let originals = originalPaths.first(where: { argv.hasSuffix(" " + $0) }), argv.hasPrefix(core + " run --http-bind http://127.0.0.1:") else { continue }
                let middle = String(argv.dropFirst(core.count).dropLast(originals.count))
                guard middle.range(of: "^ run --http-bind http://127\\.0\\.0\\.1:[0-9]{1,5} --http-basic-user editor --http-basic-pass [a-f0-9]{48} --enable-file-browser false $", options: .regularExpression) != nil else { continue }
                result.append(identity)
            } else {
                for dataRoot in dataRoots {
                let temp = dataRoot.appendingPathComponent("temp")
                guard let folders = try? FileManager.default.contentsOfDirectory(atPath: temp.path) else { continue }
                for folder in folders where folder.hasPrefix("bili-export-") || folder.hasPrefix("bili-probe-") {
                    let directory = temp.appendingPathComponent(folder)
                    guard samePath(directory.resolvingSymlinksInPath().path, directory.path),
                          let bytes = try? Data(contentsOf: directory.appendingPathComponent(".bili-temp-owner.json")), bytes.count <= 16384,
                          let marker = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], marker["format"] as? String == "bili-editor-temp-v1", marker["directory"] as? String == folder,
                          let token = marker["token"] as? String, UUID(uuidString: token) != nil,
                          let owner = marker["ownerPid"] as? Int32, inspect(owner) == nil,
                          let children = marker["childPids"] as? [Int32], children.contains(pid),
                          argv.hasPrefix(executable + " "), argv.contains(normalPath(directory.path) + "/") else { continue }
                    if !result.contains(identity) { result.append(identity) }; break
                }
                }
            }
        }
        return result
    }
}
