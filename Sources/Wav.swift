import Foundation

/// 16 kHz mono 16-bit WAV encoding for the recorder.
enum Wav {
    /// Duration of a recording written by this encoder (44-byte header, 16 kHz PCM).
    static func duration(of url: URL) -> TimeInterval {
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        return Double(max(0, bytes - 44)) / 2 / 16000
    }

    static func data(_ samples: [Float]) -> Data {
        let sampleRate: UInt32 = 16000
        let dataSize = UInt32(samples.count * 2)

        var data = Data()
        func append(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func append(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }

        data.append(contentsOf: Array("RIFF".utf8))
        append(36 + dataSize)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        append(UInt32(16))
        append(UInt16(1))          // PCM
        append(UInt16(1))          // mono
        append(sampleRate)
        append(sampleRate * 2)     // byte rate
        append(UInt16(2))          // block align
        append(UInt16(16))         // bits per sample
        data.append(contentsOf: Array("data".utf8))
        append(dataSize)

        var pcm = [Int16](repeating: 0, count: samples.count)
        for (i, sample) in samples.enumerated() {
            pcm[i] = Int16(max(-1, min(1, sample)) * 32767)
        }
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }

    static func write(_ samples: [Float], to url: URL) throws {
        try data(samples).write(to: url)
    }
}
