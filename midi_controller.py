#!/usr/bin/env python
# -*- coding: utf-8 -*-

import ctypes
import sys
import json
import time
import os
import tempfile
import threading
import struct
from ctypes import wintypes

if sys.platform == 'win32':
    import io
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

user32 = ctypes.windll.user32

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

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
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump({'hwnd': hwnd, 'title': title, 'timestamp': time.time()}, f, ensure_ascii=False)
    except:
        pass

def load_state():
    try:
        if not os.path.exists(STATE_FILE): return None
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            state = json.load(f)
        return None if time.time() - state.get('timestamp', 0) > 60 else state
    except:
        return None

def clear_state():
    try: os.remove(STATE_FILE)
    except: pass

def get_screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)

def click_at(x, y):
    sw, sh = get_screen_size()
    abs_x, abs_y = int((x / sw) * 65535), int((y / sh) * 65535)
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
                client_rect = wintypes.RECT()
                user32.GetClientRect(hwnd, ctypes.byref(client_rect))
                pt = wintypes.POINT(0, 0)
                user32.ClientToScreen(hwnd, ctypes.byref(pt))
                return {
                    'hwnd': hwnd, 'title': title,
                    'rect': (pt.x, pt.y, pt.x + client_rect.right, pt.y + client_rect.bottom),
                    'width': client_rect.right, 'height': client_rect.bottom
                }
    except:
        pass
    return None

def get_window_info(hwnd):
    try:
        if not user32.IsWindow(hwnd): return None
        client_rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(client_rect))
        pt = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(pt))
        return {
            'hwnd': hwnd, 'rect': (pt.x, pt.y, pt.x + client_rect.right, pt.y + client_rect.bottom),
            'width': client_rect.right, 'height': client_rect.bottom
        }
    except:
        return None

def scale_coordinates(window_info, base_x, base_y):
    if not window_info: return base_x, base_y
    win_left, win_top = window_info['rect'][0], window_info['rect'][1]
    win_width, win_height = window_info['width'], window_info['height']
    scale_x = win_width / BASE_WIDTH
    scale_y = win_height / BASE_HEIGHT
    return int(win_left + base_x * scale_x), int(win_top + base_y * scale_y)

def ensure_window_active(hwnd):
    try:
        if user32.GetForegroundWindow() != hwnd:
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.05)
            return user32.GetForegroundWindow() == hwnd
        return True
    except:
        return False

def read_var_length(data, offset):
    val = 0
    while True:
        b = data[offset]; offset += 1
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80): break
    return val, offset

class MidiParser:
    def __init__(self):
        self.events, self.total_duration = [], 0.0
        self.ticks_per_beat, self.tempo_events, self.track_info = 480, [], []
    
    def parse(self, file_path):
        with open(file_path, 'rb') as f: data = f.read()
        offset, data_len = 0, len(data)
        if data[offset:offset+4] != b'MThd': return False
        offset += 4
        header_len = struct.unpack('>I', data[offset:offset+4])[0]; offset += 4
        format_type = struct.unpack('>H', data[offset:offset+2])[0]; offset += 2
        num_tracks = struct.unpack('>H', data[offset:offset+2])[0]; offset += 2
        self.ticks_per_beat = struct.unpack('>H', data[offset:offset+2])[0]; offset += 2
        if self.ticks_per_beat == 0: self.ticks_per_beat = 480
        
        tracks_data, self.track_info = [], []
        for track_idx in range(num_tracks):
            if offset + 4 > data_len or data[offset:offset+4] != b'MTrk': break
            offset += 4
            track_len = struct.unpack('>I', data[offset:offset+4])[0]; offset += 4
            track_end = min(offset + track_len, data_len)
            track_events, track_tick, running_status = [], 0, 0
            
            while offset < track_end:
                try: delta, offset = read_var_length(data, offset)
                except: break
                track_tick += delta
                if offset >= data_len: break
                
                status = data[offset]
                if status & 0x80: event_type = status; offset += 1
                else: event_type = running_status
                running_status = event_type
                cmd = event_type >> 4
                
                if cmd in (0x8, 0x9):
                    if offset + 1 >= track_end: break
                    note, velocity = data[offset], data[offset+1]; offset += 2
                    if cmd == 0x9 and velocity > 0:
                        track_events.append(('note_on', track_tick, note, velocity))
                    else:
                        track_events.append(('note_off', track_tick, note, 0))
                elif cmd in (0xA, 0xB, 0xE): offset += 2
                elif cmd in (0xC, 0xD): offset += 1
                elif cmd == 0xF:
                    if status == 0xFF:
                        if offset >= track_end: break
                        meta_type = data[offset]; offset += 1
                        meta_len, offset = read_var_length(data, offset)
                        meta_data = data[offset:offset+meta_len]; offset += meta_len
                        if meta_type == 0x51 and meta_len >= 3:
                            tempo = (meta_data[0] << 16) | (meta_data[1] << 8) | meta_data[2]
                            self.tempo_events.append((track_tick, tempo))
                    else:
                        sysex_len, offset = read_var_length(data, offset); offset += sysex_len
            
            note_count = sum(1 for e in track_events if e[0] == 'note_on')
            tracks_data.append((track_idx, track_events))
            self.track_info.append({'index': track_idx, 'name': f'音轨 {track_idx + 1}', 'noteCount': note_count, 'enabled': True})
        
        if not self.tempo_events: self.tempo_events.append((0, 500000))
        self.tempo_events.sort(key=lambda x: x[0])
        
        def tick_to_sec(tick):
            if tick <= 0: return 0.0
            sec, cur_tempo, last_tick = 0.0, 500000, 0
            for t_tick, t_us in self.tempo_events:
                if t_tick >= tick: break
                sec += (t_tick - last_tick) * (cur_tempo / self.ticks_per_beat / 1000000.0)
                cur_tempo = t_us; last_tick = t_tick
            sec += (tick - last_tick) * (cur_tempo / self.ticks_per_beat / 1000000.0)
            return sec
        
        all_events, max_time = [], 0
        for track_idx, track_events in tracks_data:
            for evt_type, tick, note, velocity in track_events:
                time_sec = tick_to_sec(tick)
                max_time = max(max_time, time_sec)
                if evt_type == 'note_on': all_events.append((time_sec, note, velocity, True, track_idx))
                elif evt_type == 'note_off': all_events.append((time_sec, note, 0, False, track_idx))
        
        all_events.sort(key=lambda x: x[0])
        self.events = all_events
        self.total_duration = max_time
        return True

class MidiController:
    def __init__(self):
        self.target_hwnd, self.target_title = None, ""
        self.is_playing, self.is_paused, self.speed, self.current_time = False, False, 1.0, 0.0
        self.events, self.total_duration, self.track_info, self.muted_tracks = [], 0.0, [], set()
        self.play_thread, self.stop_flag, self.pause_flag = None, False, False
        self.seek_request, self.speed_request, self.loaded_file = None, None, ""
        self._thread_lock, self._play_generation = threading.Lock(), 0
        
        state = load_state()
        if state:
            self.target_hwnd, self.target_title = state['hwnd'], state['title']
    
    def load_midi(self, file_path):
        if not os.path.exists(file_path): return False
        if self.is_playing: self.stop(); time.sleep(0.1)
        parser = MidiParser()
        if not parser.parse(file_path): return False
        self.events, self.total_duration = parser.events, parser.total_duration
        self.track_info, self.muted_tracks = parser.track_info, set()
        self.current_time, self.loaded_file = 0.0, file_path
        self.is_playing, self.is_paused = False, False
        self.stop_flag, self.pause_flag = False, False
        self.seek_request, self.speed_request = None, None
        return True
    
    def get_tracks(self):
        return [{'index': t['index'], 'name': t['name'], 'noteCount': t['noteCount'], 'enabled': t['index'] not in self.muted_tracks} for t in self.track_info]
    
    def toggle_track_mute(self, index):
        if index in self.muted_tracks: self.muted_tracks.discard(index); return False
        self.muted_tracks.add(index); return True
    
    def detect_window(self):
        info = get_active_window()
        if info:
            self.target_hwnd, self.target_title = info['hwnd'], info['title']
            save_state(info['hwnd'], info['title'])
            return {'success': True, 'title': info['title']}
        return {'success': False, 'error': '未检测到窗口'}
    
    def get_window_info(self):
        if not self.target_hwnd:
            state = load_state()
            if state: self.target_hwnd, self.target_title = state['hwnd'], state['title']
            else: return {'available': False}
        info = get_window_info(self.target_hwnd)
        return {'available': True, 'title': self.target_title, 'rect': info['rect'], 'width': info['width'], 'height': info['height'], 'hwnd': self.target_hwnd} if info else {'available': False}
    
    def click_note(self, note, velocity):
        if not self.target_hwnd or note not in MIDI_TO_COORDS: return False
        ensure_window_active(self.target_hwnd)
        info = get_window_info(self.target_hwnd)
        if not info: return False
        x, y = scale_coordinates(info, *MIDI_TO_COORDS[note])
        click_at(x, y)
        return True
    
    def play(self):
        if self.is_playing and not self.is_paused: return
        if not self.events or not self.target_hwnd or not user32.IsWindow(self.target_hwnd): return
        self.is_playing, self.is_paused = True, False
        self.stop_flag, self.pause_flag = False, False
        self.seek_request, self.speed_request = None, None
        if self.current_time >= self.total_duration: self.current_time = 0.0
        with self._thread_lock:
            self._play_generation += 1
            self.play_thread = threading.Thread(target=self._play_loop, args=(self._play_generation,), daemon=True)
            self.play_thread.start()
    
    def pause(self): self.is_paused, self.pause_flag = True, True
    def stop(self): self.stop_flag, self.is_playing, self.is_paused, self.current_time = True, False, False, 0.0
    
    def set_speed(self, speed):
        self.speed = max(0.05, min(2.0, speed))
        if self.is_playing and not self.is_paused: self.speed_request = self.speed
    
    def seek(self, ratio):
        target = ratio * self.total_duration
        self.current_time = target
        if self.is_playing and not self.is_paused: self.seek_request = target
    
    def _play_loop(self, gen):
        if gen != self._play_generation: return
        if self.seek_request is not None:
            self.current_time, self.seek_request = self.seek_request, None
        
        start_time, start_pos, cur_speed = time.perf_counter(), self.current_time, self.speed
        event_idx = next((i for i, evt in enumerate(self.events) if evt[0] >= start_pos), len(self.events))
        
        try:
            while not self.stop_flag and event_idx < len(self.events):
                if gen != self._play_generation: return
                if self.seek_request is not None:
                    with self._thread_lock:
                        self._play_generation += 1
                        self.play_thread = threading.Thread(target=self._play_loop, args=(self._play_generation,), daemon=True)
                        self.play_thread.start()
                    return
                
                if self.pause_flag:
                    elapsed = (time.perf_counter() - start_time) * cur_speed
                    time.sleep(0.01)
                    start_time, start_pos = time.perf_counter(), start_pos + elapsed
                    continue
                
                if self.speed_request is not None:
                    elapsed = (time.perf_counter() - start_time) * cur_speed
                    start_time, start_pos = time.perf_counter(), start_pos + elapsed
                    cur_speed, self.speed = self.speed_request, self.speed_request
                    self.speed_request = None
                    continue
                
                evt = self.events[event_idx]
                evt_time, note, vel, is_on, track_idx = evt[0], evt[1], evt[2], evt[3], (evt[4] if len(evt) > 4 else 0)
                cur_pos = start_pos + (time.perf_counter() - start_time) * cur_speed
                
                if cur_pos >= evt_time:
                    if is_on and vel > 0 and track_idx not in self.muted_tracks: self.click_note(note, vel)
                    event_idx += 1
                    self.current_time = evt_time
                    continue
                
                wait_time, interrupted = (evt_time - cur_pos) / cur_speed, False
                while wait_time > 0:
                    if self.stop_flag or self.pause_flag or self.seek_request is not None:
                        interrupted = True; break
                    if gen != self._play_generation: return
                    time.sleep(min(0.005, wait_time))
                    cur_pos = start_pos + (time.perf_counter() - start_time) * cur_speed
                    wait_time = (evt_time - cur_pos) / cur_speed
                
                if interrupted: continue
                if is_on and vel > 0 and track_idx not in self.muted_tracks: self.click_note(note, vel)
                event_idx += 1
                self.current_time = evt_time
                
            if not self.stop_flag and gen == self._play_generation:
                self.current_time, self.is_playing = self.total_duration, False
        except Exception:
            self.is_playing = False

    def get_state(self):
        return {'isPlaying': self.is_playing and not self.is_paused, 'currentTime': self.current_time * 1000, 'totalDuration': self.total_duration * 1000, 'speed': self.speed, 'eventCount': len(self.events), 'loadedFile': self.loaded_file}

def handle_command(controller, data):
    cmd = data.get('command', '')
    if cmd == 'detect': return controller.detect_window()
    if cmd == 'info': return controller.get_window_info()
    if cmd == 'load':
        success = controller.load_midi(data.get('filePath', ''))
        return {'success': True, 'totalDuration': controller.total_duration * 1000, 'eventCount': len(controller.events), 'currentTime': 0, 'tracks': controller.get_tracks()} if success else {'success': False}
    if cmd == 'tracks': return {'tracks': controller.get_tracks()}
    if cmd == 'toggle_track': return {'success': True, 'muted': controller.toggle_track_mute(data.get('index', 0)), 'tracks': controller.get_tracks()}
    if cmd == 'play': controller.play(); return {'success': True}
    if cmd == 'pause': controller.pause(); return {'success': True}
    if cmd == 'stop': controller.stop(); return {'success': True}
    if cmd == 'seek': controller.seek(data.get('ratio', 0)); return {'success': True}
    if cmd == 'speed': controller.set_speed(data.get('speed', 1.0)); return {'success': True}
    if cmd == 'state': return controller.get_state()
    if cmd == 'click': return {'success': controller.click_note(data.get('note', 0), data.get('velocity', 100))}
    if cmd == 'reset':
        controller.stop()
        controller.events, controller.total_duration, controller.current_time = [], 0.0, 0.0
        controller.track_info, controller.muted_tracks = [], set()
        controller.target_hwnd, controller.target_title = None, ""
        clear_state()
        return {'success': True}
    if cmd == 'ping': return {'status': 'ok'}
    if cmd == 'exit': return {'status': 'bye', 'exit': True}
    return {'error': f'未知命令: {cmd}'}

def main():
    controller = MidiController()
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: data = json.loads(line)
        except Exception as e:
            print(json.dumps({'error': str(e)}), flush=True); continue
        try:
            result = handle_command(controller, data)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if result and result.get('exit'): break
        except Exception as e:
            print(json.dumps({'error': str(e)}), flush=True)

if __name__ == '__main__':
    main()