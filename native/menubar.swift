import AppKit
import Carbon.HIToolbox
import CoreAudio
import Foundation

// 会议录音纪要.app 的本体:常驻菜单栏。
// - 启动后台服务(bun run server.ts)、打开主窗口,定时 ping 让服务一直在
// - 菜单里开始 / 停止录制,全局快捷键 ⌃⌥⌘R
// - 检测会议软件开始用麦克风 → 右上角提醒要不要录;录制中会议软件停用麦克风 → 提醒停止
// 由 build-app.sh 编译,项目目录写在 Info.plist 的 MRProjectDir 里。

let PORT = 3456
let BASE = "http://127.0.0.1:\(PORT)"
let projectDir = Bundle.main.object(forInfoDictionaryKey: "MRProjectDir") as? String ?? ""
let logPath = NSHomeDirectory() + "/Library/Logs/meeting-recorder.log"
let launchAgentPath = NSHomeDirectory() + "/Library/LaunchAgents/local.meeting-recorder.menubar.plist"
let defaults = UserDefaults.standard

func log(_ s: String) {
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] [菜单栏] \(s)\n"
    if let h = FileHandle(forWritingAtPath: logPath) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
    } else {
        FileManager.default.createFile(atPath: logPath, contents: line.data(using: .utf8))
    }
}

// ---------- 设置 ----------
var remindEnabled: Bool {
    get { defaults.object(forKey: "remindMeetings") as? Bool ?? true }
    set { defaults.set(newValue, forKey: "remindMeetings") }
}
var hotkeyMode: String {
    get { defaults.string(forKey: "hotkeyMode") ?? "both" }
    set { defaults.set(newValue, forKey: "hotkeyMode") }
}
let MODE_NAME = ["both": "录屏 + 声音", "audio": "仅声音"]

// ---------- 用户的 PATH ----------
// 从 Finder 启动时 PATH 很短,找不到 ffmpeg / claude。读一次登录 shell 的 PATH,再补上常见位置。
let userPATH: String = {
    var found = ""
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-ilc", "printf '__P__%s__E__' \"$PATH\""]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    var buf = Data()
    let lock = NSLock()
    pipe.fileHandleForReading.readabilityHandler = { h in
        let d = h.availableData
        lock.lock(); buf.append(d); lock.unlock()
    }
    if (try? p.run()) != nil {
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            lock.lock(); let s = String(data: buf, encoding: .utf8) ?? ""; lock.unlock()
            if let r = s.range(of: "__P__"), let e = s.range(of: "__E__", range: r.upperBound..<s.endIndex) {
                found = String(s[r.upperBound..<e.lowerBound]); break
            }
            usleep(50_000)
        }
        if p.isRunning { p.terminate() }
    }
    pipe.fileHandleForReading.readabilityHandler = nil
    let home = NSHomeDirectory()
    let extra = ["\(home)/.local/bin", "\(home)/.bun/bin", "\(home)/.deskclaw/node/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    var seen = Set<String>()
    return (found.split(separator: ":").map(String.init) + extra).filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
}()

// ---------- HTTP ----------
func api(_ method: String, _ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 5,
         done: @escaping ([String: Any]?, String?) -> Void) {
    var req = URLRequest(url: URL(string: BASE + path)!, timeoutInterval: timeout)
    req.httpMethod = method
    if let body {
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    URLSession.shared.dataTask(with: req) { data, resp, err in
        let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let msg: String? = err != nil ? err!.localizedDescription : (code >= 400 ? (obj?["error"] as? String ?? "HTTP \(code)") : nil)
        DispatchQueue.main.async { done(obj, msg) }
    }.resume()
}

// ---------- 后台服务 ----------
final class Server {
    static var starting = false
    static var waiters: [(Bool) -> Void] = []
    static var lastFailure: Date?

    static func ping(_ done: @escaping (Bool) -> Void) {
        api("GET", "/api/ping", timeout: 1) { _, err in done(err == nil) }
    }

    static func findBun() -> String? {
        let home = NSHomeDirectory()
        let candidates = ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"] +
            userPATH.split(separator: ":").map { "\($0)/bun" }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // 服务没在跑就启动它,好了以后回调
    static func ensure(_ done: @escaping (Bool) -> Void) {
        ping { ok in
            if ok { lastFailure = nil; done(true); return }
            // 刚失败过就先别反复重启,1 分钟后再试
            if !starting, let f = lastFailure, Date().timeIntervalSince(f) < 60 { done(false); return }
            waiters.append(done)
            if starting { return }
            starting = true
            launch()
        }
    }

    private static func launch() {
        func finish(_ ok: Bool) {
            starting = false
            lastFailure = ok ? nil : Date()
            let w = waiters; waiters = []
            w.forEach { $0(ok) }
        }
        guard FileManager.default.fileExists(atPath: projectDir + "/server.ts") else {
            alert("找不到项目目录", "\(projectDir)\n请在项目目录里重新运行 build-app.sh。"); finish(false); return
        }
        guard let bun = findBun() else {
            alert("没找到 Bun", "请先在终端运行:\ncurl -fsSL https://bun.sh/install | bash"); finish(false); return
        }
        // 从 Finder 启动时文件描述符上限只有 256,bun 会起不来
        var lim = rlimit()
        if getrlimit(RLIMIT_NOFILE, &lim) == 0 { lim.rlim_cur = min(10240, lim.rlim_max); setrlimit(RLIMIT_NOFILE, &lim) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = userPATH
        env["APP_MODE"] = "1"
        p.environment = env
        // 没有 stdin 时 bun 会报 Unexpected,必须接到 /dev/null
        p.standardInput = FileHandle.nullDevice
        if !FileManager.default.fileExists(atPath: logPath) { FileManager.default.createFile(atPath: logPath, contents: nil) }
        if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
        var args = ["run", "server.ts"]
        if !FileManager.default.fileExists(atPath: projectDir + "/node_modules") { args = ["install"] } // 第一次先装依赖
        p.arguments = args
        do { try p.run() } catch { alert("服务启动失败", error.localizedDescription); finish(false); return }
        if args == ["install"] {
            p.waitUntilExit()
            launch(); return
        }
        log("已启动服务 pid=\(p.processIdentifier)")
        var tries = 0
        func poll() {
            ping { ok in
                if ok { finish(true); return }
                tries += 1
                if !p.isRunning {
                    log("服务进程退出了,退出码 \(p.terminationStatus)")
                    Reminder.show(title: "后台服务没能启动", text: "日志在 ~/Library/Logs/meeting-recorder.log。1 分钟后会自动再试。", buttons: [("知道了", {})], timeout: 30)
                    finish(false); return
                }
                // 等 40 秒:第一次运行时 macOS 会弹「允许访问桌面文件夹」,要给用户时间点
                if tries > 160 {
                    log("服务 40 秒没响应,结束它")
                    p.terminate()
                    Reminder.show(title: "后台服务卡住了", text: "多半是在等系统的权限弹窗(「会议录音纪要」想访问「桌面」文件夹)。请在弹窗里点「允许」,1 分钟后会自动再试。", buttons: [("知道了", {})], timeout: 60)
                    finish(false); return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: poll)
            }
        }
        poll()
    }
}

func alert(_ title: String, _ text: String) {
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.addButton(withTitle: "好")
    a.runModal()
}

// ---------- 主窗口 ----------
func openMainWindow() {
    Server.ensure { ok in
        guard ok else { return }
        let url = BASE + "/"
        let home = NSHomeDirectory()
        let browsers = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                        "\(home)/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        if let b = browsers.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: b)
            p.arguments = ["--app=\(url)", "--window-size=1280,860"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            if (try? p.run()) != nil { return }
        }
        NSWorkspace.shared.open(URL(string: url)!)
    }
}

// ---------- 谁在用麦克风(CoreAudio,不需要权限) ----------
// 只认会议类软件;前缀匹配,这样 xxx.helper 之类的子进程也算
let MEETING_APPS: [(String, String)] = [
    ("us.zoom.xos", "Zoom"), ("com.tencent.meeting", "腾讯会议"), ("com.tencent.xinWeChat", "微信"), ("com.tencent.qq", "QQ"),
    ("com.larksuite.larkApp", "飞书"), ("com.bytedance.lark", "飞书"), ("com.electron.lark", "飞书"),
    ("com.alibaba.DingTalkMac", "钉钉"), ("com.microsoft.teams2", "Teams"), ("com.microsoft.teams", "Teams"),
    ("com.cisco.webexmeetingsapp", "Webex"), ("Cisco-Systems.Spark", "Webex"), ("com.apple.FaceTime", "FaceTime"),
    ("com.tinyspeck.slackmacgap", "Slack"), ("com.hnc.Discord", "Discord"), ("com.skype.skype", "Skype"),
    ("com.google.Chrome", "Chrome 里的网页会议"), ("com.microsoft.edgemac", "Edge 里的网页会议"),
    ("company.thebrowser.Browser", "Arc 里的网页会议"), ("org.mozilla.firefox", "Firefox 里的网页会议"),
    ("com.apple.WebKit.GPU", "Safari 里的网页会议"),
]

func caProp<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ def: T) -> T {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v = def
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : def
}

func meetingAppsUsingMic() -> Set<String> {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let sys = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    var names = Set<String>()
    for id in ids where caProp(id, kAudioProcessPropertyIsRunningInput, UInt32(0)) != 0 {
        var bAddr = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var cf: Unmanaged<CFString>?
        var s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &bAddr, 0, nil, &s, &cf) == noErr, let bundle = cf?.takeRetainedValue() as String? else { continue }
        if let hit = MEETING_APPS.first(where: { bundle == $0.0 || bundle.hasPrefix($0.0 + ".") }) { names.insert(hit.1) }
    }
    return names
}

// ---------- 右上角提醒 ----------
final class ClosureButton: NSButton {
    var onClick: (() -> Void)?
    convenience init(title: String, primary: Bool, onClick: @escaping () -> Void) {
        self.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded
        controlSize = .regular
        if primary { keyEquivalent = "\r" }
        self.onClick = onClick
        target = self
        action = #selector(fire)
    }
    @objc func fire() { onClick?() }
}

final class Reminder {
    static var panel: NSPanel?
    static var hideWork: DispatchWorkItem?
    static var isShown: Bool { panel?.isVisible == true }

    static func show(title: String, text: String, buttons: [(String, () -> Void)], timeout: TimeInterval = 40) {
        hide()
        let w: CGFloat = 340
        let title1 = NSTextField(labelWithString: title)
        title1.font = .systemFont(ofSize: 14, weight: .semibold)
        let body = NSTextField(wrappingLabelWithString: text)
        body.font = .systemFont(ofSize: 12.5)
        body.textColor = .secondaryLabelColor
        body.preferredMaxLayoutWidth = w - 32
        let row = NSStackView(views: buttons.enumerated().map { i, b in
            ClosureButton(title: b.0, primary: i == 0) { hide(); b.1() }
        })
        row.spacing = 8
        let stack = NSStackView(views: [title1, body, row])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)

        let fx = NSVisualEffectView()
        fx.material = .popover
        fx.state = .active
        fx.wantsLayer = true
        fx.layer?.cornerRadius = 12
        fx.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: fx.leadingAnchor), stack.trailingAnchor.constraint(equalTo: fx.trailingAnchor),
            stack.topAnchor.constraint(equalTo: fx.topAnchor), stack.bottomAnchor.constraint(equalTo: fx.bottomAnchor),
            fx.widthAnchor.constraint(equalToConstant: w),
        ])
        fx.layoutSubtreeIfNeeded()
        let h = fx.fittingSize.height

        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let p = NSPanel(contentRect: NSRect(x: screen.maxX - w - 16, y: screen.maxY - h - 12, width: w, height: h),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.isMovableByWindowBackground = true
        p.contentView = fx
        p.orderFrontRegardless()
        panel = p
        NSSound(named: "Glass")?.play()
        let work = DispatchWorkItem { hide() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: work)
    }

    static func hide() {
        hideWork?.cancel()
        panel?.orderOut(nil)
        panel = nil
    }
}

// 开会提醒的文案:先问服务「上次会议定的事做完几件」,拿到就加在前面
func meetingPromptText(_ done: @escaping (String) -> Void) {
    let base = "要录下来吗?录完会自动转写成逐字稿。"
    api("GET", "/api/briefing", timeout: 1.5) { obj, _ in
        if let line = obj?["line"] as? String, !line.isEmpty, obj?["lastMeeting"] != nil, !(obj?["lastMeeting"] is NSNull) {
            done("📊 " + line + "\n" + base)
        } else {
            done(base)
        }
    }
}

// ---------- 主控 ----------
final class Controller: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var item: NSStatusItem!
    var recording = false
    var recState = ""
    var recElapsed = 0.0
    var serverUp = false

    // 会议检测状态
    var activeSince: [String: Date] = [:]
    var lastSeen: [String: Date] = [:]
    var reminded = Set<String>()      // 这次会话已经提醒过的软件
    var recordingFor: String?         // 这次录制对应的会议软件
    var goneSince: Date?
    var endReminded = false

    func applicationDidFinishLaunching(_ n: Notification) {
        // 有刘海的 MacBook 上,新图标会排到最左边、被刘海挡住看不见。
        // 第一次运行时把位置预设在靠右(离屏幕右边缘约 300 点);之后用户 ⌘ 拖动调整的位置系统会记住。
        let posKey = "NSStatusItem Preferred Position MRMain"
        if defaults.object(forKey: posKey) == nil { defaults.set(300, forKey: posKey) }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = "MRMain"
        let img = NSImage(systemSymbolName: "waveform.circle", accessibilityDescription: "会议录音纪要")
        img?.isTemplate = true
        item.button?.image = img
        item.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu

        registerHotKey()
        // 服务一直开着:自动导入语音备忘录、后台转写队列都在服务里跑
        // 开机自启(--background)时只常驻,不弹窗口
        if CommandLine.arguments.contains("--background") { Server.ensure { _ in } } else { openMainWindow() }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
        // 每 10 秒 ping 一次(服务看到 ping 就不会自己退出);服务意外退出就重新拉起
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in Server.ensure { _ in } }
        log("菜单栏已启动 PATH=\(userPATH)")
        // 调试用:启动时弹一次提醒,看样式
        if CommandLine.arguments.contains("--demo-reminder") {
            Server.ensure { _ in
                meetingPromptText { text in
                    Reminder.show(title: "腾讯会议 好像在开会", text: text, buttons: [
                        ("录屏 + 声音", {}), ("仅声音", {}), ("不用", {}),
                    ], timeout: 15)
                }
            }
        }
    }

    // 再次双击 App 图标:打开主窗口
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openMainWindow(); return false
    }

    // ---------- 菜单 ----------
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func add(_ title: String, _ sel: Selector?, key: String = "", state: Bool = false, enabled: Bool = true, rep: Any? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.target = self
            i.state = state ? .on : .off
            i.isEnabled = enabled && sel != nil
            i.representedObject = rep
            menu.addItem(i)
            return i
        }
        _ = add("打开主窗口", #selector(onOpen))
        menu.addItem(.separator())
        if recording {
            let t = Int(recElapsed)
            _ = add("● \(recState == "paused" ? "已暂停" : "录制中") \(String(format: "%02d:%02d", t / 60, t % 60))", nil, enabled: false)
            _ = add("停止录制 (⌃⌥⌘R)", #selector(onStop))
        } else {
            _ = add("开始录制:录屏 + 声音\(hotkeyMode == "both" ? " (⌃⌥⌘R)" : "")", #selector(onStart(_:)), rep: "both")
            _ = add("开始录制:仅声音\(hotkeyMode == "audio" ? " (⌃⌥⌘R)" : "")", #selector(onStart(_:)), rep: "audio")
        }
        menu.addItem(.separator())
        let sub = NSMenu()
        for m in ["both", "audio"] {
            let i = NSMenuItem(title: MODE_NAME[m]!, action: #selector(onHotkeyMode(_:)), keyEquivalent: "")
            i.target = self; i.representedObject = m; i.state = hotkeyMode == m ? .on : .off
            sub.addItem(i)
        }
        let hk = add("⌃⌥⌘R 的录制方式", nil)
        hk.isEnabled = true
        hk.submenu = sub
        _ = add("开会时提醒我录制", #selector(onToggleRemind), state: remindEnabled)
        _ = add("登录时自动启动", #selector(onToggleLogin), state: FileManager.default.fileExists(atPath: launchAgentPath))
        menu.addItem(.separator())
        _ = add("退出", #selector(onQuit), key: "q")
    }

    @objc func onOpen() { openMainWindow() }
    @objc func onStart(_ sender: NSMenuItem) { startRecording(mode: sender.representedObject as? String ?? "both", app: nil) }
    @objc func onStop() { stopRecording() }
    @objc func onHotkeyMode(_ sender: NSMenuItem) { hotkeyMode = sender.representedObject as? String ?? "both" }
    @objc func onToggleRemind() { remindEnabled.toggle() }
    @objc func onQuit() { NSApp.terminate(nil) }

    @objc func onToggleLogin() {
        let fm = FileManager.default
        if fm.fileExists(atPath: launchAgentPath) {
            try? fm.removeItem(atPath: launchAgentPath)
            return
        }
        let plist: [String: Any] = [
            "Label": "local.meeting-recorder.menubar",
            "ProgramArguments": ["/usr/bin/open", "-g", "-a", Bundle.main.bundlePath, "--args", "--background"],
            "RunAtLoad": true,
        ]
        try? fm.createDirectory(atPath: (launchAgentPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
            fm.createFile(atPath: launchAgentPath, contents: data)
        }
    }

    // ---------- 录制 ----------
    func startRecording(mode: String, app: String?) {
        Server.ensure { ok in
            guard ok else { return }
            var body: [String: Any] = ["mode": mode, "mic": true]
            if let app { body["title"] = "\(app) 会议 \(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short))" }
            api("POST", "/api/record/start", body: body, timeout: 15) { _, err in
                if let err { alert("没能开始录制", err); return }
                self.recording = true
                self.recState = "starting"
                self.recordingFor = app ?? self.activeSince.keys.first
                self.goneSince = nil
                self.endReminded = false
                self.updateIcon()
            }
        }
    }

    func stopRecording() {
        api("POST", "/api/record/stop") { _, err in
            if let err { alert("停止失败", err) }
        }
    }

    func updateIcon() {
        let name = recording ? "record.circle.fill" : "waveform.circle"
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "会议录音纪要")
        img?.isTemplate = !recording
        item.button?.image = recording ? img?.withSymbolConfiguration(.init(paletteColors: [.systemRed])) : img
    }

    // ---------- 每 2 秒:录制状态 + 会议检测 ----------
    func tick() {
        api("GET", "/api/record/status", timeout: 1.5) { obj, err in
            self.serverUp = err == nil
            let wasRecording = self.recording
            self.recording = (obj?["active"] as? Bool) ?? false
            self.recState = obj?["state"] as? String ?? ""
            self.recElapsed = obj?["elapsed"] as? Double ?? 0
            if wasRecording != self.recording {
                self.updateIcon()
                if self.recording, self.recordingFor == nil { self.recordingFor = self.activeSince.keys.first }
                if !self.recording { self.recordingFor = nil; if Reminder.isShown { Reminder.hide() } }
            }
            self.detectMeetings()
        }
    }

    func detectMeetings() {
        let now = Date()
        let using = meetingAppsUsingMic()
        for n in using {
            if activeSince[n] == nil { activeSince[n] = now; log("检测到 \(n) 开始用麦克风") }
            lastSeen[n] = now
        }
        // 停用麦克风超过 60 秒才算这次会议结束,中间闭麦一会儿不算
        for n in Array(activeSince.keys) where !using.contains(n) {
            if now.timeIntervalSince(lastSeen[n] ?? now) > 60 { activeSince[n] = nil; reminded.remove(n) }
        }

        if !recording {
            guard remindEnabled, !Reminder.isShown,
                  let n = using.first(where: { now.timeIntervalSince(activeSince[$0] ?? now) >= 4 && !reminded.contains($0) }) else { return }
            reminded.insert(n)
            meetingPromptText { text in
                guard !Reminder.isShown else { return }
                Reminder.show(title: "\(n) 好像在开会", text: text, buttons: [
                    ("录屏 + 声音", { self.startRecording(mode: "both", app: n) }),
                    ("仅声音", { self.startRecording(mode: "audio", app: n) }),
                    ("不用", {}),
                ])
            }
            return
        }

        // 录制中:对应的会议软件停用麦克风 20 秒,提醒停止
        guard let app = recordingFor, recState == "recording" else { return }
        if using.contains(app) { goneSince = nil; return }
        if goneSince == nil { goneSince = now }
        if !endReminded, now.timeIntervalSince(goneSince!) >= 20 {
            endReminded = true
            Reminder.show(title: "会议好像结束了", text: "\(app) 已经停止使用麦克风。要停止录制吗?", buttons: [
                ("停止录制", { self.stopRecording() }),
                ("继续录", {}),
            ], timeout: 120)
        }
    }

    // ---------- 全局快捷键 ⌃⌥⌘R ----------
    var hotKeyRef: EventHotKeyRef?
    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
            DispatchQueue.main.async { controller.onHotKey() }
            return noErr
        }, 1, &spec, nil, nil)
        let st = RegisterEventHotKey(UInt32(kVK_ANSI_R), UInt32(controlKey | optionKey | cmdKey),
                                     EventHotKeyID(signature: OSType(0x4D52_4D42), id: 1), GetApplicationEventTarget(), 0, &hotKeyRef)
        if st != noErr { log("⌃⌥⌘R 注册失败,可能被其他应用占用") }
    }

    func onHotKey() {
        if recording { stopRecording() } else { startRecording(mode: hotkeyMode, app: activeSince.keys.first) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = Controller()
app.delegate = controller
app.run()
