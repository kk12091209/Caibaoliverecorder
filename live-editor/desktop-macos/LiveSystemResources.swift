import Foundation
import IOKit.ps

// One read-only snapshot. No assertions, settings changes, or persistent process.
let thermal: String
switch ProcessInfo.processInfo.thermalState {
case .nominal: thermal = "nominal"
case .fair: thermal = "fair"
case .serious: thermal = "serious"
case .critical: thermal = "critical"
@unknown default: thermal = "unknown"
}
var acPower: Any = NSNull()
if let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
   let source = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() {
    let value = source as String
    if value == kIOPSACPowerValue { acPower = true }
    else if value == kIOPSBatteryPowerValue { acPower = false }
}
let snapshot: [String: Any] = ["version": 1, "sampledAt": Date().timeIntervalSince1970 * 1000,
    "acPower": acPower, "thermal": thermal, "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled]
let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
