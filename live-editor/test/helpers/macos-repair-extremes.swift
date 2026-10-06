import Foundation
import Darwin

@main struct Checks {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), fm = FileManager.default
        let package = Data("synthetic invalid disk image".utf8)
        let packageFile = root.appendingPathComponent("package"); try package.write(to: packageFile)
        let digest = try RepairTrust.digest(packageFile)
        let url = "https://github.com/kk12091209/Caibaoliverecorder/releases/download/v0.2.0/Caibo-0.2.0-macos-arm64.dmg"
        let asset: [String: Any] = ["name": "Caibo-0.2.0-macos-arm64.dmg", "state": "uploaded", "size": package.count, "digest": "sha256:" + digest, "browser_download_url": url]
        let release: [String: Any] = ["tag_name": "v0.2.0", "draft": false, "prerelease": false, "assets": [asset]]
        for mode in ["offline", "timeout", "disk-full", "cancelled", "partial-metadata", "partial-package", "oversized-package", "bad-hash", "invalid-dmg", "wrong-version", "draft", "missing-digest", "read-only-install", "read-only-data", "linked-cache"] {
            let base = root.appendingPathComponent(mode), parent = base.appendingPathComponent("install"), target = parent.appendingPathComponent("Caibo.app"), data = base.appendingPathComponent("data")
            try fm.createDirectory(at: target, withIntermediateDirectories: true); try fm.createDirectory(at: data, withIntermediateDirectories: true)
            let marker = target.appendingPathComponent("original-component"), sentinel = data.appendingPathComponent("recording.flv")
            try Data("old application".utf8).write(to: marker); try Data("original video and configuration".utf8).write(to: sentinel)
            if mode == "read-only-install" { try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: parent.path) }
            if mode == "read-only-data" { try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: data.path) }
            var linked: URL?
            if mode == "linked-cache" { let destination = base.appendingPathComponent("external"); try fm.createDirectory(at: destination, withIntermediateDirectories: false); try fm.createSymbolicLink(at: data.appendingPathComponent("repairs"), withDestinationURL: destination); linked = destination }
            defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path); try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: data.path) }
            var downloads = 0, progress: [String] = []
            let repair = ComponentRepair(target: target, data: data, version: "0.2.0", helperExecutable: URL(fileURLWithPath: CommandLine.arguments[0]), downloader: { address, destination, _, _ in
                downloads += 1
                if mode == "offline" { throw URLError(.notConnectedToInternet) }
                if mode == "timeout" { throw URLError(.timedOut) }
                if mode == "disk-full" { throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC)) }
                if mode == "cancelled" { throw CancellationError() }
                if address.host == "api.github.com" {
                    if mode == "partial-metadata" { try Data("{".utf8).write(to: destination); return }
                    var metadata = release, entry = asset
                    if mode == "wrong-version" { metadata["tag_name"] = "v0.1.6" }
                    if mode == "draft" { metadata["draft"] = true }
                    if mode == "missing-digest" { entry.removeValue(forKey: "digest") }
                    if mode == "bad-hash" { entry["digest"] = "sha256:" + String(repeating: "0", count: 64) }
                    metadata["assets"] = [entry]; try JSONSerialization.data(withJSONObject: metadata).write(to: destination)
                } else {
                    if mode == "partial-package" { try package.prefix(4).write(to: destination) }
                    else if mode == "oversized-package" { try (package + Data([1])).write(to: destination) }
                    else { try package.write(to: destination) }
                }
            }, progress: { progress.append($0) }, log: { _ in })
            var rejected = false
            do { _ = try await repair.stage() } catch { rejected = true }
            guard rejected, try Data(contentsOf: marker) == Data("old application".utf8), try Data(contentsOf: sentinel) == Data("original video and configuration".utf8) else { throw problem("Failure replaced application or data: " + mode) }
            let repairs = data.appendingPathComponent("repairs")
            if let linked { guard try fm.contentsOfDirectory(atPath: linked.path).isEmpty else { throw problem("Wrote through linked cache") } }
            else if fm.fileExists(atPath: repairs.path) { guard try fm.contentsOfDirectory(atPath: repairs.path).isEmpty else { throw problem("Partial repair cache leaked: " + mode) } }
            guard try fm.contentsOfDirectory(atPath: parent.path) == ["Caibo.app"], downloads <= 2 else { throw problem("Partial application or repeated download leaked") }
            if ["read-only-install", "read-only-data", "linked-cache"].contains(mode) { guard downloads == 0 else { throw problem("Unsafe write location allowed a download") } }
            else { guard !progress.isEmpty else { throw problem("Repair gave no phase feedback") } }
            print("PASS " + mode + " fails cleanly and preserves application, data and cache boundaries")
        }
        let delegate = RepairTransfer(limit: 100, progress: { _ in }), session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: URL(string: url)!), response = HTTPURLResponse(url: URL(string: url)!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        var accepted: URLRequest?
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: "https://evil.example/repair")!), completionHandler: { accepted = $0 })
        guard accepted == nil else { throw problem("Foreign repair redirect accepted") }; print("PASS redirected foreign package source rejected")
        for _ in 0..<6 { delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: "https://release-assets.githubusercontent.com/package")!), completionHandler: { accepted = $0 }) }
        guard accepted == nil else { throw problem("Redirect loop remained unlimited") }; print("PASS redirect loops remain bounded")
    }
}
