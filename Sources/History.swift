import Foundation

struct HistoryEntry: Codable {
    let id: String
    let text: String
    let date: Date
    let duration: TimeInterval
}

/// Saved dictations, transcript plus the audio it came from, kept in
/// Application Support so an old take can be copied or replayed later.
final class History {
    static let shared = History()

    private let maxEntries = 200
    private let directory: URL
    private let indexURL: URL
    private(set) var entries: [HistoryEntry] = []   // newest first

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = support.appendingPathComponent("Yap/history", isDirectory: true)
        indexURL = directory.appendingPathComponent("history.json")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL),
           let saved = try? JSONDecoder().decode([HistoryEntry].self, from: data) {
            entries = saved
        }
    }

    /// Copies a fresh recording aside before transcription starts, so the next
    /// take cannot overwrite it while Whisper is still working on this one.
    /// Returns nil when history is off.
    func stage(_ wav: URL) -> URL? {
        guard Settings.shared.historyEnabled else { return nil }
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let id = "\(stamp)-\(UUID().uuidString.prefix(8))"
        let dest = directory.appendingPathComponent("\(id).wav")
        do {
            try FileManager.default.copyItem(at: wav, to: dest)
        } catch {
            return nil
        }
        return dest
    }

    func commit(_ staged: URL, text: String) {
        let id = staged.deletingPathExtension().lastPathComponent
        let duration = Wav.duration(of: staged)
        entries.insert(HistoryEntry(id: id, text: text, date: Date(), duration: duration), at: 0)
        save()
    }

    func discard(_ staged: URL) {
        try? FileManager.default.removeItem(at: staged)
    }

    func delete(_ entry: HistoryEntry) {
        entries.removeAll { $0.id == entry.id }
        try? FileManager.default.removeItem(at: audioURL(for: entry))
        save()
    }

    func clear() {
        for entry in entries {
            try? FileManager.default.removeItem(at: audioURL(for: entry))
        }
        entries.removeAll()
        save()
    }

    func audioURL(for entry: HistoryEntry) -> URL {
        directory.appendingPathComponent("\(entry.id).wav")
    }

    private func save() {
        while entries.count > maxEntries {
            let old = entries.removeLast()
            try? FileManager.default.removeItem(at: audioURL(for: old))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        if let data = try? encoder.encode(entries) {
            try? data.write(to: indexURL)
        }
    }
}
