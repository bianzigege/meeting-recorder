import Foundation
import Speech
import AVFoundation

// 用法: transcribe <音频文件> [locale 如 zh-CN] [词库文件,每行一个专有名词]
// 输出: 每行一个 JSON {"start":秒,"end":秒,"text":"..."}
let args = CommandLine.arguments
guard args.count >= 2 else { FileHandle.standardError.write("usage: transcribe <file> [locale]\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
let localeId = args.count >= 3 ? args[2] : "zh-CN"
let terms: [String] = args.count >= 4
    ? ((try? String(contentsOfFile: args[3], encoding: .utf8)) ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    : []

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let sem = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    do {
        let locale = Locale(identifier: localeId)
        let supported = await SpeechTranscriber.supportedLocales
        guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
            log("locale not supported: \(localeId). supported: \(supported.map { $0.identifier(.bcp47) })")
            exitCode = 3; sem.signal(); return
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            log("downloading speech model for \(localeId)...")
            try await req.downloadAndInstall()
            log("model ready")
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        if !terms.isEmpty {
            // 专有名词提示给识别器,提高人名、品牌名、术语的识别率
            let ctx = AnalysisContext()
            ctx.contextualStrings[.general] = terms
            do { try await analyzer.setContext(ctx); log("loaded \(terms.count) terms") } catch { log("setContext failed: \(error)") }
        }
        let file = try AVAudioFile(forReading: url)

        let consumer = Task {
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                var start = 0.0, end = 0.0
                if let r = result.range as CMTimeRange? {
                    start = r.start.seconds; end = r.end.seconds
                }
                let obj: [String: Any] = ["start": start, "end": end, "text": text]
                let data = try JSONSerialization.data(withJSONObject: obj)
                print(String(data: data, encoding: .utf8)!)
                fflush(stdout)
            }
        }
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        try await consumer.value
    } catch {
        log("error: \(error)")
        exitCode = 1
    }
    sem.signal()
}
sem.wait()
exit(exitCode)
