const RAW_KEYS = {
  21: { x: 18, y: 1035 },
  22: { x: 35, y: 936 },
  23: { x: 55, y: 1035 },
  24: { x: 92, y: 1035 },
  25: { x: 110, y: 936 },
  26: { x: 129, y: 1035 },
  27: { x: 148, y: 936 },
  28: { x: 166, y: 1035 },
  29: { x: 203, y: 1035 },
  30: { x: 220, y: 936 },
  31: { x: 239, y: 1035 },
  32: { x: 258, y: 936 },
  33: { x: 276, y: 1035 },
  34: { x: 295, y: 936 },
  35: { x: 313, y: 1035 },
  36: { x: 350, y: 1035 },
  37: { x: 370, y: 936 },
  38: { x: 387, y: 1035 },
  39: { x: 406, y: 936 },
  40: { x: 424, y: 1035 },
  41: { x: 461, y: 1035 },
  42: { x: 481, y: 936 },
  43: { x: 498, y: 1035 },
  44: { x: 518, y: 936 },
  45: { x: 535, y: 1035 },
  46: { x: 555, y: 936 },
  47: { x: 572, y: 1035 },
  48: { x: 609, y: 1035 },
  49: { x: 628, y: 936 },
  50: { x: 646, y: 1035 },
  51: { x: 665, y: 936 },
  52: { x: 683, y: 1035 },
  53: { x: 719, y: 1035 },
  54: { x: 738, y: 936 },
  55: { x: 756, y: 1035 },
  56: { x: 775, y: 936 },
  57: { x: 793, y: 1035 },
  58: { x: 813, y: 936 },
  59: { x: 830, y: 1035 },
  60: { x: 867, y: 1035 },
  61: { x: 888, y: 936 },
  62: { x: 904, y: 1035 },
  63: { x: 925, y: 936 },
  64: { x: 941, y: 1035 },
  65: { x: 978, y: 1035 },
  66: { x: 1000, y: 936 },
  67: { x: 1015, y: 1035 },
  68: { x: 1038, y: 936 },
  69: { x: 1052, y: 1035 },
  70: { x: 1073, y: 936 },
  71: { x: 1089, y: 1035 },
  72: { x: 1126, y: 1035 },
  73: { x: 1148, y: 936 },
  74: { x: 1163, y: 1035 },
  75: { x: 1185, y: 936 },
  76: { x: 1200, y: 1035 },
  77: { x: 1236, y: 1035 },
  78: { x: 1259, y: 936 },
  79: { x: 1273, y: 1035 },
  80: { x: 1296, y: 936 },
  81: { x: 1310, y: 1035 },
  82: { x: 1333, y: 936 },
  83: { x: 1347, y: 1035 },
  84: { x: 1384, y: 1035 },
  85: { x: 1408, y: 936 },
  86: { x: 1421, y: 1035 },
  87: { x: 1445, y: 936 },
  88: { x: 1458, y: 1035 },
  89: { x: 1495, y: 1035 },
  90: { x: 1518, y: 936 },
  91: { x: 1532, y: 1035 },
  92: { x: 1553, y: 936 },
  93: { x: 1569, y: 1035 },
  94: { x: 1591, y: 936 },
  95: { x: 1606, y: 1035 },
  96: { x: 1643, y: 1035 },
  97: { x: 1665, y: 936 },
  98: { x: 1679, y: 1035 },
  99: { x: 1704, y: 936 },
  100: { x: 1716, y: 1035 },
  101: { x: 1753, y: 1035 },
  102: { x: 1774, y: 936 },
  103: { x: 1790, y: 1035 },
  104: { x: 1811, y: 936 },
  105: { x: 1827, y: 1035 },
  106: { x: 1850, y: 936 },
  107: { x: 1864, y: 1035 },
  108: { x: 1901, y: 1035 },
};

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

let cachedKeys = null;
let cachedScaleX = 0;
let cachedScaleY = 0;

function getScaleFactors() {
  let width, height;
  if (typeof screen !== 'undefined') {
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    width = display.size.width;
    height = display.size.height;
  } else if (typeof window !== 'undefined' && window.screen) {
    width = window.screen.width;
    height = window.screen.height;
  } else {
    width = 1920;
    height = 1080;
  }
  return {
    scaleX: width / BASE_WIDTH,
    scaleY: height / BASE_HEIGHT,
    width: width,
    height: height,
  };
}

function getPianoKeys() {
  const { scaleX, scaleY, width, height } = getScaleFactors();
  if (cachedKeys && cachedScaleX === scaleX && cachedScaleY === scaleY) {
    return cachedKeys;
  }
  cachedKeys = {};
  for (const [note, pos] of Object.entries(RAW_KEYS)) {
    cachedKeys[parseInt(note)] = {
      x: Math.round(pos.x * scaleX),
      y: Math.round(pos.y * scaleY),
      rawX: pos.x,
      rawY: pos.y,
      scaleX: scaleX,
      scaleY: scaleY,
    };
  }
  cachedScaleX = scaleX;
  cachedScaleY = scaleY;
  return cachedKeys;
}

function getPianoKey(noteNumber) {
  const keys = getPianoKeys();
  return keys[noteNumber] || null;
}

function getNoteName(noteNumber) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor((noteNumber - 12) / 12);
  const noteIndex = noteNumber % 12;
  return noteNames[noteIndex] + octave;
}

function isBlackKey(noteNumber) {
  const blackKeys = [1, 3, 6, 8, 10];
  return blackKeys.includes(noteNumber % 12);
}

function getNotePosition(noteNumber) {
  const keys = getPianoKeys();
  const pos = keys[noteNumber];
  if (!pos) return null;
  return {
    x: pos.x,
    y: pos.y,
    note: noteNumber,
    name: getNoteName(noteNumber),
    isBlack: isBlackKey(noteNumber),
  };
}

function findKeyByScreenPos(screenX, screenY) {
  const keys = getPianoKeys();
  const { scaleY } = getScaleFactors();
  const blackY = Math.round(936 * scaleY);
  const whiteY = Math.round(1035 * scaleY);
  let closest = null;
  let minDist = Infinity;
  for (const [note, pos] of Object.entries(keys)) {
    const yDist = Math.abs(screenY - pos.y);
    if (yDist > 50) continue;
    const xDist = Math.abs(screenX - pos.x);
    if (xDist < minDist) {
      minDist = xDist;
      closest = parseInt(note);
    }
  }
  return closest;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getPianoKeys,
    getPianoKey,
    getNoteName,
    isBlackKey,
    getNotePosition,
    findKeyByScreenPos,
    getScaleFactors,
    BASE_WIDTH,
    BASE_HEIGHT,
    RAW_KEYS,
  };
}