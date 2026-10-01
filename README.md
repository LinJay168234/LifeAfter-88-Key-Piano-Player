MIDI钢琴播放器
基于 Electron 和 Python 的明日之后88键钢琴自动演奏工具，模拟鼠标点击钢琴琴键。

功能
1.读取 MIDI 文件，进行演奏

2.窗口检测与锁定

3.变速、进度跳转、音轨选择

4.悬浮窗控制

5.主题色自定义

开发运行
bash
npm install
npm start

打包
bash
pip install pyinstaller
pyinstaller --onefile --name midi_controller --console midi_controller.py
copy dist\midi_controller.exe .
npm run dist:win

许可证
MIT
