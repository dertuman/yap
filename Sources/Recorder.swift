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
        guard hasSpeech(recorded) else { return nil }   // fed silence, Whisper invents "Thank you."

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yap.wav")
        do {
            try Wav.write(recorded, to: url)
            return url
        } catch {
            return nil
        }
    }

    func cancel() {
        tearDown()
        lock.lock(); samples.removeAll(); lock.unlock()
    }

    /// True if some stretch of the take is loud enough to be speech. Framed RMS rather than
    /// peak, since the start tick bleeds through the speakers and would supply the peak in an
    /// otherwise empty recording. The bar is the louder of a fixed floor and 8 dB over this
    /// room's own noise, so a hot mic in a loud room does not read as speech.
    private func hasSpeech(_ samples: [Float]) -> Bool {
        let frame = 480                                  // 30ms at 16 kHz
        let skip = min(samples.count, 2048)              // 128ms, where the start tick lands
        var levels: [Double] = []
        var i = skip
        while i + frame <= samples.count {
            var sum = 0.0
            for j in i..<(i + frame) { sum += Double(samples[j]) * Double(samples[j]) }
            levels.append((sum / Double(frame)).squareRoot())
            i += frame
        }
        guard levels.count >= 4 else { return false }

        let noiseFloor = levels.sorted()[levels.count / 10]
        let threshold = max(0.0025, noiseFloor * 2.5)    // -52 dBFS, or 8 dB over the room
        var run = 0
        for level in levels {
            run = level > threshold ? run + 1 : 0
            if run >= 3 { return true }                  // 90ms of speech-level audio
        }
        return false
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

}
