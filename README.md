MIDI钢琴播放器

基于 Electron 和 Python 的《明日之后》88键钢琴自动演奏工具，通过模拟鼠标点击钢琴键实现自动演奏。

功能

- 读取 MIDI 文件，进行自动演奏
- 窗口检测与锁定
- 变速、进度跳转、音轨选择
- 悬浮窗控制
- 主题色自定义

开发运行

安装依赖并启动：
` ` `bash
npm install
npm start
` ` `

打包指南

1. 打包 Python 控制器
由于用户电脑可能没有安装 Python，需要先将 `midi_controller.py` 打包为独立的可执行文件：
` ` `bash
pip install pyinstaller
pyinstaller --onefile --name midi_controller --console midi_controller.py
` ` `

2. 复制生成的 exe 到项目根目录

3. 打包 Electron 应用
` ` `bash
npm run dist:win
` ` `

打包完成后，安装包会生成在 `dist` 目录下。
