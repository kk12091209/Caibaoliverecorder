import Foundation
import IOKit.pwr_mgt

func problem(_ message: String) -> NSError { NSError(domain: "PowerStatusChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

@main struct PowerStatusChecks {
    static func main() throws {
        func expect(_ actual: String, _ expected: String) {
            precondition(actual == expected, "Expected \(expected), got \(actual)")
        }
        // The AC switch must follow its own saved setting, regardless of battery,
        // display, wake-on-network, lid policy, or active application assertions.
        expect(RecordingPowerStatus.systemSleepAC(from: "Battery Power:\n sleep 1\nAC Power:\n displaysleep 30\n womp 1\n sleep 0\n"), "enabled")
        expect(RecordingPowerStatus.systemSleepAC(from: "AC Power:\n displaysleep 0\n sleep 10\nBattery Power:\n sleep 0\n"), "disabled")
        for invalid in [nil, "", "Battery Power:\n sleep 0", "AC Power:\n displaysleep 0", "AC Power:\n sleep -1", "AC Power:\n sleep false", "AC Power:\n sleep 0.0", "AC Power:\n sleep 0 (sleep prevented by other app)", "AC Power:\n sleep 0\n sleep 1"] as [String?] {
            expect(RecordingPowerStatus.systemSleepAC(from: invalid), "unknown")
        }
        expect(RecordingPowerStatus.lidStatus(nil), "unknown")
        expect(RecordingPowerStatus.lidStatus([:]), "not-applicable")
        expect(RecordingPowerStatus.lidStatus(["AppleClamshellState": false]), "unknown")
        expect(RecordingPowerStatus.lidStatus(["AppleClamshellState": false, "AppleClamshellCausesSleep": true]), "disabled")
        expect(RecordingPowerStatus.lidStatus(["AppleClamshellState": true, "AppleClamshellCausesSleep": false]), "enabled")
        for invalid: Any in ["false", 0, 1, NSNull()] {
            expect(RecordingPowerStatus.lidStatus(["AppleClamshellCausesSleep": invalid]), "unknown")
        }
        // Other apps' assertions never imply this application's protection is active.
        let active = [kIOPMAssertionLevelKey as String: NSNumber(value: kIOPMAssertionLevelOn)]
        expect(RecordingPowerStatus.protectionStatus(active, requested: true, needed: true), "active")
        expect(RecordingPowerStatus.protectionStatus(nil, requested: true, needed: true), "unknown")
        expect(RecordingPowerStatus.protectionStatus([kIOPMAssertionLevelKey as String: 0], requested: true, needed: true), "inactive")
        expect(RecordingPowerStatus.protectionStatus(active, requested: false, needed: true), "inactive")
        expect(RecordingPowerStatus.protectionStatus(nil, requested: false, needed: false), "standby")
        for lid in ["enabled", "disabled", "unknown", "not-applicable"] {
            let urls = RecordingPowerStatus.settingsURLs(lid: lid)
            precondition(urls.count == 2 && urls[0].scheme == "x-apple.systempreferences")
            precondition(urls[0].absoluteString.contains(lid == "not-applicable" ? "energysaver" : "battery"))
            precondition(urls[1].path == "/System/Applications/System Settings.app")
        }
        // Reads the host's state only: no assertions, commands, or settings writes.
        let snapshot = RecordingPowerStatus.snapshot(assertion: nil, needed: false, systemSleepAC: RecordingPowerStatus.readSystemSleepAC())
        precondition(snapshot["version"] as? Int == 2)
        precondition(["enabled", "disabled", "unknown"].contains(snapshot["systemSleepAC"] as? String ?? ""))
        let switchedOff = RecordingPowerStatus.snapshot(assertion: nil, needed: false, systemSleepAC: "disabled")
        precondition(switchedOff["systemSleepAC"] as? String == "disabled")
        precondition(snapshot["protection"] as? String == "standby")
        precondition(["enabled", "disabled", "unknown", "not-applicable"].contains(snapshot["lid"] as? String ?? ""))
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
        print("PASS power state checks; read-only host snapshot: \(String(decoding: data, as: UTF8.self))")
    }
}
