import Foundation

@main
enum StatsTests {
    static func main() throws {
        let suite = "Yap.StatsTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let history = [
            HistoryEntry(id: "one", text: "Hello, world!", date: Date(), duration: 3.5),
            HistoryEntry(id: "two", text: "One\ntwo\tthree", date: Date(), duration: 6.5)
        ]

        let stats = Stats(defaults: defaults, history: history)
        assert(stats.totals.words == 5)
        assert(stats.totals.characters == 26)
        assert(stats.totals.recordings == 2)
        assert(stats.totals.duration == 10)

        // Relaunch with the same history must not count it twice.
        let reloaded = Stats(defaults: defaults, history: history)
        assert(reloaded.totals.recordings == 2)
        // A dictation counts independently of history being saved.
        reloaded.record(text: "Café 👨‍👩‍👧‍👦", duration: 1.25)
        reloaded.record(text: " \n\t", duration: 100)
        let withoutHistory = Stats(defaults: defaults, history: [])
        assert(withoutHistory.totals.words == 6)
        assert(withoutHistory.totals.characters == 32) // graphemes, not bytes
        assert(withoutHistory.totals.recordings == 3)
        assert(withoutHistory.totals.duration == 11.25)

        // Persist only aggregate values, never transcript content.
        let json = try JSONSerialization.jsonObject(with: defaults.data(forKey: "dictationStats")!) as! [String: Any]
        assert(Set(json.keys) == Set(["words", "characters", "recordings", "duration"]))

        withoutHistory.reset()
        let afterReset = Stats(defaults: defaults, history: history)
        assert(afterReset.totals.recordings == 0)
        assert(afterReset.totals.words == 0)
        assert(afterReset.totals.characters == 0)
        assert(afterReset.totals.duration == 0)
        afterReset.record(text: "New start", duration: 2)
        assert(Stats(defaults: defaults, history: history).totals.recordings == 1)

        // The time shown in stats comes from the audio samples, not transcription latency.
        let wav = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: wav) }
        try Wav.write(Array(repeating: Float(0), count: 20000), to: wav)
        assert(Wav.duration(of: wav) == 1.25)
        try Wav.write([], to: wav)
        assert(Wav.duration(of: wav) == 0)

        print("Stats tests passed")
    }
}
