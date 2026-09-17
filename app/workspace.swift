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
    private let dragOverlay = WindowDragOverlay(frame: .zero)
    private let port = Int(ProcessInfo.processInfo.environment["CLOOVIES_NATIVE_PORT"] ?? "4340") ?? 4340
    private lazy var baseURL = URL(string: "http://127.0.0.1:\(port)")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Smart punctuation changes shell commands. Disable substitutions in
        // this application's preferences, without changing system settings.
        for key in ["NSAutomaticQuoteSubstitutionEnabled", "NSAutomaticDashSubstitutionEnabled", "NSAutomaticTextReplacementEnabled", "NSAutomaticSpellingCorrectionEnabled"] {
            UserDefaults.standard.set(false, forKey: key)
        }
        NSApp.setActivationPolicy(.regular)
        let main = NSMenu()
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "Quit Cloovies", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self; web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(kind)?.isHidden = true }
        window.title = "Cloovies — Workspace"; window.minSize = NSSize(width: 720, height: 500)
        window.backgroundColor = NSColor(calibratedRed: 0.18, green: 0.184, blue: 0.22, alpha: 1)
        web.frame = window.contentView!.bounds; web.autoresizingMask = [.width, .height]; window.contentView!.addSubview(web); window.setFrameAutosaveName("ClooviesWorkspace"); window.center()
        dragOverlay.frame = web.frame; dragOverlay.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(dragOverlay)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<body style='background:#2e2f38;color:#eae5ce;font:16px monospace;padding:50px'>Opening your workspace…</body>", baseURL: nil)
        probe(attempt: 0)
    }
    private func probe(attempt: Int) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/workspace/health")); request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let valid = (response as? HTTPURLResponse)?.statusCode == 200 && data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["service"] as? String == "cloovies-workspace"
            DispatchQueue.main.async {
                if valid { self.web.load(URLRequest(url: self.baseURL)); return }
                if attempt == 0 { self.startDaemon() }
                if attempt < 40 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.probe(attempt: attempt + 1) } }
                else { self.showError("The workspace server could not start. Check ~/Library/Logs/Cloovies/workspace.log, then relaunch the app.") }
            }
        }.resume()
    }
    private func startDaemon() {
        guard let executable = Bundle.main.url(forAuxiliaryExecutable: "cloovies-workspace") else { showError("The bundled workspace server is missing."); return }
        let process = Process(); process.executableURL = executable; process.arguments = ["--port", String(port)]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + FileManager.default.homeDirectoryForCurrentUser.path + "/.local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        process.environment = environment
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Cloovies")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let log = logs.appendingPathComponent("workspace.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: log) { handle.seekToEndOfFile(); process.standardOutput = handle; process.standardError = handle }
        do { try process.run(); daemon = process } catch { showError(error.localizedDescription) }
    }
    private func showError(_ text: String) {
        let alert = NSAlert(); alert.messageText = "Cloovies could not open"; alert.informativeText = text; alert.runModal()
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
            if (!input?.matches('.message-input')) return false;
            input.dispatchEvent(new CustomEvent('workspace-paste-image', {detail: '\(base64)'}));
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
    @objc private func reload() { web.load(URLRequest(url: baseURL)) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationWillTerminate(_ notification: Notification) { if daemon?.isRunning == true { daemon?.terminate() } }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.host == baseURL.host, message.frameInfo.request.url?.port == baseURL.port else { replyHandler(nil, "Unsupported origin"); return }
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
let application = NSApplication.shared
let delegate = WorkspaceApp(); application.delegate = delegate; application.run()
