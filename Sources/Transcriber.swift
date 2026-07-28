import Foundation

/// Runs whisper-server as a child process so the model stays loaded between dictations.
final class Transcriber {
    private let port = 8767
    private var server: Process?
    private let modelPath = NSString(
        string: "~/Library/Application Support/Yap/models/ggml-large-v3-turbo-q5_0.bin"
    ).expandingTildeInPath
    private let serverBinary = "/opt/homebrew/bin/whisper-server"

    func startServer() {
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kill.arguments = ["-f", "whisper-server.*\(port)"]
        try? kill.run()
        kill.waitUntilExit()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: serverBinary)
        process.arguments = [
            "-m", modelPath,
            "--host", "127.0.0.1",
            "--port", String(port),
            "--language", "auto",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        server = process
    }

    func stopServer() {
        server?.terminate()
        server = nil
    }

    func transcribe(_ wav: URL, completion: @escaping (String?) -> Void) {
        guard let audio = try? Data(contentsOf: wav) else {
            completion(nil)
            return
        }
        attempt(audio: audio, retriesLeft: 60, completion: completion)
    }

    // Retries cover the model still loading right after launch.
    private func attempt(audio: Data, retriesLeft: Int, completion: @escaping (String?) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/inference")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 120

        let boundary = "yap-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        field("temperature", "0.0")
        field("response_format", "json")
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
        body.append(audio)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        request.httpBody = body

        URLSession.shared.dataTask(with: request) { data, _, error in
            if error != nil {
                if retriesLeft > 0 {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
                        self.attempt(audio: audio, retriesLeft: retriesLeft - 1, completion: completion)
                    }
                } else {
                    completion(nil)
                }
                return
            }
            guard
                let data,
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let text = json["text"] as? String
            else {
                completion(nil)
                return
            }
            // The server emits one line per segment; join them back into flowing text.
            let flat = text
                .components(separatedBy: .whitespacesAndNewlines)
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            completion(flat)
        }.resume()
    }
}
