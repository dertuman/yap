import AppKit
import CoreGraphics

/// Watches whichever modifier key the user picked. Hold it to record push-to-talk style,
/// or tap it (< 0.4s) to latch recording on until the next tap.
/// Pressing any other key while holding cancels, so real shortcuts still work.
final class HotKey {
    private enum State {
        case idle
        case held(since: Date)
        case latched
    }

    private let key: TriggerKey
    private var state = State.idle
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private let onStart: () -> Void
    private let onStop: () -> Void
    private let onCancel: () -> Void

    var isActive: Bool { tap != nil }

    init(
        key: TriggerKey,
        onStart: @escaping () -> Void,
        onStop: @escaping () -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.key = key
        self.onStart = onStart
        self.onStop = onStop
        self.onCancel = onCancel

        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            let hotKey = Unmanaged<HotKey>.fromOpaque(userInfo!).takeUnretainedValue()
            hotKey.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }
        tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )
        guard let tap else { return }
        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        source = runLoopSource
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    deinit { stop() }

    /// Tears the tap down, so a replacement can take over when the trigger key changes.
    func stop() {
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            self.source = nil
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            self.tap = nil
        }
        state = .idle
    }

    private func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        if type == .flagsChanged {
            guard event.getIntegerValueField(.keyboardEventKeycode) == key.keyCode else { return }
            let isDown = event.flags.rawValue & key.flagMask != 0
            DispatchQueue.main.async { isDown ? self.triggerDown() : self.triggerUp() }
        } else if type == .keyDown {
            DispatchQueue.main.async { self.otherKeyDown() }
        }
    }

    private func triggerDown() {
        switch state {
        case .idle:
            state = .held(since: Date())
            onStart()
        case .latched:
            state = .idle
            onStop()
        case .held:
            break
        }
    }

    private func triggerUp() {
        guard case .held(let since) = state else { return }
        if Date().timeIntervalSince(since) < 0.4 {
            state = .latched
        } else {
            state = .idle
            onStop()
        }
    }

    private func otherKeyDown() {
        guard case .held = state else { return }
        state = .idle
        onCancel()
    }
}
