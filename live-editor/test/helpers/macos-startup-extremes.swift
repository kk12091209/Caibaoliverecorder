import AppKit
import WebKit
import Foundation
import Darwin

@main struct Checks {
    @MainActor static func main() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), fm = FileManager.default
        let server = CommandLine.arguments[2]
        var controllers: [AppDelegate] = [], children: [Process] = [], logs: [String] = []
        defer {
            for child in children where child.isRunning { child.terminate(); child.waitUntilExit() }
            for value in controllers { value.backend.exitRequested = true; value.web.stopLoading(); value.web.configuration.userContentController.removeScriptMessageHandler(forName: "caibo"); value.window.orderOut(nil) }
        }
        func check(_ value: Bool, _ name: String) throws { guard value else { throw problem(name) }; print("PASS " + name) }
        func fixture(_ name: String, mode: String? = nil) throws -> AppDelegate {
            let base = root.appendingPathComponent(name), resources = base.appendingPathComponent("resources"), editor = resources.appendingPathComponent("live-editor"), data = base.appendingPathComponent("data")
            for name in ["server", "dist/assets"] { try fm.createDirectory(at: editor.appendingPathComponent(name), withIntermediateDirectories: true) }
            for name in ["node/node", "recorder/BililiveRecorder.Cli", "ffmpeg/ffmpeg", "ffmpeg/ffprobe"] {
                let file = resources.appendingPathComponent("runtime/" + name); try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true); try fm.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: file)
            }
            for name in ["BililiveRecorder.Cli.dll", "BililiveRecorder.Core.dll", "BililiveRecorder.Cli.deps.json", "BililiveRecorder.Cli.runtimeconfig.json", "libhostfxr.dylib", "libcoreclr.dylib"] { try Data("fixture".utf8).write(to: resources.appendingPathComponent("runtime/recorder/" + name)) }
            try Data("{}".utf8).write(to: editor.appendingPathComponent("package.json")); try Data("// fixture".utf8).write(to: editor.appendingPathComponent("server/index.js"))
            try Data("<div id=\"app\"></div><script src=\"/assets/app.js\"></script>".utf8).write(to: editor.appendingPathComponent("dist/index.html")); try Data("// fixture".utf8).write(to: editor.appendingPathComponent("dist/assets/app.js"))
            let value = AppDelegate(); value.backend = Backend(resources: resources, data: data, exports: base.appendingPathComponent("exports")); try value.backend.prepare()
            try Data("preserve recording and settings".utf8).write(to: data.appendingPathComponent("sentinel.txt"))
            value.window = NSWindow(contentRect: NSRect(x: 0,y: 0,width: 640,height: 480), styleMask: [.titled], backing: .buffered, defer: true); value.web = WKWebView(frame: .zero)
            value.startupPanel = NSView(); value.startupTitle = NSTextField(labelWithString: ""); value.startupDetail = NSTextField(labelWithString: ""); value.startupRetry = NSButton(); value.startupLogs = NSButton()
            value.backend.onDiagnostic = { [weak value] message in logs.append(message); value?.logStartup(message, forward: false) }
            controllers.append(value)
            if let mode { try endpoint(value, mode: mode) }
            return value
        }
        func endpoint(_ value: AppDelegate, mode: String) throws {
            try Data(mode.utf8).write(to: value.backend.data.appendingPathComponent("mode"))
            let record: [String: Any] = ["protocol": 1, "instance": String(repeating: "a", count: 32), "token": String(repeating: "b", count: 64), "pid": Int(getpid()), "origin": server, "dataPath": value.backend.data.path, "build": value.backend.expectedBuild, "fixtureClient": value.backend.client]
            try JSONSerialization.data(withJSONObject: record).write(to: value.backend.data.appendingPathComponent("desktop-service.json"))
        }
        func sleepChild(_ value: AppDelegate) throws -> Process {
            let child = Process(); child.executableURL = URL(fileURLWithPath: "/bin/sleep"); child.arguments = ["30"]; try child.run(); children.append(child); value.backend.process = child; return child
        }
        func protect(_ value: AppDelegate, _ child: Process, time: String?) throws {
            var state: [String: Any] = ["pid": Int(child.processIdentifier), "dataPath": value.backend.data.path, "phase": "恢复待保存视频", "ready": false, "recoverable": false]
            if let time { state["updatedAt"] = time }
            try JSONSerialization.data(withJSONObject: state).write(to: value.backend.data.appendingPathComponent("desktop-startup-state.json"))
        }
        // These fixtures exit immediately, including between two native polls.
        let crash = try fixture("crash")
        for _ in 0..<8 { await crash.connect() }
        try check(crash.backend.launchAttempts == 3 && crash.connectionPaused && !crash.connectionInFlight && crash.startupRetry.isEnabled && !crash.startupLogs.isHidden, "fast repeated crashes stop after three launches with usable failure actions")
        for _ in 0..<25 { await crash.poll() }
        try check(crash.backend.launchAttempts == 3 && crash.connectionPaused && crash.startupRetry.isEnabled, "repeated timer polls cannot bypass the paused restart budget")
        try endpoint(crash, mode: "healthy"); await crash.poll()
        try check(crash.ready && crash.pageLoading && !crash.connectionPaused, "late healthy service is discovered even after automatic retries pause")
        crash.web.stopLoading(); crash.ready = false; crash.connectionPaused = true
        crash.retryStartup()
        for _ in 0..<100 { if crash.ready && !crash.connectionInFlight { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        try check(crash.ready && !crash.connectionPaused && crash.backend.launchAttempts == 0, "manual retry resets the budget and reconnects successfully")
        crash.web.stopLoading(); crash.pageReady = true; crash.pageReadySince = Date().addingTimeInterval(-61); await crash.poll()
        try check(crash.backend.launchAttempts == 0 && crash.backendRecoveryAttempts == 0, "stable interface renews recovery budget for a later independent fault")

        let stalled = try fixture("stalled", mode: "stall"), begun = Date()
        var timedOut = false; do { _ = try await stalled.backend.ensure(timeout: 0.2) } catch { timedOut = true }
        try check(timedOut && Date().timeIntervalSince(begun) < 1.5 && !stalled.backend.connecting, "never-ending HTTP request obeys total startup deadline")
        for mode in ["503", "bad-json", "wrong-instance", "wrong-data"] {
            let value = try fixture(mode, mode: mode); value.backend.readEndpoint()
            try check(await value.backend.heartbeat(timeout: 0.2) == nil, "reject " + mode + " without accepting a false ready state")
        }
        let busy = try fixture("busy", mode: "old-busy")
        let busyStatus = try await busy.backend.ensure(timeout: 0.3)
        try check(busyStatus["busy"] as? Bool == true && busy.backend.launchAttempts == 0, "old-build busy writer is preserved until its tasks finish")
        let invalid = try fixture("invalid-endpoint")
        for bytes in [Data("{".utf8), Data("{}".utf8), Data(repeating: 0x20, count: 12000)] {
            try bytes.write(to: invalid.backend.data.appendingPathComponent("desktop-service.json")); try check(!invalid.backend.readEndpoint(), "malformed endpoint rejected size=" + String(bytes.count))
        }
        try endpoint(invalid, mode: "healthy")
        let oversized = try Data(contentsOf: invalid.backend.data.appendingPathComponent("desktop-service.json")) + Data(repeating: 0x20, count: 20000)
        try oversized.write(to: invalid.backend.data.appendingPathComponent("desktop-service.json"))
        try check(!invalid.backend.readEndpoint(), "oversized otherwise-valid state file is rejected with bounded reads")
        let invalidBinary = try fixture("invalid-binary")
        let node = invalidBinary.backend.resources.appendingPathComponent("runtime/node/node")
        try Data("not an executable".utf8).write(to: node); try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        for _ in 0..<5 { await invalidBinary.connect() }
        try check(invalidBinary.connectionPaused && invalidBinary.backend.launchAttempts == 3 && invalidBinary.startupRetry.isEnabled, "executable-format failures are bounded too")

        let fresh = try fixture("fresh-save"), freshChild = try sleepChild(fresh)
        try protect(fresh, freshChild, time: ISO8601DateFormatter.caibo.string(from: Date()))
        try check(await fresh.backend.recoverOwnedProcess(grace: 0.1) == false && freshChild.isRunning, "active save stage cannot be interrupted")
        for (name, stamp) in [("missing-clock", Optional<String>.none), ("broken-clock", Optional("invalid")), ("future-clock", Optional(ISO8601DateFormatter.caibo.string(from: Date().addingTimeInterval(86400))))] {
            let value = try fixture(name), child = try sleepChild(value); try protect(value, child, time: stamp)
            try check(await value.backend.recoverOwnedProcess(grace: 0.1) == false && child.isRunning, name + " initially protects a potentially active writer")
            try await Task.sleep(nanoseconds: 180_000_000)
            try check(await value.backend.recoverOwnedProcess(grace: 0.2) && !child.isRunning, name + " cannot protect an unchanged deadlock forever")
        }
        let stale = try fixture("stale-save"), staleChild = try sleepChild(stale)
        try protect(stale, staleChild, time: ISO8601DateFormatter.caibo.string(from: Date().addingTimeInterval(-180)))
        try check(await stale.backend.recoverOwnedProcess(grace: 0.2) && !staleChild.isRunning, "stale save-state progress permits controlled recovery")
        let quitting = try fixture("quitting"), quittingChild = try sleepChild(quitting)
        quitting.backend.exitRequested = true; await quitting.connect()
        try check(await quitting.backend.recoverOwnedProcess(grace: 0.1) == false && quittingChild.isRunning && quitting.backend.launchAttempts == 0, "recovery cannot spawn or signal components during shutdown")
        let hidden = try fixture("hidden", mode: "healthy"); hidden.ready = true; hidden.pageLoading = true; hidden.pageDeadline = Date().addingTimeInterval(-10); await hidden.poll()
        try check(!hidden.pageFailed && hidden.pageRetries == 0 && hidden.pageDeadline! > Date(), "hidden or occluded window does not trigger a false WebKit timeout")
        let repair = try fixture("repair-loop"); repair.repairAttempted = true
        await repair.repairComponents("缺失 Node")
        for _ in 0..<10 { await repair.poll() }
        try check(repair.connectionPaused && !repair.repairing && repair.backend.launchAttempts == 0 && repair.startupRetry.isEnabled && repair.startupDetail.stringValue.contains("已暂停重复下载"), "failed repair pauses without infinite download or restart loops")
        let recentRepair = try fixture("recent-repair")
        try JSONSerialization.data(withJSONObject: ["time": Date().timeIntervalSince1970]).write(to: recentRepair.backend.data.appendingPathComponent("desktop-repair-attempt.json"))
        await recentRepair.repairComponents("缺失 Node")
        try check(recentRepair.connectionPaused && recentRepair.repairAttempted && recentRepair.startupDetail.stringValue.contains("已暂停重复下载"), "recent repair ledger prevents a cross-process download loop")
        let futureRepair = try fixture("future-repair")
        try JSONSerialization.data(withJSONObject: ["time": Date().timeIntervalSince1970 + 86400]).write(to: futureRepair.backend.data.appendingPathComponent("desktop-repair-attempt.json"))
        await futureRepair.repairComponents("缺失 Node")
        try check(futureRepair.connectionPaused && futureRepair.startupDetail.stringValue.contains("版本信息缺失"), "future repair timestamp cannot suppress a legitimate repair attempt")
        let vanished = try fixture("vanished-node", mode: "healthy")
        try fm.removeItem(at: vanished.backend.resources.appendingPathComponent("runtime/node/node"))
        var missing = false; do { try await vanished.restartInterface(attempt: 1) } catch { missing = error is MissingComponent }
        try check(missing && !vanished.terminating, "component lost after launch is classified for repair before restarting the interface")
        for value in controllers { try check(try Data(contentsOf: value.backend.data.appendingPathComponent("sentinel.txt")) == Data("preserve recording and settings".utf8), "preserve user data " + value.backend.data.deletingLastPathComponent().lastPathComponent) }
        try check(!logs.contains(where: { $0.contains(String(repeating: "b", count: 64)) }), "diagnostics never disclose service authentication tokens")
    }
}
