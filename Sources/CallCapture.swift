import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// Cuts a 16 kHz mono stream into utterances: a chunk closes after a pause, or at a hard cap
/// so a monologue still shows up in near real time. Chunks without speech are dropped.
final class UtteranceChunker {
    private let rate = 16000.0
    private let frame = 480                       // 30 ms
    private let maxSamples = 16000 * 12           // 12 s cap
    private let minSamples = 16000 * 6 / 10       // 0.6 s floor
    private let pauseFrames = 22                  // 660 ms of quiet closes a chunk
    private var buffer: [Float] = []
    private var pending: [Float] = []
    private var preroll: [[Float]] = []
    private var quietRun = 0
    private var voiced = 0
    private var noiseFloor = 0.002
    private var chunkStart = Date()
    private let lock = NSLock()
    var onChunk: (([Float], Date) -> Void)?
    private(set) var lastLevel: Double = 0

    /// When the chunk being recorded started, or nil between utterances.
    var openSince: Date? {
        lock.lock(); defer { lock.unlock() }
        return buffer.isEmpty ? nil : chunkStart
    }

    func append(_ samples: UnsafeBufferPointer<Float>) {
        lock.lock(); defer { lock.unlock() }
        pending.append(contentsOf: samples)
        while pending.count >= frame {
            let f = Array(pending[0..<frame])
            pending.removeFirst(frame)
            process(f)
        }
    }

    private func process(_ f: [Float]) {
        var sum: Float = 0
        for s in f { sum += s * s }
        let rms = Double((sum / Float(f.count)).squareRoot())
        lastLevel = rms
        // Track the room's noise slowly so a fan or hum does not read as speech.
        if rms < noiseFloor * 1.5 { noiseFloor = noiseFloor * 0.98 + rms * 0.02 } else { noiseFloor = min(noiseFloor * 1.0005, 0.02) }
        let speech = rms > max(0.006, noiseFloor * 3)

        if buffer.isEmpty {
            // Keep ~300 ms of lead-in so the first syllable is not clipped.
            if !speech {
                preroll.append(f)
                if preroll.count > 10 { preroll.removeFirst() }
                return
            }
            let lead = preroll.flatMap { $0 }
            preroll.removeAll()
            chunkStart = Date().addingTimeInterval(-Double(lead.count + f.count) / rate)
            buffer.append(contentsOf: lead)
        }
        buffer.append(contentsOf: f)
        if speech { voiced += 1; quietRun = 0 } else { quietRun += 1 }

        if (quietRun >= pauseFrames && buffer.count >= minSamples) || buffer.count >= maxSamples {
            flush()
        } else if quietRun >= pauseFrames {
            reset()  // a blip, not speech
        }
    }

    private func flush() {
        // At least ~200 ms of voiced frames, otherwise Whisper invents words from noise.
        if voiced >= 7 {
            let chunk = buffer
            let start = chunkStart
            DispatchQueue.global().async { [onChunk] in onChunk?(chunk, start) }
        }
        reset()
    }

    private func reset() {
        buffer.removeAll(keepingCapacity: true)
        quietRun = 0
        voiced = 0
    }

    func finish() {
        lock.lock(); defer { lock.unlock() }
        if buffer.count >= minSamples { flush() } else { reset() }
    }
}

/// Converts any PCM buffer to 16 kHz mono float.
final class Downsampler {
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

    func convert(_ buffer: AVAudioPCMBuffer, into sink: (UnsafeBufferPointer<Float>) -> Void) {
        if sourceFormat != buffer.format {
            sourceFormat = buffer.format
            converter = AVAudioConverter(from: buffer.format, to: target)
        }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var consumed = false
        converter.convert(to: out, error: nil) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard out.frameLength > 0, let ch = out.floatChannelData else { return }
        sink(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
    }
}

/// Your side of the call. Plain capture, no voice processing: macOS voice processing ducks
/// every other app (the call itself goes quiet) and takes the mic from dictation. Without
/// headphones the mic hears the speakers; the server holds "me" text until the overlapping
/// "them" audio is transcribed and drops it if it echoes "them".
final class CallMic {
    private var engine: AVAudioEngine?
    private let down = Downsampler()
    let chunker = UtteranceChunker()
    private(set) var lastAudio = Date.distantPast

    func start() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CallCaptureError.noInput }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.lastAudio = Date()
            self.down.convert(buffer) { self.chunker.append($0) }
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    func stop() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        chunker.finish()
    }
}

/// The other side of the call: everything the Mac plays, through a Core Audio process tap
/// (macOS 14.2+). Asks for "System Audio Recording Only", not screen recording.
final class SystemAudioTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "yap.systemtap")
    private let down = Downsampler()
    private var format: AVAudioFormat?
    let chunker = UtteranceChunker()
    private(set) var lastAudio = Date.distantPast

    func start() throws {
        guard #available(macOS 14.2, *) else { throw CallCaptureError.unsupported }
        // Leave Yap's own sounds out of "them".
        let own = Self.processObject(pid: getpid())
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: own.map { [$0] } ?? [])
        description.uuid = UUID()
        description.name = "Yap call tap"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr else { throw CallCaptureError.status("create tap", status) }
        tapID = tap

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        status = AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd)
        guard status == noErr, let fmt = AVAudioFormat(streamDescription: &asbd) else { throw CallCaptureError.status("tap format", status) }
        format = fmt

        let outputUID = try Self.defaultOutputUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Yap Call Capture",
            kAudioAggregateDeviceUIDKey: "yap-call-" + UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        var agg = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &agg)
        guard status == noErr else { throw CallCaptureError.status("aggregate", status) }
        aggregateID = agg

        status = AudioDeviceCreateIOProcIDWithBlock(&procID, agg, queue) { [weak self] _, input, _, _, _ in
            // The list also carries the output device's own input streams (a headset mic, say).
            // The tap's stream comes last.
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard let self, let fmt = self.format, let last = list.last, last.mDataByteSize > 0 else { return }
            var single = AudioBufferList(mNumberBuffers: 1, mBuffers: last)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: &single, deallocator: nil) else { return }
            self.lastAudio = Date()
            self.down.convert(buffer) { self.chunker.append($0) }
        }
        guard status == noErr else { throw CallCaptureError.status("io proc", status) }
        status = AudioDeviceStart(agg, procID)
        guard status == noErr else { throw CallCaptureError.status("start", status) }
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, procID)
            if let procID { AudioDeviceDestroyIOProcID(aggregateID, procID) }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if #available(macOS 14.2, *), tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
        }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
        chunker.finish()
    }

    private static func processObject(pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var pid = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object)
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }

    private static func defaultOutputUID() throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr else { throw CallCaptureError.status("output device", status) }
        address.mSelector = kAudioDevicePropertyDeviceUID
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid)
        guard status == noErr, let uid else { throw CallCaptureError.status("output uid", status) }
        return uid.takeRetainedValue() as String
    }
}

enum CallCaptureError: LocalizedError {
    case noInput, unsupported
    case status(String, OSStatus)

    var errorDescription: String? {
        switch self {
        case .noInput: return "No microphone input"
        case .unsupported: return "System audio capture needs macOS 14.2 or newer"
        case let .status(step, code): return "System audio \(step) failed (\(code))"
        }
    }
}
