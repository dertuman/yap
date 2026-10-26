import Foundation

/// Makes a transcript read like a typed chat message: no ¿ ¡ or closing periods,
/// lowercase sentence starts, and slang or shorthand from a word list. The prompt and
/// word list live under ~/Library/Application Support/Yap/style so they can be edited
/// without rebuilding.
struct ChatStyle {
    /// Sample text in the target voice. Whisper continues in the style of its prompt,
    /// so this steers spelling, slang and casing before any rewriting happens.
    let prompt: String
    private let replacements: [(pattern: NSRegularExpression, written: String)]

    static let directory = URL(fileURLWithPath: NSString(
        string: "~/Library/Application Support/Yap/style"
    ).expandingTildeInPath)
    static var promptURL: URL { directory.appendingPathComponent("prompt.txt") }
    static var wordsURL: URL { directory.appendingPathComponent("words.txt") }

    /// Reads the files on every take, so edits apply to the next dictation.
    /// Missing files are written out with the defaults first.
    static func load() -> ChatStyle {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        func read(_ url: URL, seed: String) -> String {
            if let text = try? String(contentsOf: url, encoding: .utf8) { return text }
            try? seed.write(to: url, atomically: true, encoding: .utf8)
            return seed
        }
        return ChatStyle(
            prompt: read(promptURL, seed: defaultPrompt),
            words: read(wordsURL, seed: defaultWords)
        )
    }

    init(prompt: String, words: String) {
        self.prompt = prompt
            .components(separatedBy: .newlines)
            .filter { !$0.hasPrefix("#") }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)

        // One "spoken -> written" pair per line. Longer phrases go first so
        // "a la verga" wins over a rule for "verga" alone.
        let pairs: [(String, String)] = words.components(separatedBy: .newlines).compactMap { line in
            let line = line.trimmingCharacters(in: .whitespaces)
            guard !line.hasPrefix("#") else { return nil }
            let parts = line.components(separatedBy: "->")
            guard parts.count == 2 else { return nil }
            let spoken = parts[0].trimmingCharacters(in: .whitespaces)
            guard !spoken.isEmpty else { return nil }
            return (spoken, parts[1].trimmingCharacters(in: .whitespaces))
        }
        replacements = pairs.sorted { $0.0.count > $1.0.count }.compactMap { spoken, written in
            let words = spoken.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
            let body = words.map(Self.accentInsensitive).joined(separator: "\\s+")
            guard let pattern = try? NSRegularExpression(
                pattern: "(?<![\\p{L}\\p{N}])\(body)(?![\\p{L}\\p{N}])",
                options: .caseInsensitive
            ) else { return nil }
            return (pattern, NSRegularExpression.escapedTemplate(for: written))
        }
    }

    func apply(_ text: String) -> String {
        var out = text
        for (pattern, written) in replacements {
            out = pattern.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: written)
        }
        out.removeAll { $0 == "¿" || $0 == "¡" }
        // Lowercase each sentence's first word, but leave acronyms like AI or CDMX alone.
        out = Self.mapMatches(in: out, of: Self.sentenceStart) { $0.lowercased() }
        // Periods inside the text become commas, the last one goes. Ellipses and
        // decimals like 9.30 are left as they are.
        out = Self.replace(Self.closingPeriod, in: out, with: "")
        out = Self.replace(Self.innerPeriod, in: out, with: ",")
        return out.trimmingCharacters(in: .whitespaces)
    }

    private static let sentenceStart = try! NSRegularExpression(
        pattern: "(?:^|(?<=[.?!…]\\s))\\s*\\p{Lu}(?![\\p{Lu}\\p{N}])"
    )
    private static let closingPeriod = try! NSRegularExpression(pattern: "(?<!\\.)\\.\\s*$")
    private static let innerPeriod = try! NSRegularExpression(pattern: "(?<!\\.)\\.(?=\\s)")

    /// Whisper drops or adds accents at random ("como te caeria", "cómo te caería"), so
    /// each vowel matches its accented forms too. ñ stays distinct from n.
    private static func accentInsensitive(_ word: String) -> String {
        let vowels: [Character: String] = [
            "a": "[aá]", "á": "[aá]", "e": "[eé]", "é": "[eé]", "i": "[ií]", "í": "[ií]",
            "o": "[oó]", "ó": "[oó]", "u": "[uúü]", "ú": "[uúü]", "ü": "[uúü]",
        ]
        return NSRegularExpression.escapedPattern(for: word.lowercased())
            .map { vowels[$0] ?? String($0) }
            .joined()
    }

    private static func replace(_ pattern: NSRegularExpression, in text: String, with template: String) -> String {
        pattern.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    private static func mapMatches(
        in text: String, of pattern: NSRegularExpression, _ transform: (String) -> String
    ) -> String {
        var out = text
        // Back to front so earlier ranges stay valid as the string changes.
        for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let range = Range(match.range, in: out) else { continue }
            out.replaceSubrange(range, with: transform(String(out[range])))
        }
        return out
    }

    static let defaultPrompt = """
    # How you type in chats. Whisper copies the voice of this text: lowercase, no ¿ ¡,
    # commas instead of periods, your slang and spellings. Keep it short (around 100 words).
    qué onda we, ahorita te marco, neta no mames está buenísimo haha, o sea sí pero igual \
    lo checo mañana, va, ntp, un chingo de chamba pero todo bien, sale nos vemos al rato, \
    está cañón eh, pues venga, ya vi el video lol
    """

    static let defaultWords = """
    # spoken -> written, one per line. Matches whole words, ignoring case and accents.
    güey -> we
    guey -> we
    wey -> we
    jajajaja -> hahaha
    jajaja -> hahaha
    jaja -> haha
    ja ja ja ja -> hahaha
    ja ja ja -> hahaha
    ja ja -> haha
    no te preocupes -> ntp
    a la verga -> alv
    de la verga -> dlv
    """
}
