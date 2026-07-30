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

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        setIcon("mic")
        statusItem.menu = buildMenu()
        refreshMenu()

        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)

        transcriber.startServer()
        installHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        transcriber.stopServer()
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()

        hintItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        hintItem.isEnabled = false
        menu.addItem(hintItem)
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

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Yap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        return menu
    }

    private func refreshMenu() {
        let key = Settings.shared.triggerKey
        hintItem.title = "Hold or tap \(key.title) to dictate"
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
    }

    private func beginRecording() {
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
        transcriber.transcribe(wav) { [weak self] text in
            DispatchQueue.main.async {
                if let text, !text.isEmpty {
                    self?.paster.paste(text)
                } else {
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
