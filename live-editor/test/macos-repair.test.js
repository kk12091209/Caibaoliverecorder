import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

test('native Mac repair validates the official source and preserves data on corrupt, unavailable or unsafe repairs', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const root = await fs.mkdtemp('/private/tmp/caibo-repair-test-');
  try {
    const source = path.join(root, 'Checks.swift');
    await fs.writeFile(source, String.raw`
import Foundation
import Darwin
@main struct Checks {
    @MainActor static func main() async throws {
        let fm = FileManager.default, root = URL(fileURLWithPath: CommandLine.arguments[1])
        let target = root.appendingPathComponent("菜播·录包机.app"), data = root.appendingPathComponent("data")
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        try fm.createDirectory(at: data, withIntermediateDirectories: true)
        let original = data.appendingPathComponent("original.flv")
        try Data("preserve user recording".utf8).write(to: original)
        let name = "Caibo-0.2.0-macos-arm64.dmg", url = "https://github.com/kk12091209/Caibaoliverecorder/releases/download/v0.2.0/" + name
        let package = Data("corrupt package".utf8)
        let asset: [String: Any] = ["name": name, "state": "uploaded", "size": package.count, "digest": "sha256:" + String(repeating: "0", count: 64), "browser_download_url": url]
        let release: [String: Any] = ["tag_name": "v0.2.0", "draft": false, "prerelease": false, "assets": [asset]]
        _ = try RepairTrust.asset(release, version: "0.2.0"); print("PASS current version is repairable without a version bump")
        for address in ["http://github.com/kk12091209/Caibaoliverecorder/releases/download/v0.2.0/x", "https://github.com/other/project/releases/download/v0.2.0/x", "https://github.com.evil.test/kk12091209/Caibaoliverecorder/releases/download/v0.2.0/x", "https://user:password@github.com/kk12091209/Caibaoliverecorder/releases/download/v0.2.0/x", "https://api.github.com/repos/other/project/releases/tags/v0.2.0", "https://release-assets.githubusercontent.com:8443/x"] {
            guard !RepairTrust.allowed(URL(string: address)!) else { throw problem("Untrusted repair source accepted") }
        }
        print("PASS foreign sources, credentials, HTTP and unusual ports rejected")
        for (key, bad) in [("digest", "sha256:"), ("size", 600 * 1024 * 1024), ("state", "new"), ("browser_download_url", "https://example.com/x")] as [(String, Any)] {
            var changed = asset; changed[key] = bad; var metadata = release; metadata["assets"] = [changed]
            var rejected = false; do { _ = try RepairTrust.asset(metadata, version: "0.2.0") } catch { rejected = true }
            guard rejected else { throw problem("Invalid release accepted") }
        }
        var draft = release; draft["draft"] = true
        var rejected = false; do { _ = try RepairTrust.asset(draft, version: "0.2.0") } catch { rejected = true }
        guard rejected else { throw problem("Draft repair accepted") }
        rejected = false; do { _ = try RepairTrust.asset(release, version: "0.1.6") } catch { rejected = true }
        guard rejected else { throw problem("Wrong version accepted") }
        print("PASS incomplete assets, drafts and other versions rejected")
        let file = root.appendingPathComponent("digest.txt"); try Data("abc".utf8).write(to: file)
        guard try RepairTrust.digest(file) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" else { throw problem("Streaming digest incorrect") }
        print("PASS streaming SHA256")
        var downloaded: [URL] = [], logs: [String] = []
        let repair = ComponentRepair(target: target, data: data, version: "0.2.0", helperExecutable: URL(fileURLWithPath: CommandLine.arguments[0]), downloader: { address, destination, _, _ in
            downloaded.append(address)
            try (address.host == "api.github.com" ? JSONSerialization.data(withJSONObject: release) : package).write(to: destination)
        }, progress: { _ in }, log: { logs.append($0) })
        var stageError = ""
        rejected = false; do { _ = try await repair.stage() } catch { stageError = error.localizedDescription; rejected = error.localizedDescription.contains("校验失败") }
        guard rejected, downloaded.count == 2, try Data(contentsOf: original) == Data("preserve user recording".utf8), fm.fileExists(atPath: target.path), (try fm.contentsOfDirectory(atPath: data.appendingPathComponent("repairs").path)).isEmpty else { throw problem("Corrupt repair state: error=\(stageError), downloads=\(downloaded.count)") }
        print("PASS corrupt package is rejected before mounting; installation and data preserved")
        let offline = ComponentRepair(target: target, data: data, version: "0.2.0", downloader: { _, _, _, _ in throw problem("offline fixture") }, progress: { _ in }, log: { _ in })
        rejected = false; do { _ = try await offline.stage() } catch { rejected = true }
        guard rejected, try Data(contentsOf: original) == Data("preserve user recording".utf8), (try fm.contentsOfDirectory(atPath: data.appendingPathComponent("repairs").path)).isEmpty else { throw problem("Offline repair did not preserve data/clean staging") }
        print("PASS unavailable download safely preserves installation and data")
        let linked = root.appendingPathComponent("linked.app"); try fm.createSymbolicLink(at: linked, withDestinationURL: target)
        let unsafe = ComponentRepair(target: linked, data: data, version: "0.2.0", downloader: { _, _, _, _ in throw problem("Should not contact network") }, progress: { _ in }, log: { _ in })
        rejected = false; do { _ = try await unsafe.stage() } catch { rejected = true }
        guard rejected else { throw problem("Symlink installation accepted") }
        print("PASS symlink installation rejected before download")
        let child = Process(); child.executableURL = URL(fileURLWithPath: "/bin/sleep"); child.arguments = ["20"]; try child.run()
        defer { if child.isRunning { child.terminate() } }
        guard let captured = OwnedProcess.inspect(child.processIdentifier) else { throw problem("Cannot capture child") }
        let recycled = OwnedProcess(pid: child.processIdentifier, identity: captured.identity + " changed")
        guard !recycled.signal(SIGKILL), child.isRunning else { throw problem("Changed identity was signalled") }
        print("PASS changed/reused process identity is never signalled")
        let request = data.appendingPathComponent("repairs/fake/request.json")
        try fm.createDirectory(at: request.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["schema": 1, "target": target.path]).write(to: request)
        rejected = false; do { try ComponentRepair.apply(request) } catch { rejected = true }
        guard rejected, fm.fileExists(atPath: target.path), try Data(contentsOf: original) == Data("preserve user recording".utf8) else { throw problem("Malformed apply request changed installation") }
        print("PASS malformed helper request preserves installation")
        let bundle = root.appendingPathComponent("complete.app"), resources = bundle.appendingPathComponent("Contents/Resources")
        let editor = resources.appendingPathComponent("live-editor")
        for folder in ["server", "dist/assets"] { try fm.createDirectory(at: editor.appendingPathComponent(folder), withIntermediateDirectories: true) }
        try fm.createDirectory(at: bundle.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        try fm.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: bundle.appendingPathComponent("Contents/MacOS/Check"))
        let plist: [String: Any] = ["CFBundleIdentifier": "io.github.kk12091209.caibo", "CFBundleExecutable": "Check", "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: bundle.appendingPathComponent("Contents/Info.plist"))
        for name in ["node/node", "recorder/BililiveRecorder.Cli", "ffmpeg/ffmpeg", "ffmpeg/ffprobe"] {
            let executable = resources.appendingPathComponent("runtime/" + name)
            try fm.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: executable)
        }
        for name in ["BililiveRecorder.Cli.dll", "BililiveRecorder.Core.dll", "BililiveRecorder.Cli.deps.json", "BililiveRecorder.Cli.runtimeconfig.json", "libhostfxr.dylib", "libcoreclr.dylib", "OtherDependency.dll"] { try Data("fixture".utf8).write(to: resources.appendingPathComponent("runtime/recorder/" + name)) }
        try Data("{}".utf8).write(to: editor.appendingPathComponent("package.json"))
        try Data("// fixture".utf8).write(to: editor.appendingPathComponent("server/index.js"))
        try Data("<div id=\"app\"></div><script src=\"/assets/app.js\"></script>".utf8).write(to: editor.appendingPathComponent("dist/index.html"))
        try Data("// fixture".utf8).write(to: editor.appendingPathComponent("dist/assets/app.js"))
        _ = try OwnedProcess.command("/usr/bin/codesign", ["--force", "--sign", "-", bundle.path])
        let complete = Backend(resources: resources, data: data, exports: root)
        try await complete.validateComponents()
        try fm.removeItem(at: resources.appendingPathComponent("runtime/recorder/OtherDependency.dll"))
        let damaged = Backend(resources: resources, data: data, exports: root)
        rejected = false; do { try await damaged.validateComponents() } catch { rejected = error is MissingComponent }
        guard rejected, try Data(contentsOf: original) == Data("preserve user recording".utf8) else { throw problem("Dependency removed from signed bundle was not detected") }
        print("PASS signed bundle integrity catches any missing dependency before startup")
    }
}
`);
    const env = { ...process.env, TMPDIR: '/private/tmp', TMP: '/private/tmp', TEMP: '/private/tmp' }, executable = path.join(root, 'checks');
    const files = ['ProcessOwnership.swift', 'Repair.swift', 'Backend.swift'].map(name => fileURLToPath(new URL('../desktop-macos/' + name, import.meta.url)));
    await run('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', path.join(root, 'modules'), ...files, source, '-o', executable], { env, timeout: 45000 });
    const { stdout } = await run(executable, [root], { env, timeout: 10000 });
    assert.equal(stdout.match(/^PASS /gm)?.length, 10, stdout);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
