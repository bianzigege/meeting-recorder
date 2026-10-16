import AppKit
import AVFoundation
import Carbon.HIToolbox
import CoreMedia
import Foundation
import ScreenCaptureKit

// 录制助手:用 ScreenCaptureKit 录屏幕 / 系统声音 / 麦克风,三路分别存文件,时间轴对齐。
// 由 server.ts 通过 `open -n 录制助手.app --args ...` 启动(这样系统权限算在本应用头上)。
//
// 用法:
//   recorder --list --out <file.json>                 列出可录的屏幕和窗口
//   recorder --out <目录> --mode both|audio|screen [--display <id>] [--window <id>] [--no-mic]
//
// 录制中:
//   SIGUSR1 / ⌃⌥⌘P  暂停或继续
//   SIGUSR2 / ⌃⌥⌘M  打点
//   SIGINT  / ⌃⌥⌘S  停止
// 状态写在 <目录>/status.json:state = starting | recording | paused | finished | error

// ---------- 参数 ----------
struct Options {
    var list = false
    var out = ""
    var mode = "both"
    var displayID: CGDirectDisplayID?
    var windowID: CGWindowID?
    var mic = true
}

func parseOptions() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--list": o.list = true
        case "--out": o.out = it.next() ?? ""
        case "--mode": o.mode = it.next() ?? "both"
        case "--display": o.displayID = it.next().flatMap { UInt32($0) }
        case "--window": o.windowID = it.next().flatMap { UInt32($0) }
        case "--no-mic": o.mic = false
        default: break
        }
    }
    return o
}

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func writeJSON(_ obj: Any, to path: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) else { return }
    let tmp = path + ".tmp"
    FileManager.default.createFile(atPath: tmp, contents: data)
    _ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))
}

func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

// ---------- 单个输出文件 ----------
// 收到第一帧时才按真实格式创建 writer,会话统一从 t0 开始,三个文件的 0 秒是同一时刻
final class TrackWriter {
    enum Kind { case video, audio }
    let kind: Kind
    let url: URL
    private(set) var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private(set) var appended = 0
    private var failed = false

    init(kind: Kind, url: URL) { self.kind = kind; self.url = url }

    func append(_ sb: CMSampleBuffer, sessionStart: CMTime) {
        if failed { return }
        if writer == nil && !setup(sb, sessionStart: sessionStart) { failed = true; return }
        guard let input, input.isReadyForMoreMediaData else { return }
        if input.append(sb) { appended += 1 } else if let e = writer?.error {
            log("写入 \(url.lastPathComponent) 失败: \(e)"); failed = true
        }
    }

    private func setup(_ sb: CMSampleBuffer, sessionStart: CMTime) -> Bool {
        try? FileManager.default.removeItem(at: url)
        do {
            let w = try AVAssetWriter(outputURL: url, fileType: kind == .video ? .mp4 : .m4a)
            let inp: AVAssetWriterInput
            if kind == .video {
                guard let img = CMSampleBufferGetImageBuffer(sb) else { return false }
                let width = CVPixelBufferGetWidth(img), height = CVPixelBufferGetHeight(img)
                // 屏幕内容好压缩,约 0.06 bit/像素/帧,1920x1200@30 ≈ 4 Mbps 上限内
                let bitrate = min(6_000_000, max(1_000_000, Int(Double(width * height) * 30 * 0.06)))
                inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: width,
                    AVVideoHeightKey: height,
                    AVVideoCompressionPropertiesKey: [
                        AVVideoAverageBitRateKey: bitrate,
                        AVVideoExpectedSourceFrameRateKey: 30,
                        AVVideoMaxKeyFrameIntervalKey: 60,
                        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                    ],
                ])
            } else {
                guard let fmt = CMSampleBufferGetFormatDescription(sb),
                      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee else { return false }
                let channels = min(2, max(1, Int(asbd.mChannelsPerFrame)))
                inp = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: min(48000, asbd.mSampleRate),
                    AVNumberOfChannelsKey: channels,
                    AVEncoderBitRateKey: channels == 2 ? 128_000 : 64_000,
                ], sourceFormatHint: fmt)
            }
            inp.expectsMediaDataInRealTime = true
            guard w.canAdd(inp) else { return false }
            w.add(inp)
            guard w.startWriting() else { log("startWriting 失败: \(String(describing: w.error))"); return false }
            w.startSession(atSourceTime: sessionStart)
            writer = w; input = inp
            return true
        } catch {
            log("创建 \(url.lastPathComponent) 失败: \(error)")
            return false
        }
    }

    // 返回最终是否得到了可用文件
    func finish(_ done: @escaping (Bool) -> Void) {
        guard let writer, let input else { done(false); return }
        if appended == 0 || writer.status != .writing {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            done(false); return
        }
        input.markAsFinished()
        writer.finishWriting { [url] in
            let ok = writer.status == .completed
            if !ok { log("收尾 \(url.lastPathComponent) 失败: \(String(describing: writer.error))") }
            done(ok)
        }
    }
}

// ---------- 录制 ----------
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = Recorder()

    var opts = Options()
    let queue = DispatchQueue(label: "recorder.samples")
    var stream: SCStream?
    var t0: CMTime = .invalid
    var pauses: [(start: CMTime, end: CMTime)] = [] // 已结束的暂停区间(主机时钟)
    var pauseStart: CMTime?                          // 正在暂停时的起点
    var markers: [Double] = []
    var warnings: [String] = []
    var state = "starting"
    var stopping = false
    var video: TrackWriter?
    var system: TrackWriter?
    var mic: TrackWriter?

    var statusPath: String { (opts.out as NSString).appendingPathComponent("status.json") }

    func writeStatus(extra: [String: Any] = [:]) {
        var obj: [String: Any] = [
            "state": state,
            "pid": Int(getpid()),
            "mode": opts.mode,
            "elapsed": elapsed(),
            "markers": markers,
            "warnings": warnings,
            "updatedAt": Date().timeIntervalSince1970,
        ]
        for (k, v) in extra { obj[k] = v }
        writeJSON(obj, to: statusPath)
    }

    func fail(_ msg: String) {
        log(msg)
        state = "error"
        writeStatus(extra: ["error": msg])
        exit(1)
    }

    // 录制时长(不含暂停)
    func elapsed(at now: CMTime = hostNow()) -> Double {
        guard t0.isValid else { return 0 }
        var t = (now - t0).seconds
        for p in pauses { t -= (p.end - p.start).seconds }
        if let ps = pauseStart { t -= (now - ps).seconds }
        return max(0, t)
    }

    func start(_ o: Options) async {
        opts = o
        try? FileManager.default.createDirectory(atPath: o.out, withIntermediateDirectories: true)
        writeStatus()

        // 屏幕录制权限(录声音也要,系统声音走的是同一个接口)
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
            fail("没有屏幕录制权限。请在「系统设置 → 隐私与安全性 → 屏幕与系统录音」里打开「录制助手」,然后重新开始录制。")
        }

        let wantMic = o.mic && o.mode != "screen"
        var micOK = false
        if wantMic {
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: micOK = true
            case .notDetermined: micOK = await AVCaptureDevice.requestAccess(for: .audio)
            default: micOK = false
            }
            if !micOK { warnings.append("没有麦克风权限,这次不录你自己的声音。可在「系统设置 → 隐私与安全性 → 麦克风」里打开「录制助手」。") }
        }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            fail("读取屏幕内容失败:\(error.localizedDescription)")
            return
        }

        let filter: SCContentFilter
        if let wid = o.windowID, o.mode != "audio" {
            guard let w = content.windows.first(where: { $0.windowID == wid }) else {
                fail("找不到要录制的窗口(可能已经关闭),请刷新列表重选。"); return
            }
            filter = SCContentFilter(desktopIndependentWindow: w)
        } else {
            let did = o.displayID ?? CGMainDisplayID()
            guard let d = content.displays.first(where: { $0.displayID == did }) ?? content.displays.first else {
                fail("没有找到可录制的屏幕。"); return
            }
            // 不录助手自己(它没有窗口,只是保险)
            let me = content.applications.filter { $0.processID == getpid() }
            filter = SCContentFilter(display: d, excludingApplications: me, exceptingWindows: [])
        }

        let cfg = SCStreamConfiguration()
        if o.mode == "audio" {
            // 仅声音:画面压到最小、1 秒一帧,直接丢弃
            cfg.width = 64; cfg.height = 64
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        } else {
            // 长边不超过 1920,兼顾清晰度和体积
            let scale = CGFloat(filter.pointPixelScale)
            var w = filter.contentRect.width * scale, h = filter.contentRect.height * scale
            let longest = max(w, h)
            if longest > 1920 { w = w * 1920 / longest; h = h * 1920 / longest }
            cfg.width = max(2, Int(w) / 2 * 2)
            cfg.height = max(2, Int(h) / 2 * 2)
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            cfg.showsCursor = true
            cfg.queueDepth = 6
        }
        cfg.capturesAudio = o.mode != "screen"
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        cfg.excludesCurrentProcessAudio = true
        cfg.captureMicrophone = wantMic && micOK

        let dir = URL(fileURLWithPath: o.out)
        if o.mode != "audio" { video = TrackWriter(kind: .video, url: dir.appendingPathComponent("screen.mp4")) }
        if cfg.capturesAudio { system = TrackWriter(kind: .audio, url: dir.appendingPathComponent("system.m4a")) }
        if cfg.captureMicrophone { mic = TrackWriter(kind: .audio, url: dir.appendingPathComponent("mic.m4a")) }

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            if cfg.capturesAudio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
            if cfg.captureMicrophone { try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
            try await s.startCapture()
        } catch {
            fail("开始录制失败:\(error.localizedDescription)"); return
        }
        stream = s
        queue.sync {
            t0 = hostNow()
            state = "recording"
        }
        writeStatus()
        log("录制开始 mode=\(o.mode) mic=\(cfg.captureMicrophone)")
    }

    // 暂停区间内的帧丢掉,之后的帧整体往前挪,文件里看不出暂停
    func offsetFor(_ pts: CMTime) -> CMTime? {
        guard t0.isValid, pts >= t0 else { return nil }
        if let ps = pauseStart, pts >= ps { return nil }
        var off = CMTime.zero
        for p in pauses {
            if pts >= p.start && pts < p.end { return nil }
            if pts >= p.end { off = off + (p.end - p.start) }
        }
        return off
    }

    func retimed(_ sb: CMSampleBuffer, by off: CMTime) -> CMSampleBuffer? {
        if off == .zero { return sb }
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        var infos = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .invalid, decodeTimeStamp: .invalid), count: count)
        CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: count, arrayToFill: &infos, entriesNeededOut: &count)
        for i in infos.indices {
            infos[i].presentationTimeStamp = infos[i].presentationTimeStamp - off
            if infos[i].decodeTimeStamp.isValid { infos[i].decodeTimeStamp = infos[i].decodeTimeStamp - off }
        }
        var out: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sb, sampleTimingEntryCount: count, sampleTimingArray: &infos, sampleBufferOut: &out)
        return out
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopping, CMSampleBufferDataIsReady(sb) else { return }
        let target: TrackWriter?
        switch type {
        case .screen:
            guard let video else { return }
            // 只要完整帧;画面静止时 ScreenCaptureKit 发的是 idle 帧,没有图像
            guard let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = atts.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
                  CMSampleBufferGetImageBuffer(sb) != nil else { return }
            target = video
        case .audio: target = system
        case .microphone: target = mic
        @unknown default: return
        }
        guard let target, let off = offsetFor(CMSampleBufferGetPresentationTimeStamp(sb)),
              let buf = retimed(sb, by: off) else { return }
        target.append(buf, sessionStart: t0)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("录制被中断: \(error)")
        warnings.append("录制被系统中断:\(error.localizedDescription)")
        stop()
    }

    // ---------- 控制 ----------
    func togglePause() {
        queue.async { [self] in
            guard state == "recording" || state == "paused" else { return }
            let now = hostNow()
            if let ps = pauseStart {
                pauses.append((ps, now)); pauseStart = nil; state = "recording"
            } else {
                pauseStart = now; state = "paused"
            }
            DispatchQueue.main.async { self.writeStatus(); StatusBar.shared.refresh() }
        }
    }

    func mark() {
        queue.async { [self] in
            guard state == "recording" || state == "paused" else { return }
            markers.append((elapsed() * 10).rounded() / 10)
            DispatchQueue.main.async { self.writeStatus(); StatusBar.shared.refresh(); NSSound(named: "Tink")?.play() }
        }
    }

    func stop() {
        queue.async { [self] in
            guard !stopping else { return }
            stopping = true
            let duration = elapsed()
            guard let s = stream else { finishFiles(duration: duration); return }
            s.stopCapture { _ in self.queue.async { self.finishFiles(duration: duration) } }
        }
    }

    private func finishFiles(duration: Double) {
        let group = DispatchGroup()
        var files: [String: String] = [:]
        let lock = NSLock()
        for (key, w) in [("screen", video), ("system", system), ("mic", mic)] {
            guard let w else { continue }
            group.enter()
            w.finish { ok in
                if ok { lock.lock(); files[key] = w.url.lastPathComponent; lock.unlock() }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            self.state = "finished"
            if self.mic != nil && files["mic"] == nil { self.warnings.append("麦克风没有录到声音。") }
            self.writeStatus(extra: ["files": files, "durationSec": duration])
            log("录制结束 \(Int(duration)) 秒 \(files)")
            exit(0)
        }
    }
}

// ---------- 菜单栏 ----------
final class StatusBar: NSObject {
    static let shared = StatusBar()
    var item: NSStatusItem?
    var pauseItem: NSMenuItem?
    var markItem: NSMenuItem?
    var timer: Timer?
    var lastWrite = Date.distantPast

    func setup() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        let p = NSMenuItem(title: "暂停 (⌃⌥⌘P)", action: #selector(onPause), keyEquivalent: "")
        let m = NSMenuItem(title: "打点 (⌃⌥⌘M)", action: #selector(onMark), keyEquivalent: "")
        let s = NSMenuItem(title: "停止录制 (⌃⌥⌘S)", action: #selector(onStop), keyEquivalent: "")
        for i in [p, m, s] { i.target = self }
        menu.addItem(p); menu.addItem(m); menu.addItem(.separator()); menu.addItem(s)
        item.menu = menu
        self.item = item; pauseItem = p; markItem = m
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    func tick() {
        refresh()
        // 每秒刷新一次状态文件,网页靠它显示时长
        if Date().timeIntervalSince(lastWrite) >= 1 {
            lastWrite = Date()
            let r = Recorder.shared
            if r.state == "recording" || r.state == "paused" { r.writeStatus() }
        }
    }

    func refresh() {
        let r = Recorder.shared
        let t = Int(r.elapsed())
        let full = t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%02d:%02d", t / 60, t % 60)
        let paused = r.state == "paused"
        let title = NSMutableAttributedString(string: paused ? "⏸ " : "● ", attributes: [.foregroundColor: paused ? NSColor.systemOrange : NSColor.systemRed])
        title.append(NSAttributedString(string: r.state == "starting" ? "启动中" : full, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)]))
        item?.button?.attributedTitle = title
        pauseItem?.title = paused ? "继续 (⌃⌥⌘P)" : "暂停 (⌃⌥⌘P)"
        markItem?.title = r.markers.isEmpty ? "打点 (⌃⌥⌘M)" : "打点 (⌃⌥⌘M) · 已打 \(r.markers.count) 个"
    }

    @objc func onPause() { Recorder.shared.togglePause() }
    @objc func onMark() { Recorder.shared.mark() }
    @objc func onStop() { Recorder.shared.stop() }
}

// ---------- 全局快捷键(Carbon,不需要辅助功能权限) ----------
var hotKeyRefs: [EventHotKeyRef?] = []

func registerHotKeys() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
        var hk = EventHotKeyID()
        GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
        DispatchQueue.main.async {
            switch hk.id {
            case 1: Recorder.shared.togglePause()
            case 2: Recorder.shared.mark()
            case 3: Recorder.shared.stop()
            default: break
            }
        }
        return noErr
    }, 1, &spec, nil, nil)
    let mods = UInt32(controlKey | optionKey | cmdKey)
    for (id, key) in [(1, kVK_ANSI_P), (2, kVK_ANSI_M), (3, kVK_ANSI_S)] {
        var ref: EventHotKeyRef?
        let st = RegisterEventHotKey(UInt32(key), mods, EventHotKeyID(signature: OSType(0x4D524543), id: UInt32(id)), GetApplicationEventTarget(), 0, &ref)
        if st != noErr { Recorder.shared.warnings.append("快捷键 \(id) 被其他应用占用") }
        hotKeyRefs.append(ref)
    }
}

// ---------- 信号(server.ts 用它控制) ----------
var signalSources: [DispatchSourceSignal] = []

func listenSignals() {
    let handlers: [(Int32, () -> Void)] = [
        (SIGUSR1, { Recorder.shared.togglePause() }),
        (SIGUSR2, { Recorder.shared.mark() }),
        (SIGINT, { Recorder.shared.stop() }),
        (SIGTERM, { Recorder.shared.stop() }),
    ]
    for (sig, h) in handlers {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler(handler: h)
        src.resume()
        signalSources.append(src)
    }
}

// ---------- 列出屏幕和窗口 ----------
func listSources(out: String) async {
    var result: [String: Any] = [:]
    if !CGPreflightScreenCaptureAccess() {
        CGRequestScreenCaptureAccess()
        result["error"] = "no-permission"
        writeJSON(result, to: out)
        return
    }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let names: [CGDirectDisplayID: String] = Dictionary(uniqueKeysWithValues: NSScreen.screens.compactMap { s in
            (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber).map { ($0.uint32Value, s.localizedName) }
        })
        result["mainDisplay"] = Int(CGMainDisplayID())
        result["displays"] = content.displays.map { d -> [String: Any] in
            ["id": Int(d.displayID), "name": names[d.displayID] ?? "屏幕 \(d.displayID)", "width": d.width, "height": d.height]
        }
        let skip: Set<String> = ["com.apple.dock", "com.apple.controlcenter", "com.apple.WindowManager", "com.apple.notificationcenterui", "com.apple.Spotlight"]
        result["windows"] = content.windows.filter { w in
            guard let app = w.owningApplication, w.windowLayer == 0, w.isOnScreen,
                  w.frame.width >= 200, w.frame.height >= 150, !skip.contains(app.bundleIdentifier),
                  app.processID != getpid() else { return false }
            return true
        }.map { w -> [String: Any] in
            ["id": Int(w.windowID), "app": w.owningApplication?.applicationName ?? "", "title": w.title ?? "", "width": Int(w.frame.width), "height": Int(w.frame.height)]
        }
    } catch {
        result["error"] = error.localizedDescription
    }
    writeJSON(result, to: out)
}

// ---------- 入口 ----------
let opts = parseOptions()
guard !opts.out.isEmpty else { log("缺少 --out"); exit(2) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

if opts.list {
    Task { await listSources(out: opts.out); exit(0) }
} else {
    listenSignals()
    registerHotKeys()
    StatusBar.shared.setup()
    Task { await Recorder.shared.start(opts) }
}
app.run()
