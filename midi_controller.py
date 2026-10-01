#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
MIDI 控制器 - 常驻服务模式
"""

import ctypes
import sys
import json
import time
import os
import tempfile
import threading
import struct
from ctypes import wintypes

# 设置所有标准流为 UTF-8 编码
if sys.platform == 'win32':
    import io
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

# Windows API
user32 = ctypes.windll.user32

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
SW_RESTORE = 9

BASE_WIDTH = 1920
BASE_HEIGHT = 1080
STATE_FILE = os.path.join(tempfile.gettempdir(), 'midi_controller_state.json')

MIDI_TO_COORDS = {
    21: (18, 1035), 22: (35, 936), 23: (55, 1035), 24: (92, 1035), 25: (110, 936),
    26: (129, 1035), 27: (148, 936), 28: (166, 1035), 29: (203, 1035), 30: (220, 936),
    31: (239, 1035), 32: (258, 936), 33: (276, 1035), 34: (295, 936), 35: (313, 1035),
    36: (350, 1035), 37: (370, 936), 38: (387, 1035), 39: (406, 936), 40: (424, 1035),
    41: (461, 1035), 42: (481, 936), 43: (498, 1035), 44: (518, 936), 45: (535, 1035),
    46: (555, 936), 47: (572, 1035), 48: (609, 1035), 49: (628, 936), 50: (646, 1035),
    51: (665, 936), 52: (683, 1035), 53: (719, 1035), 54: (738, 936), 55: (756, 1035),
    56: (775, 936), 57: (793, 1035), 58: (813, 936), 59: (830, 1035), 60: (867, 1035),
    61: (888, 936), 62: (904, 1035), 63: (925, 936), 64: (941, 1035), 65: (978, 1035),
    66: (1000, 936), 67: (1015, 1035), 68: (1038, 936), 69: (1052, 1035), 70: (1073, 936),
    71: (1089, 1035), 72: (1126, 1035), 73: (1148, 936), 74: (1163, 1035), 75: (1185, 936),
    76: (1200, 1035), 77: (1236, 1035), 78: (1259, 936), 79: (1273, 1035), 80: (1296, 936),
    81: (1310, 1035), 82: (1333, 936), 83: (1347, 1035), 84: (1384, 1035), 85: (1408, 936),
    86: (1421, 1035), 87: (1445, 936), 88: (1458, 1035), 89: (1495, 1035), 90: (1518, 936),
    91: (1532, 1035), 92: (1553, 936), 93: (1569, 1035), 94: (1591, 936), 95: (1606, 1035),
    96: (1643, 1035), 97: (1665, 936), 98: (1679, 1035), 99: (1704, 936), 100: (1716, 1035),
    101: (1753, 1035), 102: (1774, 936), 103: (1790, 1035), 104: (1811, 936), 105: (1827, 1035),
    106: (1850, 936), 107: (1864, 1035), 108: (1901, 1035)
}


def save_state(hwnd, title):
    try:
        state = {'hwnd': hwnd, 'title': title, 'timestamp': time.time()}
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False)
        return True
    except:
        return False


def load_state():
    try:
        if not os.path.exists(STATE_FILE):
            return None
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            state = json.load(f)
        if time.time() - state.get('timestamp', 0) > 60:
            return None
        return state
    except:
        return None


def clear_state():
    try:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
    except:
        pass


def get_screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def click_at(x, y):
    sw, sh = get_screen_size()
    abs_x = int((x / sw) * 65535)
    abs_y = int((y / sh) * 65535)
    flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP
    user32.mouse_event(flags, abs_x, abs_y, 0, 0)


def get_active_window():
    try:
        hwnd = user32.GetForegroundWindow()
        if hwnd and user32.IsWindowVisible(hwnd):
            title_buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title_buf, 256)
            title = title_buf.value
            if title:
                rect = ctypes.wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                return {
                    'hwnd': hwnd,
                    'title': title,
                    'rect': (rect.left, rect.top, rect.right, rect.bottom),
                    'width': rect.right - rect.left,
                    'height': rect.bottom - rect.top
                }
    except:
        pass
    return None


def scale_coordinates(window_info, base_x, base_y):
    if not window_info:
        return base_x, base_y
    win_left = window_info['rect'][0]
    win_top = window_info['rect'][1]
    win_width = window_info['width']
    win_height = window_info['height']
    scale = win_width / BASE_WIDTH
    base_bottom = BASE_HEIGHT - base_y
    scaled_x = base_x * scale
    scaled_y = win_height - base_bottom * scale
    return int(win_left + scaled_x), int(win_top + scaled_y)


def ensure_window_active(hwnd):
    try:
        current = user32.GetForegroundWindow()
        if current != hwnd:
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.05)
            return user32.GetForegroundWindow() == hwnd
        return True
    except:
        return False


def get_window_info(hwnd):
    try:
        if not user32.IsWindow(hwnd):
            return None
        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return {
            'hwnd': hwnd,
            'rect': (rect.left, rect.top, rect.right, rect.bottom),
            'width': rect.right - rect.left,
            'height': rect.bottom - rect.top
        }
    except:
        return None


def read_var_length(data, offset):
    value = 0
    while True:
        byte = data[offset]
        offset += 1
        value = (value << 7) | (byte & 0x7F)
        if not (byte & 0x80):
            break
    return value, offset


class MidiParser:
    def __init__(self):
        self.events = []
        self.total_duration = 0.0
        self.ticks_per_beat = 480
        self.tempo_events = []
        self.track_info = []

    def parse(self, file_path):
        with open(file_path, 'rb') as f:
            data = f.read()

        offset = 0
        data_len = len(data)

        if data[offset:offset+4] != b'MThd':
            print('[MidiParser] 无效的 MIDI 文件头', file=sys.stderr)
            return False

        offset += 4
        header_len = struct.unpack('>I', data[offset:offset+4])[0]
        offset += 4
        format_type = struct.unpack('>H', data[offset:offset+2])[0]
        offset += 2
        num_tracks = struct.unpack('>H', data[offset:offset+2])[0]
        offset += 2
        self.ticks_per_beat = struct.unpack('>H', data[offset:offset+2])[0]
        offset += 2

        if self.ticks_per_beat == 0:
            self.ticks_per_beat = 480

        print(f'[MidiParser] 格式: {format_type}, 轨道数: {num_tracks}, ticks_per_beat: {self.ticks_per_beat}', file=sys.stderr)

        tracks_data = []
        self.track_info = []

        for track_idx in range(num_tracks):
            if offset + 4 > data_len:
                break
            if data[offset:offset+4] != b'MTrk':
                print(f'[MidiParser] 轨道 {track_idx} 头无效', file=sys.stderr)
                break
            offset += 4
            track_len = struct.unpack('>I', data[offset:offset+4])[0]
            offset += 4
            track_end = offset + track_len
            track_end = min(track_end, data_len)

            track_events = []
            track_tick = 0
            running_status = 0

            while offset < track_end:
                try:
                    delta, offset = read_var_length(data, offset)
                except:
                    break
                track_tick += delta

                if offset >= data_len:
                    break

                status = data[offset]

                if status & 0x80:
                    event_type = status
                    offset += 1
                else:
                    event_type = running_status

                running_status = event_type
                cmd = event_type >> 4

                if cmd == 0x8:
                    if offset + 1 >= track_end:
                        break
                    note = data[offset]
                    velocity = data[offset + 1]
                    offset += 2
                    track_events.append(('note_off', track_tick, note, 0))

                elif cmd == 0x9:
                    if offset + 1 >= track_end:
                        break
                    note = data[offset]
                    velocity = data[offset + 1]
                    offset += 2
                    if velocity > 0:
                        track_events.append(('note_on', track_tick, note, velocity))
                    else:
                        track_events.append(('note_off', track_tick, note, 0))

                elif cmd == 0xA:
                    offset += 2
                elif cmd == 0xB:
                    offset += 2
                elif cmd == 0xC:
                    offset += 1
                elif cmd == 0xD:
                    offset += 1
                elif cmd == 0xE:
                    offset += 2
                elif cmd == 0xF:
                    if status == 0xFF:
                        if offset >= track_end:
                            break
                        meta_type = data[offset]
                        offset += 1
                        meta_len, offset = read_var_length(data, offset)
                        meta_data = data[offset:offset+meta_len]
                        offset += meta_len

                        if meta_type == 0x51 and meta_len >= 3:
                            tempo = (meta_data[0] << 16) | (meta_data[1] << 8) | meta_data[2]
                            self.tempo_events.append((track_tick, tempo))
                    else:
                        sysex_len, offset = read_var_length(data, offset)
                        offset += sysex_len

            note_count = sum(1 for e in track_events if e[0] == 'note_on')

            tracks_data.append((track_idx, track_events))

            # 使用固定名称「音轨 N」，不读取 MIDI 中的轨道名
            self.track_info.append({
                'index': track_idx,
                'name': f'音轨 {track_idx + 1}',
                'noteCount': note_count,
                'enabled': True
            })

            print(f'[MidiParser] 轨道 {track_idx}: {note_count} 个音符, {len(track_events)} 个事件', file=sys.stderr)

        if not self.tempo_events:
            self.tempo_events.append((0, 500000))
        self.tempo_events.sort(key=lambda x: x[0])

        print(f'[MidiParser] tempo 事件数: {len(self.tempo_events)}', file=sys.stderr)

        def tick_to_sec(tick):
            if tick <= 0:
                return 0.0
            seconds = 0.0
            current_tempo = 500000
            last_tick = 0
            for tempo_tick, tempo_us in self.tempo_events:
                if tempo_tick >= tick:
                    break
                delta_ticks = tempo_tick - last_tick
                seconds += delta_ticks * (current_tempo / self.ticks_per_beat / 1000000.0)
                current_tempo = tempo_us
                last_tick = tempo_tick
            delta_ticks = tick - last_tick
            seconds += delta_ticks * (current_tempo / self.ticks_per_beat / 1000000.0)
            return seconds

        all_events = []
        max_time = 0

        for track_idx, track_events in tracks_data:
            for evt_type, tick, note, velocity in track_events:
                time_sec = tick_to_sec(tick)
                if time_sec > max_time:
                    max_time = time_sec

                if evt_type == 'note_on':
                    all_events.append((time_sec, note, velocity, True, track_idx))
                elif evt_type == 'note_off':
                    all_events.append((time_sec, note, 0, False, track_idx))

        all_events.sort(key=lambda x: x[0])

        self.events = all_events
        self.total_duration = max_time

        print(f'[MidiParser] 总事件数: {len(self.events)}', file=sys.stderr)
        print(f'[MidiParser] 总时长: {self.total_duration:.2f} 秒', file=sys.stderr)

        return True


class MidiController:
    def __init__(self):
        self.target_hwnd = None
        self.target_title = ""
        self.is_playing = False
        self.is_paused = False
        self.speed = 1.0
        self.current_time = 0.0
        self.events = []
        self.total_duration = 0.0
        self.track_info = []
        self.muted_tracks = set()
        self.play_thread = None
        self.stop_flag = False
        self.pause_flag = False
        self.seek_request = None
        self.speed_request = None
        self.loaded_file = ""
        
        # 播放代次：每次启动新线程 +1，旧线程检测到代次不匹配立即退出
        self._thread_lock = threading.Lock()
        self._play_generation = 0

        state = load_state()
        if state:
            self.target_hwnd = state['hwnd']
            self.target_title = state['title']

    def load_midi(self, file_path):
        if not os.path.exists(file_path):
            print(f'[MidiController] 文件不存在: {file_path}', file=sys.stderr)
            return False

        if self.is_playing:
            self.stop()
            time.sleep(0.1)

        print(f'[MidiController] 加载 MIDI: {file_path}', file=sys.stderr)

        parser = MidiParser()
        if not parser.parse(file_path):
            return False

        self.events = parser.events
        self.total_duration = parser.total_duration
        self.track_info = parser.track_info
        self.muted_tracks = set()
        self.current_time = 0.0
        self.loaded_file = file_path

        self.is_playing = False
        self.is_paused = False
        self.stop_flag = False
        self.pause_flag = False
        self.seek_request = None
        self.speed_request = None

        print(f'[MidiController] 加载完成: {len(self.events)} 个事件, {self.total_duration:.2f} 秒', file=sys.stderr)
        return True

    def get_tracks(self):
        result = []
        for t in self.track_info:
            result.append({
                'index': t['index'],
                'name': t['name'],
                'noteCount': t['noteCount'],
                'enabled': t['index'] not in self.muted_tracks
            })
        return result

    def toggle_track_mute(self, index):
        if index in self.muted_tracks:
            self.muted_tracks.discard(index)
            muted = False
        else:
            self.muted_tracks.add(index)
            muted = True
        return muted

    def detect_window(self):
        print('[MidiController] 立即检测窗口...', file=sys.stderr)
        info = get_active_window()
        if info:
            self.target_hwnd = info['hwnd']
            self.target_title = info['title']
            save_state(info['hwnd'], info['title'])
            print(f'[MidiController] 已锁定: {info["title"]}', file=sys.stderr)
            return {'success': True, 'title': info['title']}
        return {'success': False, 'error': '未检测到窗口'}

    def get_window_info(self):
        if not self.target_hwnd:
            state = load_state()
            if state:
                self.target_hwnd = state['hwnd']
                self.target_title = state['title']
            else:
                return {'available': False}

        info = get_window_info(self.target_hwnd)
        if info:
            return {
                'available': True,
                'title': self.target_title,
                'rect': info['rect'],
                'width': info['width'],
                'height': info['height'],
                'hwnd': self.target_hwnd
            }
        return {'available': False}

    def click_note(self, note, velocity):
        if not self.target_hwnd:
            return False
        if note not in MIDI_TO_COORDS:
            return False
        ensure_window_active(self.target_hwnd)
        info = get_window_info(self.target_hwnd)
        if not info:
            return False
        base_x, base_y = MIDI_TO_COORDS[note]
        x, y = scale_coordinates(info, base_x, base_y)
        click_at(x, y)
        return True

    def play(self):
        if self.is_playing and not self.is_paused:
            return

        if not self.events:
            print('[MidiController] 没有加载 MIDI 文件或没有音符', file=sys.stderr)
            return

        if not self.target_hwnd:
            print('[MidiController] 未锁定窗口，拒绝播放', file=sys.stderr)
            return

        self.is_playing = True
        self.is_paused = False
        self.stop_flag = False
        self.pause_flag = False
        self.seek_request = None
        self.speed_request = None

        if self.current_time >= self.total_duration:
            self.current_time = 0.0

        with self._thread_lock:
            self._play_generation += 1
            gen = self._play_generation
            self.play_thread = threading.Thread(
                target=self._play_loop, args=(gen,), daemon=True
            )
            self.play_thread.start()
        print('[MidiController] 开始播放', file=sys.stderr)

    def pause(self):
        self.is_paused = True
        self.pause_flag = True

    def stop(self):
        self.stop_flag = True
        self.is_playing = False
        self.is_paused = False
        self.current_time = 0.0

    def set_speed(self, speed):
        self.speed = max(0.05, min(2.0, speed))
        if self.is_playing and not self.is_paused:
            self.speed_request = self.speed

    def seek(self, ratio):
        target = ratio * self.total_duration
        self.current_time = target
        if self.is_playing and not self.is_paused:
            self.seek_request = target

    def _play_loop(self, generation):
        """
        播放循环：
        - 每次循环开始时消费 seek_request 作为起始位置
        - 循环中检测到 seek_request 就退出并启动新线程
        - 通过 generation 确保只有最新的线程在跑
        """
        if generation != self._play_generation:
            print(f'[MidiController] 线程 gen={generation} 已过期，退出', file=sys.stderr)
            return

        if self.seek_request is not None:
            self.current_time = self.seek_request
            self.seek_request = None
            print(f'[MidiController] 新循环从 seek 位置 {self.current_time:.2f}s 开始', file=sys.stderr)

        playback_start_time = time.perf_counter()
        playback_start_pos = self.current_time
        current_speed = self.speed

        event_index = 0
        for i, evt in enumerate(self.events):
            if evt[0] >= playback_start_pos:
                event_index = i
                break

        print(f'[MidiController] 播放循环开始 (gen={generation}), 从 {playback_start_pos:.2f}s, 事件 {event_index}', file=sys.stderr)

        try:
            while not self.stop_flag and event_index < len(self.events):
                if generation != self._play_generation:
                    print(f'[MidiController] 线程 gen={generation} 被取代，退出', file=sys.stderr)
                    return

                if self.seek_request is not None:
                    print('[MidiController] 检测到 seek，退出当前循环并启动新线程', file=sys.stderr)
                    with self._thread_lock:
                        self._play_generation += 1
                        new_gen = self._play_generation
                        self.play_thread = threading.Thread(
                            target=self._play_loop, args=(new_gen,), daemon=True
                        )
                        self.play_thread.start()
                    return

                if self.pause_flag:
                    elapsed = (time.perf_counter() - playback_start_time) * current_speed
                    paused_pos = playback_start_pos + elapsed
                    time.sleep(0.01)
                    playback_start_time = time.perf_counter()
                    playback_start_pos = paused_pos
                    continue

                if self.speed_request is not None:
                    elapsed = (time.perf_counter() - playback_start_time) * current_speed
                    current_music_pos = playback_start_pos + elapsed

                    current_speed = self.speed_request
                    self.speed_request = None
                    self.speed = current_speed

                    playback_start_time = time.perf_counter()
                    playback_start_pos = current_music_pos
                    continue

                event = self.events[event_index]
                event_time = event[0]
                note = event[1]
                velocity = event[2]
                is_on = event[3]
                track_idx = event[4] if len(event) > 4 else 0

                now = time.perf_counter()
                current_music_pos = playback_start_pos + (now - playback_start_time) * current_speed

                if current_music_pos >= event_time:
                    if is_on and velocity > 0:
                        if track_idx not in self.muted_tracks:
                            self.click_note(note, velocity)
                    event_index += 1
                    self.current_time = event_time
                    continue

                wait_time = (event_time - current_music_pos) / current_speed
                interrupted = False
                while wait_time > 0:
                    if self.stop_flag or self.pause_flag or self.seek_request is not None:
                        interrupted = True
                        break
                    if generation != self._play_generation:
                        return
                    sleep_chunk = min(0.005, wait_time)
                    time.sleep(sleep_chunk)
                    now = time.perf_counter()
                    current_music_pos = playback_start_pos + (now - playback_start_time) * current_speed
                    wait_time = (event_time - current_music_pos) / current_speed

                if interrupted:
                    continue

                if is_on and velocity > 0:
                    if track_idx not in self.muted_tracks:
                        self.click_note(note, velocity)

                event_index += 1
                self.current_time = event_time

            if not self.stop_flag and generation == self._play_generation:
                self.current_time = self.total_duration
                self.is_playing = False
                print('[MidiController] 播放完成', file=sys.stderr)
        except Exception as e:
            print(f'[MidiController] 播放错误: {e}', file=sys.stderr)
            self.is_playing = False

    def get_state(self):
        return {
            'isPlaying': self.is_playing and not self.is_paused,
            'currentTime': self.current_time * 1000,
            'totalDuration': self.total_duration * 1000,
            'speed': self.speed,
            'eventCount': len(self.events),
            'loadedFile': self.loaded_file
        }


def handle_command(controller, data):
    command = data.get('command', '')

    if command == 'detect':
        return controller.detect_window()
    elif command == 'info':
        return controller.get_window_info()
    elif command == 'load':
        file_path = data.get('filePath', '')
        success = controller.load_midi(file_path)
        if success:
            return {
                'success': True,
                'totalDuration': controller.total_duration * 1000,
                'eventCount': len(controller.events),
                'currentTime': 0,
                'tracks': controller.get_tracks()
            }
        return {'success': False}
    elif command == 'tracks':
        return {'tracks': controller.get_tracks()}
    elif command == 'toggle_track':
        index = data.get('index', 0)
        muted = controller.toggle_track_mute(index)
        return {'success': True, 'muted': muted, 'tracks': controller.get_tracks()}
    elif command == 'play':
        controller.play()
        return {'success': True}
    elif command == 'pause':
        controller.pause()
        return {'success': True}
    elif command == 'stop':
        controller.stop()
        return {'success': True}
    elif command == 'seek':
        ratio = data.get('ratio', 0)
        controller.seek(ratio)
        return {'success': True}
    elif command == 'speed':
        speed = data.get('speed', 1.0)
        controller.set_speed(speed)
        return {'success': True}
    elif command == 'state':
        return controller.get_state()
    elif command == 'click':
        note = data.get('note', 0)
        velocity = data.get('velocity', 100)
        result = controller.click_note(note, velocity)
        return {'success': result}
    elif command == 'reset':
        controller.stop()
        controller.events = []
        controller.total_duration = 0.0
        controller.current_time = 0.0
        controller.track_info = []
        controller.muted_tracks = set()
        controller.target_hwnd = None
        controller.target_title = ""
        clear_state()
        return {'success': True}
    elif command == 'exit':
        return {'status': 'bye', 'exit': True}
    else:
        return {'error': f'未知命令: {command}'}


def main():
    controller = MidiController()
    print('[MidiController] 服务已启动', file=sys.stderr)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            data = json.loads(line)
        except Exception as e:
            print(json.dumps({'error': f'JSON 解析错误: {e}'}), flush=True)
            continue

        try:
            result = handle_command(controller, data)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if result and result.get('exit'):
                break
        except Exception as e:
            print(json.dumps({'error': str(e)}), flush=True)

    print('[MidiController] 服务已退出', file=sys.stderr)


if __name__ == '__main__':
    main()