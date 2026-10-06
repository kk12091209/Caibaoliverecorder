import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const run = promisify(execFile);
const backend = fileURLToPath(new URL('../desktop-macos/Backend.swift', import.meta.url));

test('Mac startup detects incomplete interface files without removing existing data', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  // Swift's driver can trap when TMPDIR contains non-ASCII characters.
  const root = await fs.mkdtemp('/private/tmp/caibo-startup-test-');
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const source = path.join(root, 'Checks.swift');
    await fs.writeFile(source, String.raw`
import Foundation
@main struct Checks {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let resources = root.appendingPathComponent("resources")
        let editor = resources.appendingPathComponent("live-editor")
        let dist = editor.appendingPathComponent("dist")
        let assets = dist.appendingPathComponent("assets")
        let data = root.appendingPathComponent("data")
        let fm = FileManager.default
        for directory in [editor.appendingPathComponent("server"), assets, data] { try fm.createDirectory(at: directory, withIntermediateDirectories: true) }
        try Data("{}".utf8).write(to: editor.appendingPathComponent("package.json"))
        try Data("// fixture".utf8).write(to: editor.appendingPathComponent("server/index.js"))
        let sentinel = data.appendingPathComponent("existing-recording.flv")
        let recording = Data("existing-user-recording".utf8)
        try recording.write(to: sentinel)
        let service = Backend(resources: resources, data: data, exports: root.appendingPathComponent("exports"))
        try service.prepare()
        let html = "<div id=\"app\"></div><script type=\"module\" src=\"/assets/app.js\"></script><link href=\"/assets/app.css\" rel=\"stylesheet\">"
        func reset() throws {
            try Data(html.utf8).write(to: dist.appendingPathComponent("index.html"))
            try Data("document.getElementById('app').textContent='ready'".utf8).write(to: assets.appendingPathComponent("app.js"))
            try Data("body { margin: 0 }".utf8).write(to: assets.appendingPathComponent("app.css"))
        }
        func rejects(_ name: String, _ change: () throws -> Void) throws {
            try reset(); try change()
            var rejected = false
            do { try service.validateInterface() }
            catch { rejected = error is MissingComponent }
            guard rejected else { throw problem("未检测到故障：" + name) }
            guard try Data(contentsOf: sentinel) == recording else { throw problem("检查界面时改变了用户录像") }
            print("PASS " + name)
        }
        try reset(); try service.validateInterface(); print("PASS complete interface")
        try rejects("missing entry") { try fm.removeItem(at: dist.appendingPathComponent("index.html")) }
        try rejects("missing script") { try fm.removeItem(at: assets.appendingPathComponent("app.js")) }
        try rejects("missing stylesheet") { try fm.removeItem(at: assets.appendingPathComponent("app.css")) }
        try rejects("empty script") { try Data().write(to: assets.appendingPathComponent("app.js")) }
        try rejects("invalid HTML") { try Data([0xff]).write(to: dist.appendingPathComponent("index.html")) }
        try rejects("missing mount point") { try Data("<script src=\"/assets/app.js\"></script>".utf8).write(to: dist.appendingPathComponent("index.html")) }
        try rejects("encoded path traversal") { try Data(html.replacingOccurrences(of: "/assets/app.js", with: "/assets/%2e%2e/package.json").utf8).write(to: dist.appendingPathComponent("index.html")) }
        try reset(); try service.validateInterface(); print("PASS repaired interface")
        let endpoint: [String: Any] = ["protocol": 1, "instance": String(repeating: "a", count: 32), "token": String(repeating: "b", count: 64), "pid": Int(ProcessInfo.processInfo.processIdentifier), "origin": CommandLine.arguments[2], "dataPath": data.path, "build": "old-build"]
        try JSONSerialization.data(withJSONObject: endpoint).write(to: data.appendingPathComponent("desktop-service.json"))
        let start = Date()
        var timedOut = false
        do { _ = try await service.ensure(timeout: 0.3) }
        catch { timedOut = error.localizedDescription.contains("后台启动超时") }
        guard timedOut, Date().timeIntervalSince(start) < 2, !service.connecting else { throw problem("无响应的旧连接没有按总时限结束") }
        guard try Data(contentsOf: sentinel) == recording else { throw problem("连接恢复改变了用户录像") }
        print("PASS stalled old endpoint respects total timeout")
    }
}
`);
    const executable = path.join(root, 'checks');
    const env = { ...process.env, TMPDIR: '/private/tmp', TMP: '/private/tmp', TEMP: '/private/tmp' };
    await run('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', path.join(root, 'modules'), fileURLToPath(new URL('../desktop-macos/ProcessOwnership.swift', import.meta.url)), backend, source, '-o', executable], { env, timeout: 45000 });
    const { stdout } = await run(executable, [root, `http://127.0.0.1:${server.address().port}`], { env, timeout: 10000 });
    assert.equal(stdout.match(/^PASS /gm)?.length, 10, stdout);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
