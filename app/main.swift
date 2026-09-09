import Cocoa
import WebKit
import Sparkle

// bitwise.app is a thin WebKit wrapper around the bundled `bitwise-daemon` binary
// (the Go single-binary in cmd/bitwise that embeds web/dist). The daemon is
// launched with --no-open so this Swift wrapper owns the window. Everything the
// .app needs lives inside Contents/ — no external dev tools, no Vite, no PATH
// dependencies beyond `git` and `claude` which the daemon checks for itself.

let kPort = 3333
let kDaemonName = "bitwise-daemon"

// Keep daemon.log bounded across launches: if it exceeds maxLines, rewrite it
// with only the last keepLines. Runs once at startup so the cost is negligible.
func trimLogIfNeeded(path: String, maxLines: Int, keepLines: Int) {
    guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return }
    let lines = contents.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.count > maxLines else { return }
    let tail = lines.suffix(keepLines).joined(separator: "\n")
    try? tail.write(toFile: path, atomically: true, encoding: .utf8)
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var daemonProcess: Process?
    // Status-bar (top-of-screen) menu — gives bitwise an at-a-glance
    // presence without forcing the user to open the dock app. Title
    // shows live agent count; submenu offers a "Show bitwise"
    // shortcut and quit. Refreshed via a timer that polls
    // /api/agents-summary on the daemon.
    var statusItem: NSStatusItem?
    var statusSummaryItem: NSMenuItem?
    var statusBreakdownItem: NSMenuItem?
    var statusTimer: Timer?

    // Dev builds carry the "0.0.0" placeholder from packaging/macos/Info.plist
    // because no VERSION was passed to `make build-app`. Only `make release
    // VERSION=vX.Y.Z` stamps a real version in. A 0.0.0 build is a developer's
    // local rebuild — NEVER auto-update it: every release on the feed looks
    // newer than 0.0.0, so Sparkle would prompt to "update" the dev build,
    // replace it with the last shipped release, and the next `make build-app`
    // would clobber that back to 0.0.0, looping forever.
    static let isDevBuild: Bool = {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return v == nil || v == "0.0.0"
    }()

    // Sparkle auto-updater. On release builds `startingUpdater: true` schedules
    // background checks (governed by SUEnableAutomaticChecks) and the "Check
    // for Updates…" menu item drives a manual check. On dev builds we don't
    // start it (see isDevBuild above). Updates are verified against
    // SUPublicEDKey — no Apple Developer account / notarization needed.
    let updaterController = SPUStandardUpdaterController(
        startingUpdater: !AppDelegate.isDevBuild, updaterDelegate: nil, userDriverDelegate: nil)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        // Dock icon from the bundle's Resources dir.
        if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let img = NSImage(contentsOf: url) {
            NSApp.applicationIconImage = img
        }

        // Menu bar
        let menuBar = NSMenu()
        let appMenu = NSMenu()
        // Only release builds offer "Check for Updates…" — dev builds have no
        // real version to compare against (see isDevBuild).
        if !AppDelegate.isDevBuild {
            let checkForUpdatesItem = NSMenuItem(
                title: "Check for Updates…",
                action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)),
                keyEquivalent: "")
            checkForUpdatesItem.target = updaterController
            appMenu.addItem(checkForUpdatesItem)
            appMenu.addItem(NSMenuItem.separator())
        }
        appMenu.addItem(withTitle: "Quit bitwise", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appMenuItem = NSMenuItem()
        appMenuItem.submenu = appMenu
        menuBar.addItem(appMenuItem)

        // Edit menu — forward to WKWebView's responder chain
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(handleCut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(handleCopy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(handlePaste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(handleSelectAll(_:)), keyEquivalent: "a")
        let editMenuItem = NSMenuItem()
        editMenuItem.submenu = editMenu
        menuBar.addItem(editMenuItem)

        NSApp.mainMenu = menuBar

        startDaemon()
        setupStatusItem()

        DispatchQueue.global().async {
            self.waitForServer("http://localhost:\(kPort)/", timeout: 20)
            DispatchQueue.main.async {
                self.showWindow()
                self.startStatusPolling()
            }
        }
    }

    // ----- Status bar menu (top-of-screen "menu bar app" feel) ---------------

    func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            // Title is updated by `refreshStatusItem` once the daemon
            // is up; show a placeholder before the first poll.
            button.title = "bitwise"
            button.toolTip = "bitwise — agent dashboard"
        }

        let menu = NSMenu()

        // Live counts. Disabled (action == nil) so it reads as a
        // status row, not a clickable command.
        let summary = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
        summary.isEnabled = false
        menu.addItem(summary)
        statusSummaryItem = summary

        let breakdown = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
        breakdown.isEnabled = false
        menu.addItem(breakdown)
        statusBreakdownItem = breakdown

        menu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "Show bitwise", action: #selector(showWindowFromStatusBar), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettingsFromStatusBar), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit bitwise", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quitItem)

        item.menu = menu
        statusItem = item
    }

    func startStatusPolling() {
        // Initial refresh, then a timer every 3s. Poll is cheap
        // (a single GET that returns 4 ints) so 3s gives a "live"
        // feel without burning cycles.
        refreshStatusItem()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshStatusItem()
        }
    }

    func refreshStatusItem() {
        guard let url = URL(string: "http://localhost:\(kPort)/api/agents-summary") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self = self,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Int]
            else { return }
            DispatchQueue.main.async {
                self.applySummary(json)
            }
        }.resume()
    }

    func applySummary(_ s: [String: Int]) {
        let active = s["active"] ?? 0
        let idle = s["idle"] ?? 0
        let awaiting = s["awaiting"] ?? 0
        let total = s["total"] ?? 0

        // Status-bar title — keep terse so it doesn't eat menu-bar
        // real estate. Show active count + a marker when something
        // is waiting on the user (gold-equivalent attention dot).
        // Examples: "bitwise 3" (3 active), "bitwise 3 ⚠" (one
        // awaiting input), "bitwise" (idle).
        var title = "bitwise"
        if active > 0 { title = "bitwise \(active)" }
        if awaiting > 0 { title += " ⚠" }
        statusItem?.button?.title = title

        // Submenu rows: human-readable summary lines.
        if total == 0 {
            statusSummaryItem?.title = "no agents running"
            statusBreakdownItem?.isHidden = true
        } else {
            statusSummaryItem?.title = "\(total) agent\(total == 1 ? "" : "s")"
            var parts: [String] = []
            if active > 0 { parts.append("\(active) active") }
            if idle > 0 { parts.append("\(idle) idle") }
            if awaiting > 0 { parts.append("\(awaiting) awaiting input") }
            statusBreakdownItem?.title = parts.joined(separator: " · ")
            statusBreakdownItem?.isHidden = parts.isEmpty
        }
    }

    @objc func showWindowFromStatusBar() {
        if window == nil {
            showWindow()
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc func openSettingsFromStatusBar() {
        // Bring the window forward first so the modal lands somewhere
        // visible (a status-bar click can be on a different desktop /
        // space than the bitwise window).
        showWindowFromStatusBar()
        // Click the settings button. Lets us reuse the web side's
        // existing open-settings code path — including the live
        // state values it reads on each open — without exposing a
        // separate Swift→JS API for it. Wrapped in a small retry so
        // it works even before the page has fully loaded.
        let js = """
        (function tryOpen(attempts) {
            var btn = document.getElementById('settings-btn');
            if (btn) { btn.click(); return; }
            if (attempts > 0) setTimeout(function() { tryOpen(attempts - 1); }, 150);
        })(20);
        """
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    func showWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "bitwise"
        window.center()
        window.contentView = webView
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0x2e/255, green: 0x2f/255, blue: 0x38/255, alpha: 1)
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)

        let url = URL(string: "http://localhost:\(kPort)/")!
        webView.load(URLRequest(url: url))
    }

    func startDaemon() {
        // The bundled daemon lives next to the wrapper binary in Contents/MacOS/.
        let wrapperURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let daemonURL = wrapperURL.deletingLastPathComponent().appendingPathComponent(kDaemonName)
        guard FileManager.default.fileExists(atPath: daemonURL.path) else {
            NSLog("bundled daemon missing at \(daemonURL.path) — was the .app built with `make build-app`?")
            return
        }

        // Reap any stale instance from a previous run.
        let killTask = Process()
        killTask.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        killTask.arguments = ["-f", kDaemonName]
        try? killTask.run()
        killTask.waitUntilExit()
        usleep(300_000)

        let process = Process()
        process.executableURL = daemonURL
        process.arguments = ["--no-open", "--port", "\(kPort)"]

        // Capture daemon output to a log file under ~/Library/Logs/bitwise so
        // GUI-launched failures (which have no terminal) are still debuggable.
        let logsDir = ("~/Library/Logs/bitwise" as NSString).expandingTildeInPath
        try? FileManager.default.createDirectory(atPath: logsDir, withIntermediateDirectories: true)
        let logPath = "\(logsDir)/daemon.log"
        trimLogIfNeeded(path: logPath, maxLines: 3000, keepLines: 1500)
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        if let logHandle = FileHandle(forWritingAtPath: logPath) {
            logHandle.seekToEndOfFile()
            process.standardOutput = logHandle
            process.standardError = logHandle
        }

        do {
            try process.run()
            daemonProcess = process
        } catch {
            NSLog("failed to start bundled daemon: \(error)")
        }
    }

    @objc func handleSelectAll(_ sender: Any?) {
        webView.evaluateJavaScript("""
        (function() {
            var el = document.activeElement;
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
                el.select();
            } else {
                document.execCommand('selectAll');
            }
        })();
        """, completionHandler: nil)
    }

    @objc func handleCopy(_ sender: Any?) {
        webView.evaluateJavaScript("""
        (function() {
            var el = document.activeElement;
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.selectionStart !== el.selectionEnd) {
                var text = el.value.substring(el.selectionStart, el.selectionEnd);
                window.webkit.messageHandlers.clipboard && window.webkit.messageHandlers.clipboard.postMessage(text);
                return text;
            }
            return window.getSelection().toString();
        })();
        """) { result, _ in
            if let text = result as? String, !text.isEmpty {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }

    @objc func handleCut(_ sender: Any?) {
        webView.evaluateJavaScript("""
        (function() {
            var el = document.activeElement;
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.selectionStart !== el.selectionEnd) {
                var start = el.selectionStart;
                var end = el.selectionEnd;
                var text = el.value.substring(start, end);
                el.value = el.value.substring(0, start) + el.value.substring(end);
                el.selectionStart = el.selectionEnd = start;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return text;
            }
            return '';
        })();
        """) { result, _ in
            if let text = result as? String, !text.isEmpty {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }

    @objc func handlePaste(_ sender: Any?) {
        let pb = NSPasteboard.general

        // Image paste — send base64 to JS
        if let imageData = pb.data(forType: .png) ?? pb.data(forType: .tiff) {
            let pngData: Data
            if pb.data(forType: .png) != nil {
                pngData = imageData
            } else if let imageRep = NSBitmapImageRep(data: imageData),
                      let converted = imageRep.representation(using: .png, properties: [:]) {
                pngData = converted
            } else {
                return
            }
            let base64 = pngData.base64EncodedString()
            let js = "if (window.onClipboardImage) { window.onClipboardImage(`\(base64)`); }"
            webView.evaluateJavaScript(js, completionHandler: nil)
            return
        }

        // Text paste — inject into focused textarea/input via JS
        if let text = pb.string(forType: .string) {
            if let jsonData = try? JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                let js = """
                (function() {
                    var el = document.activeElement;
                    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) {
                        var start = el.selectionStart || 0;
                        var end = el.selectionEnd || 0;
                        var text = \(jsonString);
                        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                            el.value = el.value.substring(0, start) + text + el.value.substring(end);
                            el.selectionStart = el.selectionEnd = start + text.length;
                        } else {
                            document.execCommand('insertText', false, text);
                        }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })();
                """
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    func waitForServer(_ urlString: String, timeout: Int) {
        let url = URL(string: urlString)!
        for _ in 0..<(timeout * 2) {
            if let _ = try? Data(contentsOf: url) {
                return
            }
            usleep(500_000)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        statusTimer?.invalidate()
        statusTimer = nil
        daemonProcess?.terminate()
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kill.arguments = ["-f", kDaemonName]
        try? kill.run()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
