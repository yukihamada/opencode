import AVFoundation
import Foundation

// One hold, one file. Never keep capturing after stdin closes.
guard CommandLine.arguments.count == 2 else { exit(2) }
let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0, format.channelCount > 0,
      let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate,
                               channels: 1, interleaved: false) else { exit(2) }
let queue = DispatchQueue(label: "sente.voice.hold")
var file: AVAudioFile?
var frames: AVAudioFramePosition = 0
var peak: Float = 0
var elapsed = 0.0
var stopped = false
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let text = String(data: data, encoding: .utf8) else { return }
    print(text); fflush(stdout)
}
func stop() {
    if stopped { return }
    stopped = true
    engine.stop()
    input.removeTap(onBus: 0)
    queue.sync {
        file = nil
        emit(["type": "segment", "duration": Double(frames) / format.sampleRate,
              "peak": peak > 0 ? 20 * log10(Double(peak)) : -120])
    }
    exit(0)
}
do {
    file = try AVAudioFile(forWriting: URL(fileURLWithPath: CommandLine.arguments[1]), settings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
    ])
} catch { emit(["type": "error", "message": "Cannot create audio file"]); exit(2) }
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    guard let source = buffer.floatChannelData?[0], buffer.frameLength > 0,
          let copy = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
          let dest = copy.floatChannelData?[0] else { return }
    copy.frameLength = buffer.frameLength
    dest.update(from: source, count: Int(buffer.frameLength))
    queue.async {
        let n = Int(copy.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += dest[i] * dest[i]; peak = max(peak, abs(dest[i])) }
        do { try file?.write(from: copy) }
        catch { emit(["type": "error", "message": "Audio write failed"]); exit(2) }
        frames += AVAudioFramePosition(n)
        elapsed += Double(n) / format.sampleRate
        if elapsed >= 0.05 {
            let rms = sqrt(Double(sum) / Double(n))
            let db = rms > 0 ? 20 * log10(rms) : -60
            emit(["type": "level", "value": max(0, min(1, (db + 60) / 60))])
            elapsed = 0
        }
    }
}
DispatchQueue.global().async {
    _ = FileHandle.standardInput.readDataToEndOfFile()
    DispatchQueue.main.async { stop() }
}
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { stop() }; term.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { stop() }; interrupt.resume()
do { try engine.start(); emit(["type": "ready"]) }
catch { emit(["type": "error", "message": "Microphone unavailable or permission denied"]); exit(2) }
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { stop() }
RunLoop.main.run()
