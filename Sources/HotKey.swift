import AppKit
import CoreGraphics

/// Watches the right Command key. Hold it to record push-to-talk style,
/// or tap it (< 0.4s) to latch recording on until the next tap.
/// Pressing any other key while holding cancels, so real shortcuts still work.
final class HotKey {
    private static let rightCommandMask: UInt64 = 0x0010 // NX_DEVICERCMDKEYMASK
    private static let rightCommandKeyCode: Int64 = 54

    private enum State {
        case idle
        case held(since: Date)
        case latched
    }

    private var state = State.idle
    private var tap: CFMachPort?
    private let onStart: () -> Void
    private let onStop: () -> Void
    private let onCancel: () -> Void

    var isActive: Bool { tap != nil }

    init(onStart: @escaping () -> Void, onStop: @escaping () -> Void, onCancel: @escaping () -> Void) {
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
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        if type == .flagsChanged {
            guard event.getIntegerValueField(.keyboardEventKeycode) == Self.rightCommandKeyCode else { return }
            let isDown = event.flags.rawValue & Self.rightCommandMask != 0
            DispatchQueue.main.async { isDown ? self.rightCommandDown() : self.rightCommandUp() }
        } else if type == .keyDown {
            DispatchQueue.main.async { self.otherKeyDown() }
        }
    }

    private func rightCommandDown() {
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

    private func rightCommandUp() {
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
