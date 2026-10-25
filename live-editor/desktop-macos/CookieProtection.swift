import Foundation
import Security
import CryptoKit

// A non-synchronizing, device-local Keychain key protects authenticated blobs.
// Input and output use pipes; no credential is accepted in process arguments.
enum StorageFailure: Error { case unavailable }
func key(_ namespace: String, create: Bool) throws -> SymmetricKey {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.github.kk12091209.caibo.cookie-key.v1",
        kSecAttrAccount as String: namespace, kSecAttrSynchronizable as String: false]
    var read = query
    read[kSecReturnData as String] = true
    read[kSecMatchLimit as String] = kSecMatchLimitOne
    // Startup stays silent. Only an explicit Save may ask macOS to authorize
    // access again (for example after changing the helper's signing identity).
    read[kSecUseAuthenticationUI as String] = create ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail
    var result: CFTypeRef?
    let status = SecItemCopyMatching(read as CFDictionary, &result)
    if status == errSecSuccess, let bytes = result as? Data, bytes.count == 32 { return SymmetricKey(data: bytes) }
    guard status == errSecItemNotFound && create else { throw StorageFailure.unavailable }
    var bytes = Data(count: 32)
    let randomStatus = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard randomStatus == errSecSuccess else { throw StorageFailure.unavailable }
    var add = query
    add[kSecValueData as String] = bytes
    add[kSecAttrLabel as String] = "菜播·录包机 Cookie 加密密钥"
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw StorageFailure.unavailable }
    return SymmetricKey(data: bytes)
}
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 131072, let request = try JSONSerialization.jsonObject(with: input) as? [String: String],
          let operation = request["operation"], ["seal", "open"].contains(operation),
          let namespace = request["namespace"], namespace.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          let context = request["context"], ["bilibili", "douyin"].contains(where: { context == "caibao.cookies.v1:\(namespace):\($0)" }),
          let encoded = request["data"], let data = Data(base64Encoded: encoded) else { throw StorageFailure.unavailable }
    let encryptionKey = try key(namespace, create: operation == "seal")
    let aad = Data(context.utf8)
    let result: Data
    if operation == "seal" {
        guard let sealed = try AES.GCM.seal(data, using: encryptionKey, authenticating: aad).combined else { throw StorageFailure.unavailable }
        result = sealed
    } else { result = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: encryptionKey, authenticating: aad) }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["data": result.base64EncodedString()]))
} catch {
    FileHandle.standardError.write(Data("Secure storage unavailable".utf8))
    exit(1)
}
