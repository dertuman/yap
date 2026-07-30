import AVFoundation

/// Short synthesized ticks: a bright one when recording starts, a lower one when it ends.
/// Each is a resonant filter ping with a noise transient, ~60ms, so it reads as a tactile
/// click rather than a tone and barely bleeds into the recording.
final class Chime {
    static let shared = Chime()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
    private lazy var up = render(hz: 480, duration: 0.055, brightness: 5, seed: 7)
    private lazy var down = render(hz: 300, duration: 0.075, brightness: 3, seed: 7)

    private init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    func recordingStarted() { play(up) }
    func recordingStopped() { play(down) }

    private func play(_ buffer: AVAudioPCMBuffer?) {
        guard let buffer else { return }
        do {
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
            if !player.isPlaying { player.play() }
            player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
        } catch {
            // A tick is cosmetic, never let it break dictation.
        }
    }

    private func render(hz: Double, duration: Double, brightness: Double, seed: UInt64) -> AVAudioPCMBuffer? {
        let rate = format.sampleRate
        let frames = AVAudioFrameCount(rate * duration)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        guard let channel = buffer.floatChannelData?[0] else { return nil }

        var noise = Noise(state: seed)
        var body = Resonator(hz: hz, q: 7, rate: rate)          // the pitched thock
        var air = Resonator(hz: hz * brightness, q: 2.5, rate: rate) // the transient sheen on top
        let burstFrames = Int(rate * 0.004)
        let count = Int(frames)

        for i in 0..<count {
            let impulse = i < 2 ? 1.0 : 0.0
            let burst = i < burstFrames ? noise.next() : 0
            let tone = body.ping(impulse + burst * 0.5)
            let sheen = air.ping(burst)
            let fade = pow(1 - Double(i) / Double(count), 1.6)
            channel[i] = Float(saturate(tone * 0.9 + sheen * 0.35, drive: 2) * fade * 0.5)
        }
        return buffer
    }

    private func saturate(_ x: Double, drive: Double) -> Double { tanh(x * drive) / tanh(drive) }
}

/// Deterministic white noise, so the tick sounds identical every press.
private struct Noise {
    var state: UInt64
    mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(Int64(bitPattern: state >> 11)) / Double(1 << 53) * 2 - 1
    }
}

/// Chamberlin state variable filter, used as a bandpass rung by an impulse.
private struct Resonator {
    private var low = 0.0
    private var band = 0.0
    private let f: Double
    private let damp: Double

    init(hz: Double, q: Double, rate: Double) {
        f = 2 * sin(.pi * min(hz, rate * 0.45) / rate)
        damp = 1 / q
    }

    mutating func ping(_ x: Double) -> Double {
        low += f * band
        band += f * (x - low - damp * band)
        return band
    }
}
