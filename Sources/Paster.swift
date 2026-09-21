import AppKit

/// Inserts text at the cursor by borrowing the clipboard for a synthetic Cmd+V.
final class Paster {
    /// The app the user was typing in when the take started.
    private var target: pid_t?

    func rememberTarget() {
        guard let front = NSWorkspace.shared.frontmostApplication,
              front.processIdentifier != ProcessInfo.processInfo.processIdentifier
        else { return }
        target = front.processIdentifier
    }

    /// False when Accessibility isn't granted. The words stay on the clipboard.
    func paste(_ text: String) -> Bool {
        let pasteboard = NSPasteboard.general
        // Snapshot every item with all its representations (images, files, rich text),
        // not just plain strings, so restoring gives back exactly what was there.
        let previousItems = (pasteboard.pasteboardItems ?? []).map { item -> NSPasteboardItem in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) {
                    copy.setData(data, forType: type)
                }
            }
            return copy
        }
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        guard AXIsProcessTrusted() || CGPreflightPostEventAccess() else { return false }

        let source = CGEventSource(stateID: .combinedSessionState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        if let target {
            down?.postToPid(target)
            up?.postToPid(target)
        } else {
            down?.post(tap: .cgAnnotatedSessionEventTap)
            up?.post(tap: .cgAnnotatedSessionEventTap)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            pasteboard.clearContents()
            if !previousItems.isEmpty { pasteboard.writeObjects(previousItems) }
        }
        return true
    }
}
