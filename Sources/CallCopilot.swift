import AppKit
import Foundation

/// Call mode: captures both sides of a call, streams it to the command center (callpilot/server.mjs),
/// follows the call's state from there, and floats each checkpoint over whatever window you are in.
final class CallCopilot {
    static let port = 8768
    private(set) var serverURL: URL?
    private var server: Process?
    private var mic: CallMic?
    private var tap: SystemAudioTap?
    private var pollTimer: Timer?
    private var heartbeat: Timer?
    private(set) var capturing = false
    private(set) var lastError: String?
    private let panel = CheckpointPanel()
    var onChange: (() -> Void)?

    init() {
        panel.onDecide = { [weak self] id, act in self?.decide(id, act) }
        panel.onOpen = { [weak self] in self?.openCommandCenter() }
    }

    // MARK: server

    /// Reuse a running command center (a dev server, or one from an earlier launch), else start ours.
    func ensureServer(completion: @escaping (URL?) -> Void) {
        let candidates = [Self.advertisedURL(), URL(string: "http://127.0.0.1:\(Self.port)")].compactMap { $0 }
        probe(candidates) { [weak self] url in
            guard let self else { return }
            if let url {
                self.serverURL = url
                return completion(url)
            }
            self.spawnServer()
            self.waitForServer(URL(string: "http://127.0.0.1:\(Self.port)")!, tries: 40, completion: completion)
        }
    }

    private static func advertisedURL() -> URL? {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/yap/callpilot.json")
        guard let data = try? Data(contentsOf: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = json["url"] as? String
        else { return nil }
        return URL(string: url)
    }

    private func probe(_ urls: [URL], completion: @escaping (URL?) -> Void) {
        guard let url = urls.first else { return completion(nil) }
        var request = URLRequest(url: url.appendingPathComponent("api/state"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                DispatchQueue.main.async { completion(url) }
            } else {
                DispatchQueue.main.async { self?.probe(Array(urls.dropFirst()), completion: completion) }
            }
        }.resume()
    }

    private func waitForServer(_ url: URL, tries: Int, completion: @escaping (URL?) -> Void) {
        probe([url]) { [weak self] found in
            if let found {
                self?.serverURL = found
                completion(found)
            } else if tries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self?.waitForServer(url, tries: tries - 1, completion: completion)
                }
            } else {
                self?.lastError = "Command center did not start. Is Node installed?"
                completion(nil)
            }
        }
    }

    private func spawnServer() {
        guard server?.isRunning != true else { return }
        let fm = FileManager.default
        // Prefer the source checkout so edits apply on the next start; fall back to the bundled copy.
        var script: String?
        if let src = Bundle.main.object(forInfoDictionaryKey: "YapSourceDir") as? String {
            let path = (src as NSString).appendingPathComponent("callpilot/server.mjs")
            if fm.fileExists(atPath: path) { script = path }
        }
        if script == nil, let bundled = Bundle.main.resourceURL?.appendingPathComponent("callpilot/server.mjs").path,
           fm.fileExists(atPath: bundled) {
            script = bundled
        }
        let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first { fm.isExecutableFile(atPath: $0) }
        guard let script, let node else {
            lastError = "Command center needs Node (brew install node)"
            return
        }
        let home = fm.homeDirectoryForCurrentUser.path
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script, "--port", String(Self.port)]
        var env = ProcessInfo.processInfo.environment
        // Apps launch with a bare PATH; the brain shells out to the claude CLI.
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = env
        let logDir = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Yap")
        try? fm.createDirectory(at: logDir, withIntermediateDirectories: true)
        let log = logDir.appendingPathComponent("callpilot.log")
        fm.createFile(atPath: log.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: log) {
            process.standardOutput = handle
            process.standardError = handle
        }
        try? process.run()
        server = process
    }

    func shutdown() {
        stopCapture()
        server?.terminate()
    }

    // MARK: call lifecycle

    /// Starts watching the command center. Capture follows its state, so a call started
    /// from the web page records too.
    func startPolling() {
        ensureServer { [weak self] _ in
            guard let self else { return }
            self.pollTimer?.invalidate()
            self.pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.poll() }
            self.poll()
        }
    }

    func toggleCall() {
        ensureServer { [weak self] url in
            guard let self, let url else { self?.onChange?(); return }
            let path = self.capturing ? "api/calls/end" : "api/calls/start"
            self.post(url.appendingPathComponent(path), json: [:]) { _ in
                DispatchQueue.main.async {
                    if !self.capturing { self.openCommandCenter() }
                    self.poll()
                }
            }
        }
    }

    func openCommandCenter() {
        ensureServer { url in
            if let url { NSWorkspace.shared.open(url) }
        }
    }

    private func poll() {
        guard let url = serverURL else { return }
        var request = URLRequest(url: url.appendingPathComponent("api/state"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard error == nil, let data, let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    // Server went away (dev server stopped, say). Find or start one again.
                    self.serverURL = nil
                    self.ensureServer { _ in }
                    return
                }
                let active = state["active"] as? Bool ?? false
                if active && !self.capturing { self.startCapture() }
                if !active && self.capturing { self.stopCapture() }
                let pending = state["pending"] as? [[String: Any]] ?? []
                self.panel.show(pending: pending, running: state["running"] as? Int ?? 0, live: active)
            }
        }.resume()
    }

    private func startCapture() {
        lastError = nil
        let mic = CallMic()
        mic.chunker.onChunk = { [weak self] samples, start in
            // A "them" chunk still recording may hold the original of what the mic just heard.
            // The server waits for it before deciding whether this chunk is an echo.
            self?.upload(samples, start: start, stream: "me", themOpen: self?.tap?.chunker.openSince)
        }
        do { try mic.start(); self.mic = mic } catch { lastError = "Mic: \(error.localizedDescription)" }

        let tap = SystemAudioTap()
        tap.chunker.onChunk = { [weak self] samples, start in self?.upload(samples, start: start, stream: "them") }
        do { try tap.start(); self.tap = tap } catch { lastError = error.localizedDescription }

        capturing = true
        heartbeat?.invalidate()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.sendHeartbeat() }
        sendHeartbeat()
        onChange?()
    }

    private func stopCapture() {
        mic?.stop()
        tap?.stop()
        mic = nil
        tap = nil
        heartbeat?.invalidate()
        heartbeat = nil
        capturing = false
        panel.show(pending: [], running: 0, live: false)
        onChange?()
    }

    private func sendHeartbeat() {
        guard let url = serverURL else { return }
        var body: [String: Any] = [:]
        if let t = mic?.lastAudio, t > .distantPast { body["meAt"] = Int(t.timeIntervalSince1970 * 1000) }
        if let t = tap?.lastAudio, t > .distantPast { body["themAt"] = Int(t.timeIntervalSince1970 * 1000) }
        if let lastError { body["error"] = lastError }
        post(url.appendingPathComponent("api/capture"), json: body) { _ in }
    }

    private func upload(_ samples: [Float], start: Date, stream: String, themOpen: Date? = nil) {
        guard let url = serverURL else { return }
        var components = URLComponents(url: url.appendingPathComponent("api/audio"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "stream", value: stream),
            URLQueryItem(name: "t0", value: String(Int(start.timeIntervalSince1970 * 1000))),
            URLQueryItem(name: "dur", value: String(samples.count * 1000 / 16000)),
        ]
        if let themOpen { components.queryItems?.append(URLQueryItem(name: "themOpen", value: String(Int(themOpen.timeIntervalSince1970 * 1000)))) }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.httpBody = Wav.data(samples)
        URLSession.shared.dataTask(with: request).resume()
    }

    private func decide(_ id: String, _ act: String) {
        guard let url = serverURL else { return }
        post(url.appendingPathComponent("api/checkpoints/\(id)/\(act)"), json: [:]) { [weak self] _ in
            DispatchQueue.main.async { self?.poll() }
        }
    }

    private func post(_ url: URL, json: [String: Any], completion: @escaping (Data?) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        URLSession.shared.dataTask(with: request) { data, _, _ in completion(data) }.resume()
    }
}

/// A small always-on-top card with the latest checkpoint and two big buttons, so you can
/// answer without leaving the call window. It never takes focus.
final class CheckpointPanel {
    private let panel: NSPanel
    private let kindLabel = NSTextField(labelWithString: "")
    private let questionLabel = NSTextField(wrappingLabelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let moreLabel = NSTextField(labelWithString: "")
    private let goButton = NSButton(title: "Go", target: nil, action: nil)
    private let skipButton = NSButton(title: "Skip", target: nil, action: nil)
    private var currentID: String?
    var onDecide: ((String, String) -> Void)?
    var onOpen: (() -> Void)?

    init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 180),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView, .utilityWindow],
            backing: .buffered, defer: true
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true

        let blur = NSVisualEffectView()
        blur.material = .hudWindow
        blur.state = .active
        blur.blendingMode = .behindWindow
        panel.contentView = blur

        let accent = NSColor(srgbRed: 1.0, green: 0.54, blue: 0.12, alpha: 1)
        kindLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        kindLabel.textColor = accent
        questionLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        questionLabel.maximumNumberOfLines = 3
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 3
        moreLabel.font = .systemFont(ofSize: 11)
        moreLabel.textColor = .tertiaryLabelColor

        for (button, act) in [(goButton, "go"), (skipButton, "skip")] {
            button.bezelStyle = .rounded
            button.controlSize = .large
            button.target = self
            button.action = act == "go" ? #selector(go) : #selector(skip)
        }
        goButton.keyEquivalent = "\r"
        goButton.bezelColor = accent
        let open = NSButton(title: "Open", target: self, action: #selector(openCenter))
        open.bezelStyle = .inline
        open.controlSize = .small

        let buttons = NSStackView(views: [goButton, skipButton])
        buttons.distribution = .fillProportionally
        buttons.spacing = 8
        goButton.widthAnchor.constraint(equalTo: skipButton.widthAnchor, multiplier: 2).isActive = true

        let footer = NSStackView(views: [moreLabel, NSView(), open])
        let stack = NSStackView(views: [kindLabel, questionLabel, detailLabel, buttons, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.setCustomSpacing(12, after: detailLabel)
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 16, bottom: 12, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        blur.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: blur.trailingAnchor),
            stack.topAnchor.constraint(equalTo: blur.topAnchor),
            stack.bottomAnchor.constraint(equalTo: blur.bottomAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
            questionLabel.widthAnchor.constraint(equalToConstant: 328),
            detailLabel.widthAnchor.constraint(equalToConstant: 328),
        ])
    }

    func show(pending: [[String: Any]], running: Int, live: Bool) {
        // Newest first, same as the command center.
        guard live, let top = pending.last, let id = top["id"] as? String else {
            currentID = nil
            panel.orderOut(nil)
            return
        }
        let kind = top["kind"] as? String ?? "agent"
        let labels = ["agent": ("Agent task", "Send to agent"), "note": ("Decision to keep", "Keep it"), "human": ("Your to-do", "Add to to-dos")]
        let (label, go) = labels[kind] ?? labels["agent"]!
        kindLabel.stringValue = label.uppercased()
        questionLabel.stringValue = top["question"] as? String ?? ""
        detailLabel.stringValue = top["conclusion"] as? String ?? ""
        goButton.title = go
        var footer: [String] = []
        if pending.count > 1 { footer.append("\(pending.count - 1) more waiting") }
        if running > 0 { footer.append("\(running) agent\(running == 1 ? "" : "s") working") }
        moreLabel.stringValue = footer.joined(separator: " \u{00B7} ")

        let isNew = id != currentID
        currentID = id
        panel.layoutIfNeeded()
        if let fitting = panel.contentView?.fittingSize {
            var frame = panel.frame
            frame.size.height = fitting.height
            panel.setFrame(frame, display: true)
        }
        if !panel.isVisible, let screen = NSScreen.main {
            let v = screen.visibleFrame
            panel.setFrameTopLeftPoint(NSPoint(x: v.maxX - panel.frame.width - 16, y: v.maxY - 16))
        }
        panel.orderFrontRegardless()
        if isNew { NSSound(named: "Tink")?.play() }
    }

    @objc private func go() { decide("go") }
    @objc private func skip() { decide("skip") }
    @objc private func openCenter() { onOpen?() }

    private func decide(_ act: String) {
        guard let id = currentID else { return }
        currentID = nil
        panel.orderOut(nil)
        onDecide?(id, act)
    }
}
