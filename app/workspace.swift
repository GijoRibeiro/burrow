import Cocoa
import WebKit

// The native shell owns a local HTTP process. tmux owns terminal processes,
// so quitting this app does not stop the user's shells.
final class WorkspaceApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var web: WKWebView!
    private var daemon: Process?
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
        let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let copy = NSMenuItem(title: "Copy", action: #selector(copyText), keyEquivalent: "c"); copy.target = self; edit.insertItem(copy, at: 2)
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
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self; web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Cloovies — Workspace"; window.minSize = NSSize(width: 720, height: 500)
        window.backgroundColor = NSColor(calibratedRed: 0.18, green: 0.184, blue: 0.22, alpha: 1)
        web.frame = window.contentView!.bounds; web.autoresizingMask = [.width, .height]; window.contentView!.addSubview(web); window.setFrameAutosaveName("ClooviesWorkspace"); window.center()
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<body style='background:#2e2f38;color:#eae5ce;font:16px monospace;padding:50px'>Opening your workspace…</body>", baseURL: nil)
        probe(attempt: 0)
    }
    private func probe(attempt: Int) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/workspace")); request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let valid = (response as? HTTPURLResponse)?.statusCode == 200 && data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["terminals"] != nil
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
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.host == baseURL.host else { replyHandler(nil, "Unsupported origin"); return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false; panel.prompt = "Choose project"
        panel.beginSheetModal(for: window) { response in replyHandler(response == .OK ? panel.url?.path : nil, nil) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.host == baseURL.host && url.port == baseURL.port) { decisionHandler(.allow) }
        else { if navigationAction.navigationType == .linkActivated && ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
}
let application = NSApplication.shared
let delegate = WorkspaceApp(); application.delegate = delegate; application.run()
