import Cocoa
import WebKit

// Native mouse handling keeps dragging synchronous with the original mouse-down.
// Only the UI's reported empty toolbar/wordmark areas intercept events.
final class WindowDragOverlay: NSView {
    var regions: [NSRect] = []
    var controls: [NSRect] = []
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return regions.contains(where: { $0.contains(local) }) && !controls.contains(where: { $0.contains(local) }) ? self : nil
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

// The native shell owns a local HTTP process. tmux owns terminal processes,
// so quitting this app does not stop the user's shells.
final class WorkspaceApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var web: WKWebView!
    private var daemon: Process?
    private let keepAwake = KeepAwakeController()
    private var keepAwakeMenu: NSMenuItem!
    private let dragOverlay = WindowDragOverlay(frame: .zero)
    private let port = Int(ProcessInfo.processInfo.environment["CLOOVIES_NATIVE_PORT"] ?? "4340") ?? 4340
    private lazy var baseURL = URL(string: "http://127.0.0.1:\(port)")!
    private let logDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Cloovies")
    private lazy var logURL = logDirectory.appendingPathComponent("workspace.log")
    private let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    private var daemonVersion = ""
    // Supervision state: the daemon is restarted after a crash, never after Quit,
    // and a stale daemon from an older install is replaced at most once per launch.
    private var terminating = false
    private var uiLoaded = false
    private var startupFailed = false
    private var replacedStaleDaemon = false
    private var restartTimes: [Date] = []
    private var reconnectGeneration = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Smart punctuation changes shell commands. Disable substitutions in
        // this application's preferences, without changing system settings.
        for key in ["NSAutomaticQuoteSubstitutionEnabled", "NSAutomaticDashSubstitutionEnabled", "NSAutomaticTextReplacementEnabled", "NSAutomaticSpellingCorrectionEnabled"] {
            UserDefaults.standard.set(false, forKey: key)
        }
        NSApp.setActivationPolicy(.regular)
        let main = NSMenu()
        let appMenu = NSMenu()
        let about = NSMenuItem(title: "About Cloovies", action: #selector(showAbout), keyEquivalent: ""); about.target = self
        appMenu.addItem(about); appMenu.addItem(.separator())
        let settings = NSMenuItem(title: "Settings…", action: #selector(workspaceCommand(_:)), keyEquivalent: ",")
        settings.target = self; settings.representedObject = "settings"
        appMenu.addItem(settings); appMenu.addItem(.separator())
        keepAwakeMenu = NSMenuItem(title: "Keep Mac Awake", action: #selector(toggleKeepAwake), keyEquivalent: "")
        keepAwakeMenu.target = self
        keepAwakeMenu.toolTip = "Keep agents running while the screen is locked. Ends when you quit; closing the lid or choosing Sleep can still suspend the Mac."
        keepAwakeMenu.state = keepAwake.active ? .on : .off
        appMenu.addItem(keepAwakeMenu)
        let logs = NSMenuItem(title: "Reveal Logs", action: #selector(revealLogs), keyEquivalent: ""); logs.target = self
        appMenu.addItem(logs); appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Cloovies", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)
        let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let copy = NSMenuItem(title: "Copy", action: #selector(copyText), keyEquivalent: "c"); copy.target = self; edit.insertItem(copy, at: 2)
        let paste = NSMenuItem(title: "Paste", action: #selector(pasteContent(_:)), keyEquivalent: "v"); paste.target = self; edit.insertItem(paste, at: 3)
        let editItem = NSMenuItem(); editItem.submenu = edit; main.addItem(editItem)
        let view = NSMenu(title: "View")
        for (title, command, key) in [("Increase Text Size", "increase", "="), ("Decrease Text Size", "decrease", "-"), ("Reset Text Size", "reset", "0"), ("Choose Terminals", "choose", "k"), ("Toggle Sidebar", "sidebar", "b"), ("Focus Pane", "zoom", "\r"), ("New Terminal", "new", "N"), ("Keyboard Shortcuts", "help", "?")] {
            let item = NSMenuItem(title: title, action: #selector(workspaceCommand(_:)), keyEquivalent: key)
            item.target = self; item.representedObject = command; view.addItem(item)
        }
        // Accept both Command+= and Command+Shift+= for larger text.
        let plus = NSMenuItem(title: "Increase Text Size", action: #selector(workspaceCommand(_:)), keyEquivalent: "+")
        plus.target = self; plus.representedObject = "increase"; plus.isHidden = true; plus.allowsKeyEquivalentWhenHidden = true; view.addItem(plus)
        view.addItem(NSMenuItem.separator())
        view.addItem(withTitle: "Reload workspace", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        let viewItem = NSMenuItem(); viewItem.submenu = view; main.addItem(viewItem); NSApp.mainMenu = main

        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "chooseFolder")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "windowDrag")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "installTools")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "keepAwake")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self; web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        // Web Inspector only on request: CLOOVIES_INSPECT=1 or `defaults write com.cloovies.workspace WebInspector -bool true`.
        if #available(macOS 13.3, *) { web.isInspectable = ProcessInfo.processInfo.environment["CLOOVIES_INSPECT"] == "1" || UserDefaults.standard.bool(forKey: "WebInspector") }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(kind)?.isHidden = true }
        window.title = "Cloovies — Workspace"; window.minSize = NSSize(width: 720, height: 500)
        window.backgroundColor = NSColor(calibratedRed: 0.18, green: 0.184, blue: 0.22, alpha: 1)
        // The delegate keeps using this window after Close; releasing it on close would crash the Dock reopen.
        window.isReleasedWhenClosed = false
        web.frame = window.contentView!.bounds; web.autoresizingMask = [.width, .height]; window.contentView!.addSubview(web)
        window.setFrameAutosaveName("ClooviesWorkspace")
        if !window.setFrameUsingName("ClooviesWorkspace") { window.center() }
        dragOverlay.frame = web.frame; dragOverlay.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(dragOverlay)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        rotateLog()
        showPlaceholder("Opening your workspace…")
        probe(attempt: 0)
    }
    private func showPlaceholder(_ text: String) {
        web.loadHTMLString("<body style='background:#2e2f38;color:#eae5ce;font:16px monospace;padding:50px'>\(text)</body>", baseURL: nil)
    }
    // Calls back on the main queue with the health body when a workspace server answers on our port.
    private func health(_ completion: @escaping ([String: Any]?) -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/workspace/health")); request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let valid = (response as? HTTPURLResponse)?.statusCode == 200 && body?["service"] as? String == "cloovies-workspace"
            DispatchQueue.main.async { completion(valid ? body : nil) }
        }.resume()
    }
    private func probe(attempt: Int) {
        health { body in
            guard !self.startupFailed else { return }
            if let body {
                self.daemonVersion = body["version"] as? String ?? "dev"
                // A daemon we did not start that reports another version (or an unversioned dev build)
                // is left over from an older install: replace it once, then keep probing.
                if self.daemon == nil && !self.replacedStaleDaemon && (self.daemonVersion != self.appVersion || self.daemonVersion == "dev") {
                    self.replacedStaleDaemon = true; self.replaceStaleDaemon(); return
                }
                self.uiLoaded = true; self.web.load(URLRequest(url: self.baseURL)); return
            }
            if attempt == 0 { self.startDaemon() }
            if attempt < 40 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.probe(attempt: attempt + 1) } }
            else { self.showError("The workspace server did not answer on port \(self.port) within 10 seconds. Recent log lines from \(self.logURL.path):\n\n\(self.logTail())") }
        }
    }
    private func replaceStaleDaemon() {
        let stale = daemonVersion
        var request = URLRequest(url: baseURL.appendingPathComponent("api/workspace/shutdown")); request.timeoutInterval = 2
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = Data("{}".utf8)
        URLSession.shared.dataTask(with: request) { _, _, _ in DispatchQueue.main.async { self.awaitShutdown(of: stale, attempt: 0) } }.resume()
    }
    private func awaitShutdown(of stale: String, attempt: Int) {
        health { body in
            if body == nil { self.startDaemon(); self.probe(attempt: 1); return }
            if attempt < 20 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.awaitShutdown(of: stale, attempt: attempt + 1) } }
            else { self.showError("A workspace server from another Cloovies version (\(stale)) is still using port \(self.port) and did not stop. Quit it — for example `lsof -nP -iTCP:\(self.port) | grep LISTEN` shows its process — then relaunch Cloovies.\n\nLog: \(self.logURL.path)") }
        }
    }
    private func startDaemon() {
        guard let executable = Bundle.main.url(forAuxiliaryExecutable: "cloovies-workspace") else { showError("The bundled workspace server is missing."); return }
        let process = Process(); process.executableURL = executable; process.arguments = ["--port", String(port)]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + FileManager.default.homeDirectoryForCurrentUser.path + "/.local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        // The daemon exits by itself when this process disappears, so a crash of the app never orphans it.
        environment["CLOOVIES_PARENT_PID"] = String(getpid())
        process.environment = environment
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: logURL) { handle.seekToEndOfFile(); process.standardOutput = handle; process.standardError = handle }
        process.terminationHandler = { [weak self] process in DispatchQueue.main.async { self?.daemonExited(process) } }
        do { try process.run(); daemon = process } catch { showError(error.localizedDescription) }
    }
    private func daemonExited(_ process: Process) {
        guard process === daemon, !terminating else { return }
        daemon = nil
        let status = process.terminationStatus
        guard uiLoaded else {
            // Startup failure, usually a port already in use: surface the log right away instead of after the probe timeout.
            startupFailed = true
            showError("The workspace server stopped (exit status \(status)) before the workspace opened. Recent log lines from \(logURL.path):\n\n\(logTail())")
            return
        }
        let now = Date(); restartTimes = restartTimes.filter { now.timeIntervalSince($0) < 120 }
        guard restartTimes.count < 3 else { showCrashLoopAlert(status: status); return }
        restartTimes.append(now)
        showPlaceholder("The workspace server stopped (exit status \(status)). Restarting…")
        reconnectGeneration += 1; let generation = reconnectGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.startDaemon(); self.reconnect(generation: generation, attempt: 0) }
    }
    private func reconnect(generation: Int, attempt: Int) {
        health { body in
            guard generation == self.reconnectGeneration, !self.terminating else { return }
            if let body { self.daemonVersion = body["version"] as? String ?? "dev"; self.web.load(URLRequest(url: self.baseURL)); return }
            if attempt < 40 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.reconnect(generation: generation, attempt: attempt + 1) } }
            else if self.daemon != nil { self.showCrashLoopAlert(status: nil) }
        }
    }
    private func showCrashLoopAlert(status: Int32?) {
        let alert = NSAlert(); alert.messageText = "The workspace server keeps stopping"
        let reason = status.map { "it stopped again (exit status \($0))" } ?? "it did not answer on port \(port)"
        alert.informativeText = "Cloovies restarted its local server three times in the last two minutes and \(reason). Your terminals keep running in tmux. Check the log for the cause, then relaunch the app.\n\n\(logURL.path)"
        alert.addButton(withTitle: "Reveal log in Finder"); alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn { revealLogs(); showPlaceholder("The workspace server stopped. Relaunch Cloovies to continue.") }
        else { NSApp.terminate(nil) }
    }
    private func rotateLog() {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path))?[.size] as? UInt64, size > 5 * 1024 * 1024 else { return }
        let previous = logURL.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: previous); try? FileManager.default.moveItem(at: logURL, to: previous)
    }
    private func logTail(lines count: Int = 15) -> String {
        guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "(no log yet)" }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).suffix(count)
        return lines.isEmpty ? "(log is empty)" : lines.joined(separator: "\n")
    }
    private func showError(_ text: String) {
        let alert = NSAlert(); alert.messageText = "Cloovies could not open"; alert.informativeText = text; alert.runModal()
    }
    @objc private func revealLogs() {
        let target = FileManager.default.fileExists(atPath: logURL.path) ? logURL : logDirectory
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }
    @objc private func showAbout() {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
        health { body in
            let server = body.map { $0["version"] as? String ?? "dev" } ?? "not running"
            let alert = NSAlert(); alert.messageText = "Cloovies \(self.appVersion) (\(build))"
            alert.informativeText = "Workspace server: \(server)\nPort: \(self.port)\nLog: \(self.logURL.path)"
            alert.runModal()
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // A newer navigation can cancel the loading page or an earlier reload.
        // WebKit reports that normal replacement as NSURLErrorCancelled.
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) else { return }
        showError(error.localizedDescription)
    }
    @objc private func pasteContent(_ sender: Any?) {
        let clipboard = NSPasteboard.general
        let png: Data?
        if let data = clipboard.data(forType: .png) {
            png = data
        } else if let data = clipboard.data(forType: .tiff), let bitmap = NSBitmapImageRep(data: data) {
            png = bitmap.representation(using: .png, properties: [:])
        } else {
            png = nil
        }
        guard let png else {
            NSApp.sendAction(Selector(("paste:")), to: nil, from: sender)
            return
        }
        // Let WebKit retain normal text/terminal paste everywhere except our composer.
        let base64 = png.base64EncodedString()
        web.evaluateJavaScript("""
        (() => {
            const input = document.activeElement;
            if (!input?.matches('.message-input, .xterm-helper-textarea')) return false;
            input.dispatchEvent(new CustomEvent('workspace-paste-image', {detail: '\(base64)', bubbles: true}));
            return true;
        })()
        """) { handled, _ in
            if handled as? Bool != true {
                NSApp.sendAction(Selector(("paste:")), to: nil, from: sender)
            }
        }
    }
    @objc private func copyText() {
        web.evaluateJavaScript("window.clooviesSelectedText?.() || ''") { value, _ in
            if let text = value as? String, !text.isEmpty {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
            } else { self.web.perform(#selector(NSText.copy(_:)), with: nil) }
        }
    }
    @objc private func workspaceCommand(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? String else { return }
        web.callAsyncJavaScript("window.clooviesCommand?.(command)", arguments: ["command": command], in: nil, in: .page, completionHandler: nil)
    }
    private func publishKeepAwake() {
        keepAwakeMenu.state = keepAwake.active ? .on : .off
        web?.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('workspace-keep-awake', {detail: state}))", arguments: ["state": keepAwake.state], in: nil, in: .page, completionHandler: nil)
    }
    @objc private func toggleKeepAwake() {
        keepAwake.setEnabled(!keepAwake.active)
        publishKeepAwake()
        if let error = keepAwake.error {
            let alert = NSAlert(); alert.messageText = "Keep awake"; alert.informativeText = error
            alert.beginSheetModal(for: window)
        }
    }
    @objc private func reload() { web.load(URLRequest(url: baseURL)) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    // tmux keeps the user's shells; only the HTTP daemon stops with the app.
    func applicationWillTerminate(_ notification: Notification) { terminating = true; keepAwake.release(); if daemon?.isRunning == true { daemon?.terminate() } }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.host == baseURL.host, message.frameInfo.request.url?.port == baseURL.port else { replyHandler(nil, "Unsupported origin"); return }
        if message.name == "keepAwake" {
            guard let body = message.body as? [String: Any], let action = body["action"] as? String else { replyHandler(nil, "Invalid Keep awake request"); return }
            if action == "set", let enabled = body["enabled"] as? Bool {
                keepAwake.setEnabled(enabled); publishKeepAwake()
            } else if action != "get" { replyHandler(nil, "Invalid Keep awake action"); return }
            replyHandler(keepAwake.state, nil); return
        }
        if message.name == "windowDrag" {
            guard let body = message.body as? [String: Any] else { replyHandler(nil, "Invalid drag regions"); return }
            func rectangles(_ key: String) -> [NSRect] {
                (body[key] as? [[String: Double]] ?? []).compactMap { value in
                    guard let x = value["x"], let y = value["y"], let width = value["width"], let height = value["height"] else { return nil }
                    return NSRect(x: x, y: y, width: width, height: height)
                }
            }
            dragOverlay.regions = rectangles("regions"); dragOverlay.controls = rectangles("controls")
            replyHandler(nil, nil); return
        }
        if message.name == "installTools" {
            guard let tool = message.body as? String, ["required", "claude", "codex", "github"].contains(tool), let script = Bundle.main.url(forResource: "install", withExtension: "command", subdirectory: "Setup") else { replyHandler(nil, "Unknown setup option"); return }
            // A .command file opens its own Terminal session without Apple Events permission.
            let shellCommand = "/bin/bash '" + script.path.replacingOccurrences(of: "'", with: "'\"'\"'") + "' " + tool
            let wrapper = FileManager.default.temporaryDirectory.appendingPathComponent("cloovies-setup-" + UUID().uuidString + ".command")
            do {
                try ("#!/bin/bash\nrm -- \"$0\"\nexec " + shellCommand + "\n").write(to: wrapper, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: wrapper.path)
                if NSWorkspace.shared.open(wrapper) { replyHandler("Installer opened in Terminal", nil) }
                else { try? FileManager.default.removeItem(at: wrapper); replyHandler(nil, "Could not open Terminal for setup") }
            } catch { replyHandler(nil, error.localizedDescription) }
            return
        }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false; panel.prompt = "Choose project"
        panel.beginSheetModal(for: window) { response in replyHandler(response == .OK ? panel.url?.path : nil, nil) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // WebKit can report target=_blank / noopener links as .other.
        // Handle new-window HTTP links here before the navigation is cancelled.
        if ["http", "https"].contains(url.scheme ?? "") && (navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else if url.scheme == "about" || (url.host == baseURL.host && url.port == baseURL.port) {
            decisionHandler(.allow)
        } else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

}
@main
struct WorkspaceMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = WorkspaceApp()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
