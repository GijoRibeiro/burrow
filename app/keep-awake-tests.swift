import Foundation

@main
struct KeepAwakeTests {
    static func main() {
        let suite = "com.cloovies.keep-awake-test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        func assertions() -> String {
            let process = Process(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
            process.arguments = ["-g", "assertions"]
            process.standardOutput = output
            try! process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return String(decoding: data, as: UTF8.self)
                .split(separator: "\n").filter {
                    $0.contains("pid \(ProcessInfo.processInfo.processIdentifier)(") && $0.contains(KeepAwakeController.reason)
                }.joined(separator: "\n")
        }
        var controller: KeepAwakeController? = KeepAwakeController(defaults: defaults)
        assert(controller!.enabled && controller!.active, controller!.error ?? "Default should be on")
        assert(assertions().contains("PreventUserIdleSystemSleep"))
        assert(!assertions().contains("PreventUserIdleDisplaySleep"))
        let initial = assertions()
        controller!.setEnabled(true)
        assert(assertions().split(separator: "\n").count == 1, "Repeated enable leaked an assertion: \(initial)")
        controller!.setEnabled(false)
        assert(!controller!.enabled && !controller!.active && assertions().isEmpty)
        controller = nil
        controller = KeepAwakeController(defaults: defaults)
        assert(!controller!.enabled && !controller!.active, "Off preference was not remembered")
        controller!.setEnabled(true)
        assert(controller!.active && !assertions().isEmpty)
        controller!.release()
        assert(controller!.enabled && !controller!.active && assertions().isEmpty, "Quit must release without changing preference")
        controller = KeepAwakeController(defaults: defaults)
        assert(controller!.active, "On preference was not remembered")
        controller = nil
        assert(assertions().isEmpty, "Controller leaked its assertion")
        print("Keep awake: native assertion, default, persistence, repeated toggles and cleanup passed")
    }
}
