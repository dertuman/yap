import AVFoundation

/// Records from the default microphone, downsampled to 16 kHz mono for Whisper.
final class Recorder {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var samples: [Float] = []
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false
    )!

    func start() throws {
        lock.lock(); samples.removeAll(); lock.unlock()

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        converter = AVAudioConverter(from: format, to: targetFormat)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.append(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() -> URL? {
        tearDown()
        lock.lock(); let recorded = samples; lock.unlock()
        guard recorded.count > 4800 else { return nil } // ignore blips under 0.3s

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yap.wav")
        do {
            try writeWav(recorded, to: url)
            return url
        } catch {
            return nil
        }
    }

    func cancel() {
        tearDown()
        lock.lock(); samples.removeAll(); lock.unlock()
    }

    private func tearDown() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        converter.convert(to: out, error: nil) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard out.frameLength > 0, let channel = out.floatChannelData else { return }
        let chunk = UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength))
        lock.lock(); samples.append(contentsOf: chunk); lock.unlock()
    }

    private func writeWav(_ samples: [Float], to url: URL) throws {
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

        try data.write(to: url)
    }
}
