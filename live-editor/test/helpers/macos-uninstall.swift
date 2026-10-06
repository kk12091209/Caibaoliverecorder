import AppKit
import Foundation

@main struct Checks {
    @MainActor static func main() async throws {
        let mode=CommandLine.arguments[1],root=URL(fileURLWithPath:CommandLine.arguments[2]),data=root.appendingPathComponent("data"),app=root.appendingPathComponent("QA.app")
        if mode == "locked" {
            do { var lease=try UninstallDataLease.acquire(data:data);lease.close();fatalError("active writer was ignored") }
            catch { print("PASS active Node writer blocks native uninstall") }
        } else if mode == "hold" {
            var lease=try UninstallDataLease.acquire(data:data);defer {lease.close()}
            print("PASS native lease acquired");fflush(stdout)
            for _ in 0..<200 { if FileManager.default.fileExists(atPath:root.appendingPathComponent("release").path) {return};try await Task.sleep(nanoseconds:50_000_000) }
            fatalError("release timeout")
        } else if mode == "validate" {
            try CompleteUninstall.validate(app:app,data:data)
            for bad in [FileManager.default.homeDirectoryForCurrentUser,URL(fileURLWithPath:"/"),root] {
                do {try CompleteUninstall.validate(app:app,data:bad);fatalError("unsafe data directory accepted")}catch { }
            }
            print("PASS validated removable fixture and rejected broad data paths")
        } else if mode == "corrupt" {
            var lease=try UninstallDataLease.acquire(data:data);defer {lease.close()}
            guard try String(contentsOf:data.appendingPathComponent("desktop-service.lock.sqlite"),encoding:.utf8)=="retained bad lease" else {fatalError("corrupt original altered")}
            print("PASS corrupt primary preserved under independent repair guard")
        }
    }
}
