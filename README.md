# 会议录音纪要 Meeting Recorder

在 Mac 上录下会议的画面和声音(三种模式可选,麦克风和线上会议对方的声音分两轨保存),用 macOS 自带的语音识别离线转写成区分「我 / 嘉宾」的逐字稿,再用你自己的 Claude 账号生成结构化会议纪要。
不需要任何 API Key,录音、转写和纪要全部保存在本机。

```
录制(录制助手.app,ScreenCaptureKit)──► 本地服务(Bun + ffmpeg)──► 转写(macOS 本地识别 / Whisper 接口)──► 纪要(Claude Code 账号 / Anthropic API)
```

## 功能

- 🎬 三种录制模式:录屏 + 声音 / 仅声音 / 仅录屏,范围可选整个屏幕或单个窗口
- 🎧 原生录制(ScreenCaptureKit),直接录到 Zoom / 腾讯会议 / 飞书里对方的声音,不用装虚拟声卡
- 👥 麦克风(我)和系统声音(嘉宾)分轨保存,逐字稿自动标注说话人
- 📍 录制中打点标记重要时刻,纪要会重点整理这些位置;点打点直接跳到对应画面
- ⏸️ 菜单栏计时,全局快捷键 ⌃⌥⌘P 暂停 / ⌃⌥⌘M 打点 / ⌃⌥⌘S 停止,录制时可以关掉主窗口
- 📁 导入已有录音或视频文件,可以一次选多个;浏览器放不了的格式(aiff / wma / amr / avi / mkv …)自动转换
- 🎙️ 导入「语音备忘录」App 的录音,可以开自动导入:iPhone 上录完,iCloud 同步到 Mac 后自动导入 → 转写 → 分析
- 📋 后台任务队列:录制、导入后自动转写,可选转写完自动用默认模板分析;多条记录一起批量分析
- 🔍 全文搜索:跨所有记录搜标题、逐字稿和分析结果,点结果直接跳到那一句
- 💬 问资料库:用一句话问所有会议(「最近几场关于选品说过什么?」),回答带出处,点出处跳到那场会议的那一句,可以追问
- 🏷️ 说话人改名:「我」「嘉宾」换成真实名字,录制前就能填;设置里填「我的名字」后每次录制自动用;名字自动加进词库
- 🎞️ 导出 SRT 字幕(按标点切成短句,可带说话人),直接拖进剪映
- ✨ 自动起标题:没填标题、文件名是「新录音 3」「IMG_7982」这类的,转写完让 Claude 根据内容起一个(用小模型);标题旁的「起标题」按钮可以随时重起
- ⏱️ 少于 5 秒的录制当作误触,自动放进「最近删除」
- 📖 逐字稿阅读模式:说话人分颜色,点一句从那里播放,播放时当前句高亮并跟着滚动;需要改时切到「编辑」
- ☁️ 备份到 iCloud 云盘:默认只备份文字,可选带上音频或视频;增量同步,改动后约 1 分钟自动备份,能从备份恢复
- 🗑️ 删除:单条或多选删除,先进「最近删除」保留 30 天可恢复;也可以只删视频留音频,或删掉所有录音只留文字,省空间
- 📥 导出的 .md / .srt / 导图图片直接存进「下载」文件夹并在访达里选中
- 🔒 服务只监听本机(127.0.0.1),同一 Wi-Fi 下的其他设备访问不到;其他网站的跨站请求会被拒绝
- 📌 菜单栏常驻:⌃⌥⌘R 一键开始 / 停止录制;腾讯会议、Zoom、飞书、钉钉、微信、Teams、网页会议开始用麦克风时右上角提醒「要录吗」,会议软件停用麦克风后提醒停止;可设登录时自动启动
- 🔒 转写默认走 macOS 26 自带的 SpeechAnalyzer,完全离线、免费、不限时长
- 👤 纪要默认用本机登录的 Claude Code 账号,不用买 API Key
- ✍️ 转写带时间戳,可以手动修正后再生成纪要
- 🧩 分析模板系统:逐字稿整理、思维导图、会议摘要、会议纪要、高光片段、内容二次加工、问答提取、嘉宾版纪要、讲解复盘;可勾选多个一次跑完,模板可在界面里新建 / 编辑 / 复制
- 🗺️ 思维导图用 Markmap 渲染,可缩放拖动,导出 SVG / PNG
- 📖 专有名词词库:转写时提示给识别器,转写后按「常见错写」自动替换,分析时 Claude 也按词库纠正
- 🔗 结果里的时间戳 [mm:ss] 可点,播放器直接跳过去
- ⚡ 纪要流式输出,边生成边显示
- 💾 一键复制纪要、下载 Markdown
- 🔌 两步都可以换成云端:Whisper 兼容接口(Groq / OpenAI / 硅基流动)、Anthropic API

## 安装

需要:macOS 26+(本机识别;录制需要 macOS 15+)、[Bun](https://bun.sh)、ffmpeg、Chrome、[Claude Code](https://claude.com/claude-code)。

```bash
git clone https://github.com/bianzigege/meeting-recorder.git
cd meeting-recorder
bun install
./build-app.sh
```

`build-app.sh` 会编译本地转写程序、录制助手和菜单栏程序,并把 **会议录音纪要.app** 安装到 `~/Applications`(Finder 里「前往 → 个人 → Applications」)。
双击打开后它常驻在菜单栏(波形图标),主窗口关掉也没关系,随时从菜单栏图标「打开主窗口」。菜单里选「退出」才会真正退出。

> 不要把 .app 移到桌面、文稿、下载这几个受系统保护的文件夹,从 Finder 启动时子进程会读不到项目文件而启动失败。项目目录本身放在桌面没关系。

让 Claude Code 命令行登录一次(用你的 Claude 订阅账号):

```bash
claude auth login
```

之后应用里「设置 → 纪要」会显示「已登录」。

不想做成应用的话,也可以直接 `bun run start` 然后打开 http://localhost:3456。

## 使用流程

1. **录制**:选模式和录制范围,点「开始录制」。第一次会弹出屏幕录制和麦克风权限,允许「录制助手」即可
   (屏幕录制权限打开后要重新点一次开始)。菜单栏出现红点计时后,主窗口可以关掉。
2. **停止**:点「停止」、菜单栏里的「停止录制」或按 ⌃⌥⌘S。文件自动合成,出现在左侧列表,并自动开始转写。
3. **转写**:录制的会议会自动转写;导入的文件点「① 转写文字」。首次使用系统会自动下载中文语音模型。
4. **分析**:勾选模板(默认是逐字稿整理、思维导图、会议摘要),点「② 分析所选」,每个模板的结果一个标签页,边生成边显示。
5. **导出**:复制当前页、下载包含全部结果和转写原文的 `.md`;思维导图可导出 SVG / PNG。

右上角「词库」里每行写一个专有名词,等号后面写识别常见的错写:`TSP = PSP, 踢艾斯批`。「模板」里可以改任何提示词,或者新建自己的模板。

## 设置项

| 环节 | 选项 | 说明 |
|---|---|---|
| 转写 | **本机识别**(默认) | macOS 26 SpeechAnalyzer,离线。语言填 `zh` / `en` / `ja` 等 |
| 转写 | Whisper 接口 | 任何 OpenAI 兼容的 `/audio/transcriptions`:Groq `whisper-large-v3-turbo`、OpenAI `whisper-1`、硅基流动 `FunAudioLLM/SenseVoiceSmall`、本机 whisper.cpp server |
| 分析 | **Claude 账号**(默认) | 调用本机 `claude` 命令行,模型填 `opus` / `sonnet` 或完整模型名 |
| 分析 | Anthropic API | 填 API Key,用中转站就填 Base URL,模型默认 `claude-opus-5-5` |

设置保存在项目目录的 `config.json`(已 gitignore),也可以复制 `.env.example` 为 `.env` 配置。

## 目录结构

```
server.ts            Bun 服务端:录制控制、上传、ffmpeg、两种转写、词库、模板分析(SSE 流式)、心跳退出
templates.ts         出厂默认的分析模板
native/
  transcribe.swift   macOS 本地转写(SpeechAnalyzer + SpeechTranscriber),输出 JSON Lines
  record.swift       录制助手:ScreenCaptureKit 录画面 / 系统声音 / 麦克风,菜单栏计时、快捷键、打点
  build-recorder.sh  编译出 bin/录制助手.app(带权限说明的 Info.plist + 本地签名)
public/
  index.html         页面
  app.js             录音(MediaRecorder + 混音)、列表、SSE 接收、设置
  style.css
build-app.sh         生成 ~/Applications/会议录音纪要.app(菜单栏常驻:启动服务、主窗口、开会提醒、快捷键)
native/menubar.swift 菜单栏程序源码
bin/transcribe       编译出来的转写程序(已 gitignore)
bin/录制助手.app      编译出来的录制助手(已 gitignore)
meetings/            每个会议一个目录(已 gitignore)
  20261008-1423/
    media.mp4        录屏 + 混音(播放用;仅声音模式是 audio.m4a,导入的文件保持原名)
    mic.m4a          麦克风音轨(我)
    system.m4a       系统声音音轨(嘉宾)
    transcript.txt   带时间戳和说话人的转写
    transcript.json
    results/         每个模板一个 .md(tidy.md / mindmap.md / abstract.md …)
    meta.json
config.json          设置(已 gitignore)
glossary.json        专有名词词库(已 gitignore)
templates.json       改过的模板(已 gitignore,删掉就恢复默认)
```

## 常见问题

**点开始录制报「需要屏幕录制权限」?**
打开「系统设置 → 隐私与安全性 → 屏幕与系统录音」,打开「录制助手」,再点一次开始。
每次重新编译录制助手(改了 `native/record.swift`)签名都会变,系统可能要求重新授权。

**逐字稿里「嘉宾」的话也出现在「我」里?**
没戴耳机时,扬声器里对方的声音会被麦克风再录一遍。转写时会自动删掉和同一时间嘉宾内容几乎一样的「我」的句子;最干净的办法还是开会戴耳机。

**选单个窗口时声音不全?**
单个窗口模式下,系统声音只收录这个窗口所属应用的声音。录线上会议又要录别的窗口的课件时,选「整个屏幕」。

**一小时录屏多大?**
长边压到 1920 像素、H.264 约 2–4 Mbps,一小时约 1–1.5 GB。只要文字的话用「仅声音」模式,一小时几十 MB。

**纪要显示「未登录」?**
应用调用的是本机 `claude` 命令,它和 Claude 桌面应用的登录不互通。在终端运行一次 `claude auth login` 即可;如果 `claude` 装在别的位置,在设置里填完整路径。

**本机识别没有标点?**
系统识别的中文结果基本没有标点,这是正常的,生成纪要时 Claude 会自己断句。

**双击应用没反应或报错?**
日志在 `~/Library/Logs/meeting-recorder.log`。最常见的原因是 .app 被放进了桌面 / 文稿 / 下载文件夹,移回 `~/Applications` 即可。

**语音备忘录读不到?**
录音在 `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings`。从应用启动时如果提示没有权限,到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里打开「会议录音纪要」。
只在 iCloud 上、还没下载到 Mac 的录音会显示「未下载」,在「语音备忘录」里点开播放一下就会下载。
自动导入只导入打开开关之后录的,之前的录音在导入窗口里手动勾选。

**点删除、复制、导出没反应?**
如果是在 Claude 应用自带的浏览器面板里打开的,面板会屏蔽网页的系统弹窗和下载。现在界面里的确认框都是页面自己画的,导出也改成直接存进「下载」文件夹,应该都能用;日常使用还是建议从菜单栏图标点「打开主窗口」。

**备份占不占空间?**
iCloud 云盘里的文件默认在本机也保留一份,所以备份视频会多占一倍硬盘。默认「只备份文字」几乎不占空间;「文字 + 音频」一小时约 100 MB。

**重新编译后,系统又问权限?**
本地编译的 App 没有开发者证书,签名每次编译都会变,系统会把它当成新 App。`build-app.sh` 只在源码改过时才重新编译,平时重复运行不会影响已经给过的权限。

**菜单栏里看不到图标?**
有刘海的 MacBook 上,菜单栏图标太多时,排在最左边的会被刘海挡住。按住 ⌘ 拖动菜单栏图标可以调整顺序,把不常用的拖出去。

**开会提醒没弹出来?**
只认会议类软件(腾讯会议、Zoom、飞书、钉钉、微信、QQ、Teams、Webex、FaceTime、Slack、Discord,以及 Chrome / Edge / Arc / Firefox / Safari 里的网页会议),而且要它们真的在用麦克风 4 秒以上;同一场会议只提醒一次。菜单里可以关掉提醒。

**macOS 版本低于 26?**
本机识别用不了,在设置里切到「Whisper 接口」。[Groq](https://console.groq.com) 有免费额度,够日常用。

**录音很长会怎样?**
本机识别不限时长。Whisper 接口会按 10 分钟切片依次转写再拼接。

## 参考项目

设计时参考了这些开源项目:

- [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes):Tauri + Rust,本地 Whisper / Parakeet,Ollama 或云端 LLM
- [Hyprnote](https://github.com/fastrepl/hyprnote):Tauri v2,本地 SQLite,转写与 LLM 分开配置
- [kleoth](https://github.com/ofcRS/kleoth):Swift 菜单栏应用,Core Audio process tap 分轨录制,纪要可走 Claude Code CLI
- [ownscribe](https://github.com/paberr/ownscribe):Python CLI,Core Audio Taps,WhisperX + 本地 LLM

本项目选择了最轻的路线:不用编译 Rust,不用装 Python 模型,转写直接用系统能力,纪要直接用已有的 Claude 订阅。

## Roadmap

- [x] 麦克风与系统声音分轨保存,转写时区分「我」和「嘉宾」
- [x] 原生录屏:三种模式、窗口选择、菜单栏计时、快捷键、打点
- [x] 专有名词词库
- [x] 分析模板系统 + 思维导图
- [x] 没戴耳机时自动去掉麦克风里的回声重复
- [x] 多条记录批量排队分析
- [x] 资料库全文搜索
- [x] 导入语音备忘录(含自动导入)
- [x] 菜单栏常驻、全局「开始录制」快捷键、开会提醒
- [x] 跨会议提问(问资料库)
- [x] 说话人改名、SRT 字幕导出
- [ ] 高光片段自动切成短视频
- [x] 存储管理(只删视频、保留音频和文字)
- [x] 自动起标题、误触录音自动丢弃、逐字稿阅读模式、iCloud 备份
- [ ] 选择哪些软件触发开会提醒
- [ ] 分析结果发到钉钉文档
- [ ] 同一条音轨里多位嘉宾的说话人分离
- [ ] 实时转写(录音过程中就显示文字)
- [ ] 应用图标

## License

MIT
