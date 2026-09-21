import Foundation
import IOKit.pwr_mgt

// Owned by the native app, independent of WebKit, display sleep and screen lock.
// This assertion prevents idle system sleep only; it never changes power settings.
final class KeepAwakeController {
    static let preferenceKey = "KeepMacAwake"
    static let reason = "Cloovies keeps agents running while the app is open"
    private let defaults: UserDefaults
    private var assertion: IOPMAssertionID?
    private(set) var error: String?
    private(set) var revision = 0
    var enabled: Bool { defaults.bool(forKey: Self.preferenceKey) }
    var active: Bool { assertion != nil }
    var state: [String: Any] {
        ["enabled": enabled, "active": active, "error": error ?? "", "revision": revision]
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [Self.preferenceKey: true])
        apply()
    }
    func setEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: Self.preferenceKey)
        apply()
    }
    private func apply() {
        revision += 1
        error = nil
        if enabled {
            guard assertion == nil else { return }
            var identifier = IOPMAssertionID(0)
            let result = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn), Self.reason as CFString, &identifier)
            if result == kIOReturnSuccess { assertion = identifier }
            else { error = "macOS could not enable Keep awake (\(result)). Try again." }
        } else { release() }
    }
    func release() {
        guard let identifier = assertion else { return }
        let result = IOPMAssertionRelease(identifier)
        if result == kIOReturnSuccess { assertion = nil }
        else { error = "macOS could not release Keep awake (\(result)). Try again or quit the app." }
    }
    deinit { release() }
}
