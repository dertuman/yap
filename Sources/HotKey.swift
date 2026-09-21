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

    /// Held weakly so a key event in flight can't use a HotKey that stop() has released.
    private final class Owner {
        weak var hotKey: HotKey?
        let lock = NSLock()

        func use(_ body: (HotKey) -> Void) {
            lock.lock()
            let hotKey = hotKey
            lock.unlock()
            if let hotKey { body(hotKey) }
        }
    }

    private let key: TriggerKey
    private let owner = Owner()
    private var state = State.idle
    private var stopped = false
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var activity: NSObjectProtocol?
    private let onStart: () -> Void
    private let onStop: () -> Void
    private let onCancel: () -> Void

    /// A tap can exist but sit disabled, with key events stripped out of its mask, when
    /// Accessibility wasn't granted at the moment it was created. That one never wakes up.
    var isActive: Bool {
        guard let tap else { return false }
        return CGEvent.tapIsEnabled(tap: tap)
    }

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
        owner.hotKey = self

        // The menu bar run loop only delivers tap events while the menu is tracking.
        activity = ProcessInfo.processInfo.beginActivity(
            options: .userInitiated,
            reason: "Watching the trigger key"
        )

        let ready = DispatchSemaphore(value: 0)
        let owner = self.owner
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            let owner = Unmanaged<Owner>.fromOpaque(userInfo!).takeUnretainedValue()
            owner.use { $0.handle(type: type, event: event) }
            return Unmanaged.passUnretained(event)
        }
        let thread = Thread {
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: CGEventMask(mask),
                callback: callback,
                userInfo: Unmanaged.passUnretained(owner).toOpaque()
            )
            guard let tap else {
                ready.signal()
                return
            }
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            let runLoop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(runLoop, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            owner.use {
                $0.tap = tap
                $0.runLoop = runLoop
            }
            CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue) {
                ready.signal()
            }
            CFRunLoopRun()
            CFRunLoopRemoveSource(runLoop, source, .commonModes)
        }
        thread.name = "Yap HotKey"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
        ready.wait()
    }

    deinit { stop() }

    /// Tears the tap down, so a replacement can take over when the trigger key changes.
    func stop() {
        if stopped { return }
        stopped = true
        owner.lock.lock()
        owner.hotKey = nil
        owner.lock.unlock()
        if let activity {
            ProcessInfo.processInfo.endActivity(activity)
            self.activity = nil
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            self.tap = nil
        }
        if let runLoop {
            CFRunLoopStop(runLoop)
            self.runLoop = nil
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
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped else { return }
                isDown ? self.triggerDown() : self.triggerUp()
            }
        } else if type == .keyDown {
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped else { return }
                self.otherKeyDown()
            }
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
