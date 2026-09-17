import Foundation

/// Local running totals; never stores transcripts or audio.
final class Stats {
    static let shared = Stats(history: History.shared.entries)

    struct Totals: Codable {
        var words = 0
        var characters = 0
        var recordings = 0
        var duration: TimeInterval = 0

        mutating func add(text: String, duration: TimeInterval) {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            var wordCount = 0
            text.enumerateSubstrings(in: text.startIndex..<text.endIndex,
                                     options: [.byWords, .substringNotRequired]) { _, _, _, _ in
                wordCount += 1
            }
            words += wordCount
            characters += text.count
            recordings += 1
            if duration.isFinite { self.duration += max(0, duration) }
        }
    }

    private let defaults: UserDefaults
    private let key = "dictationStats"
    private(set) var totals: Totals

    init(defaults: UserDefaults = .standard, history: [HistoryEntry]) {
        self.defaults = defaults
        if let data = defaults.data(forKey: key),
           let saved = try? JSONDecoder().decode(Totals.self, from: data) {
            totals = saved
        } else {
            totals = Totals()
            // Seed once, before the first new dictation is committed to history.
            for entry in history { totals.add(text: entry.text, duration: entry.duration) }
            save()
        }
    }

    func record(text: String, duration: TimeInterval) {
        totals.add(text: text, duration: duration)
        save()
    }

    func reset() {
        totals = Totals()
        save() // Keep a zero value so relaunching doesn't import history again.
    }

    private func save() {
        if let data = try? JSONEncoder().encode(totals) {
            defaults.set(data, forKey: key)
        }
    }
}
