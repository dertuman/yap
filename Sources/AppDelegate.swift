import AppKit
import AVFoundation
import ApplicationServices

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let recorder = Recorder()
    private let transcriber = Transcriber()
    private let paster = Paster()
    private var hotKey: HotKey?
    private var statusItem: NSStatusItem!
    private var hintItem: NSMenuItem!
    private var soundsItem: NSMenuItem!
    private var triggerItems: [NSMenuItem] = []
    private var accessItem: NSMenuItem!
    private var historyMenu: NSMenu!
    private var statsMenu: NSMenu!
    private let stats = Stats.shared
    private var player: NSSound?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        setIcon("mic")
        statusItem.menu = buildMenu()
        refreshMenu()

        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        promptForTriggerAccess()

        transcriber.startServer()
        installHotKey()
    }

    /// The trigger needs Input Monitoring. Pasting the result needs Accessibility.
    private func promptForTriggerAccess() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
        if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
        if !CGPreflightPostEventAccess() { _ = CGRequestPostEventAccess() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        transcriber.stopServer()
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()

        hintItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        hintItem.isEnabled = false
        menu.addItem(hintItem)
        accessItem = NSMenuItem(title: "Open Accessibility Settings", action: #selector(openAccessibility), keyEquivalent: "")
        accessItem.target = self
        menu.addItem(accessItem)
        menu.addItem(.separator())

        let triggerMenu = NSMenu()
        for key in TriggerKey.allCases {
            let item = NSMenuItem(title: key.title, action: #selector(selectTriggerKey(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            triggerMenu.addItem(item)
            triggerItems.append(item)
        }
        let triggerItem = NSMenuItem(title: "Trigger Key", action: nil, keyEquivalent: "")
        triggerItem.submenu = triggerMenu
        menu.addItem(triggerItem)

        soundsItem = NSMenuItem(title: "Start / Stop Sounds", action: #selector(toggleSounds), keyEquivalent: "")
        soundsItem.target = self
        menu.addItem(soundsItem)

        historyMenu = NSMenu()
        historyMenu.delegate = self
        let historyItem = NSMenuItem(title: "History", action: nil, keyEquivalent: "")
        historyItem.submenu = historyMenu
        menu.addItem(historyItem)

        statsMenu = NSMenu()
        statsMenu.delegate = self
        let statsItem = NSMenuItem(title: "Stats", action: nil, keyEquivalent: "")
        statsItem.submenu = statsMenu
        menu.addItem(statsItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Yap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        return menu
    }

    @objc private func openAccessibility() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else { return }
        NSWorkspace.shared.open(url)
    }

    private func refreshMenu() {
        let key = Settings.shared.triggerKey
        let listening = hotKey?.isActive == true
        let canPaste = AXIsProcessTrusted() || CGPreflightPostEventAccess()
        if !listening {
            hintItem.title = "Trigger key needs Accessibility access"
        } else if !canPaste {
            hintItem.title = "Enable Accessibility so the text can be pasted"
        } else {
            hintItem.title = "Hold or tap \(key.title) to dictate"
        }
        accessItem.isHidden = listening && canPaste
        for item in triggerItems {
            item.state = (item.representedObject as? TriggerKey) == key ? .on : .off
        }
        soundsItem.state = Settings.shared.soundsEnabled ? .on : .off
    }

    @objc private func selectTriggerKey(_ sender: NSMenuItem) {
        guard
            let key = sender.representedObject as? TriggerKey,
            key != Settings.shared.triggerKey
        else { return }
        // The old tap is about to disappear, so drop any recording it started.
        cancelRecording()
        Settings.shared.triggerKey = key
        installHotKey()
        refreshMenu()
    }

    @objc private func toggleSounds() {
        Settings.shared.soundsEnabled.toggle()
        refreshMenu()
        // Let them hear what they just switched on.
        if Settings.shared.soundsEnabled { Chime.shared.recordingStarted() }
    }

    // The event tap fails until Accessibility is granted; keep retrying so no relaunch is needed.
    private func installHotKey() {
        hotKey?.stop()
        hotKey = HotKey(
            key: Settings.shared.triggerKey,
            onStart: { [weak self] in self?.beginRecording() },
            onStop: { [weak self] in self?.endRecording() },
            onCancel: { [weak self] in self?.cancelRecording() }
        )
        if hotKey?.isActive != true {
            hotKey = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                // A pending retry must not stomp a tap that has since come up.
                guard let self, self.hotKey == nil else { return }
                self.installHotKey()
            }
        }
        refreshMenu()
    }

    private func beginRecording() {
        paster.rememberTarget()
        do {
            try recorder.start()
            Chime.shared.recordingStarted()
            setIcon("mic.fill", tint: .systemRed)
        } catch {
            NSSound.beep()
            setIcon("mic")
        }
    }

    private func endRecording() {
        let recording = recorder.stop()
        Chime.shared.recordingStopped()
        guard let wav = recording else {
            setIcon("mic")
            return
        }
        setIcon("ellipsis.circle")
        // Capture now: the next recording can overwrite the temporary WAV.
        let duration = Wav.duration(of: wav)
        let staged = History.shared.stage(wav)
        transcriber.transcribe(wav) { [weak self] text in
            DispatchQueue.main.async {
                if let text, !text.isEmpty {
                    self?.stats.record(text: text, duration: duration)
                    if self?.paster.paste(text) != true { NSSound.beep() }
                    if let staged { History.shared.commit(staged, text: text) }
                } else {
                    if let staged { History.shared.discard(staged) }
                    NSSound.beep()
                }
                self?.setIcon("mic")
            }
        }
    }

    private func cancelRecording() {
        recorder.cancel()
        setIcon("mic")
    }

    @objc private func toggleHistory() {
        Settings.shared.historyEnabled.toggle()
    }

    @objc private func copyEntryText(_ sender: NSMenuItem) {
        guard let entry = sender.representedObject as? HistoryEntry else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(entry.text, forType: .string)
    }

    @objc private func playEntryAudio(_ sender: NSMenuItem) {
        guard let entry = sender.representedObject as? HistoryEntry else { return }
        player?.stop()
        player = NSSound(contentsOf: History.shared.audioURL(for: entry), byReference: true)
        player?.play()
    }

    @objc private func clearHistory() {
        History.shared.clear()
    }

    @objc private func resetStats() {
        stats.reset()
    }

    private func setIcon(_ name: String, tint: NSColor? = nil) {
        DispatchQueue.main.async {
            var image = NSImage(systemSymbolName: name, accessibilityDescription: "Yap")
            if let tint {
                image = image?.withSymbolConfiguration(.init(paletteColors: [tint]))
            } else {
                image?.isTemplate = true
            }
            self.statusItem.button?.image = image
        }
    }
}

// Rebuild submenus when they open to show the latest dictations and totals.
extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === statsMenu {
            updateStatsMenu(menu)
            return
        }
        guard menu === historyMenu else { return }
        menu.removeAllItems()

        let toggle = NSMenuItem(title: "Save History", action: #selector(toggleHistory), keyEquivalent: "")
        toggle.target = self
        toggle.state = Settings.shared.historyEnabled ? .on : .off
        menu.addItem(toggle)

        let entries = History.shared.entries
        guard !entries.isEmpty else {
            let empty = NSMenuItem(title: "No Dictations Yet", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(.separator())
            menu.addItem(empty)
            return
        }

        menu.addItem(.separator())
        for entry in entries.prefix(20) {
            // One row per dictation: click it and the text is on the clipboard.
            // Holding option swaps the row for a play button for the recording.
            let tooltip = "\(entry.text)\n\n\(dateLabel(entry.date))  ·  \(durationLabel(entry.duration))\nHold \u{2325} to play the recording"
            let item = NSMenuItem(title: shortTitle(entry.text), action: #selector(copyEntryText(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = entry
            item.toolTip = tooltip
            menu.addItem(item)

            let play = NSMenuItem(title: "\u{25B6}\u{FE0E}  \(shortTitle(entry.text, max: 46))", action: #selector(playEntryAudio(_:)), keyEquivalent: "")
            play.target = self
            play.representedObject = entry
            play.keyEquivalentModifierMask = .option
            play.isAlternate = true
            play.toolTip = tooltip
            menu.addItem(play)
        }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "Clear History", action: #selector(clearHistory), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
    }

    private func updateStatsMenu(_ menu: NSMenu) {
        menu.removeAllItems()
        let totals = stats.totals
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        func number(_ value: Int) -> String {
            formatter.string(from: NSNumber(value: value)) ?? String(value)
        }
        let time = DateComponentsFormatter()
        time.allowedUnits = totals.duration >= 3600 ? [.hour, .minute] : [.minute, .second]
        time.unitsStyle = .abbreviated
        time.zeroFormattingBehavior = .dropAll
        let rows = [
            ("\(number(totals.words)) words", "Words in successfully transcribed dictations."),
            ("\(number(totals.characters)) characters", "Includes spaces and punctuation."),
            ("\(number(totals.recordings)) recordings", "Successfully transcribed recordings only."),
            ("\(time.string(from: totals.duration) ?? "0s") recorded", "Time spent recording successful dictations.")
        ]
        for (title, tooltip) in rows {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            item.toolTip = tooltip
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let reset = NSMenuItem(title: "Reset Stats", action: #selector(resetStats), keyEquivalent: "")
        reset.target = self
        reset.toolTip = "Reset totals to zero. Saved history is kept. Totals continue with Save History off."
        reset.isEnabled = totals.recordings > 0
        menu.addItem(reset)
    }

    private func shortTitle(_ text: String, max: Int = 50) -> String {
        let flat = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return flat.count <= max ? flat : String(flat.prefix(max - 1)) + "\u{2026}"
    }

    private func dateLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.doesRelativeDateFormatting = true
        return formatter.string(from: date)
    }

    private func durationLabel(_ duration: TimeInterval) -> String {
        let seconds = Int(duration.rounded())
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }
}
