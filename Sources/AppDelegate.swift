import AppKit
import AVFoundation
import ApplicationServices

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let recorder = Recorder()
    private let transcriber = Transcriber()
    private let paster = Paster()
    private var hotKey: HotKey?
    private var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        setIcon("mic")

        let menu = NSMenu()
        let hint = NSMenuItem(title: "Hold or tap right \u{2318} to dictate", action: nil, keyEquivalent: "")
        hint.isEnabled = false
        menu.addItem(hint)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Yap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu

        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)

        transcriber.startServer()
        installHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        transcriber.stopServer()
    }

    // The event tap fails until Accessibility is granted; keep retrying so no relaunch is needed.
    private func installHotKey() {
        hotKey = HotKey(
            onStart: { [weak self] in self?.beginRecording() },
            onStop: { [weak self] in self?.endRecording() },
            onCancel: { [weak self] in self?.cancelRecording() }
        )
        if hotKey?.isActive != true {
            hotKey = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.installHotKey() }
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
