# GMK87 HID Image Uploader & Keyboard Control

![Status](https://img.shields.io/badge/status-stable-green)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

Node.js utilities for the Zuoya GMK87 keyboard: upload images to the display, configure RGB lighting, sync time, and apply presets — all via HID protocol.

## Hardware

- **Keyboard:** Zuoya GMK87
- **Vendor ID:** `0x320f` | **Product ID:** `0x5055`
- **Display:** 240x135 pixels, RGB565 encoding
- **Slots:** 2 image slots (0 and 1)
- **USB Interface:** 3 (vendor-specific, `usagePage 0xFF1C`)

## Install

```bash
npm install
```

### Dependencies

- `node-hid` — HID device communication
- `jimp` — Image processing
- ImageMagick (`magick` or `convert` in PATH) — for `sendimage` command

## Commands

| Command | Description |
|---|---|
| `npm run sendimage` | Upload images to the keyboard display |
| `npm run lights` | Configure RGB underglow and LED settings |
| `npm run preset` | Apply a preset lighting profile |
| `npm run timesync` | Sync system time to the keyboard |
| `npm run upload` | Debug: upload hardcoded test images |
| `npm run examples` | Run example lighting configurations |

## Usage

### Upload images

Upload both display slots at once (recommended — the upload session overwrites all image memory):

```bash
npm run sendimage -- --slot0 path/to/image1.png --slot1 path/to/image2.jpg
```

Upload a single slot (the other slot will be blank):

```bash
npm run sendimage -- --file path/to/image.png --slot 0
```

Upload animated GIFs:

```bash
npm run sendimage -- --slot0 animation.gif --slot1 static.png --ms 100
npm run sendimage -- --file animation.gif --slot 0 --ms 150
```

Options:
- `--slot0` / `--slot1` — Paths for each display slot (static images or GIFs)
- `--file` + `--slot` — Single image mode (backwards compatible)
- `--ms <number>` — Animation delay in milliseconds (min 60, default 100 for GIFs)
- `--show` — Which slot to display after upload (default: last uploaded)

Images and GIF frames are automatically extracted, converted, and resized to 240x135 via ImageMagick. The total number of frames across both slots must not exceed 36.

### Configure lighting

```bash
npm run lights -- --effect breathing --brightness 7 --red 255 --green 0 --blue 0
npm run lights -- --led-color blue --led-mode 3
npm run lights -- --effect rainbow-waterfall --brightness 9 --speed 3
```

Underglow options:
- `--effect` — Animation effect (name or 0-18)
- `--brightness` — 0-9
- `--speed` — 0-9 (0=fast, 9=slow)
- `--orientation` — 0 (left-to-right) or 1 (right-to-left)
- `--rainbow` — true/false
- `--red`, `--green`, `--blue` — 0-255

LED options:
- `--led-mode` — 0-4
- `--led-color` — Name or 0-8 (red, orange, yellow, green, teal, blue, purple, white, off)
- `--led-saturation` — 0-9
- `--led-rainbow` — true/false

Other:
- `--winlock` — true/false (Windows key lock)
- `--show-image` — 0 (time), 1 (slot 0), 2 (slot 1)

### Apply presets

```bash
npm run preset -- gaming
npm run preset -- relaxed
npm run preset -- party
npm run preset -- minimal
```

Available presets: `gaming`, `relaxed`, `party`, `minimal`, `productivity`, `purple-wave`, `matrix`, `sunset`

### Sync time

```bash
npm run timesync
```

All commands use read-modify-write to preserve existing settings.

## API

Import `src/api.js` to use the keyboard programmatically from your own project:

```js
import gmk87 from "./src/api.js";
// or: import { uploadImage, setLighting, showSlot, syncTime, readConfig, getKeyboardInfo } from "./src/api.js";
```

### Upload images

```js
// Static images to both slots
await gmk87.uploadImage("cat.png", 0, { slot0File: "cat.png", slot1File: "dog.jpg" });

// GIF to slot 0 (frames extracted automatically, max 36 total across both slots)
await gmk87.uploadImage("anim.gif", 0, { slot0File: "anim.gif", frameDuration: 100 });

// GIFs to both slots
await gmk87.uploadImage("a.gif", 0, { slot0File: "a.gif", slot1File: "b.gif", frameDuration: 150 });
```

### Change lighting

```js
// Underglow
await gmk87.setLighting({ underglow: { effect: 5, brightness: 7, hue: { red: 255, green: 0, blue: 128 } } });

// LED keys (color: 0=red, 1=orange, 2=yellow, 3=green, 4=teal, 5=blue, 6=purple, 7=white, 8=off)
await gmk87.setLighting({ led: { mode: 3, color: 5 } });
```

### Switch displayed slot

```js
await gmk87.showSlot(0); // show time
await gmk87.showSlot(1); // show slot 0
await gmk87.showSlot(2); // show slot 1
```

### Sync time & read config

```js
await gmk87.syncTime();

const config = await gmk87.readConfig();
console.log(config.underglow);     // { effect, brightness, speed, orientation, rainbow, hue }
console.log(config.led);           // { mode, saturation, rainbow, color }
console.log(config.showImage);     // 0, 1, or 2
console.log(config.image1Frames);  // frame count in slot 0
console.log(config.frameDuration); // animation delay in ms
```

All API functions handle device open/close automatically and use read-modify-write to preserve settings you don't explicitly change.

## Debug

Enable verbose protocol logging with:

```bash
DEBUG=1 npm run sendimage -- --slot0 image.png --slot1 image2.jpg
```

## Protocol

Based on USB captures of the official Zuoya app. Uses a clean command-response protocol on USB interface 3.

### Upload sequence (from sniffed captures)

```
INIT(0x01) → INIT(0x01) → CONFIG(0x06) → COMMIT(0x02) → READY(0x23) → FRAME_DATA(0x21) × N → COMMIT(0x02)
```

### Config read-modify-write

```
INIT(0x01) → PREP_READ(0x03) × 10 → COMMIT(0x02) → READ_CFG(0x05) × 12 → INIT(0x01) → CONFIG(0x06) → COMMIT(0x02)
```

### Frame structure

64-byte HID reports:

```
[0]    = 0x04 (report ID)
[1-2]  = checksum (uint16 LE, sum of bytes 3-63)
[3]    = command byte
[4]    = data length
[5-7]  = position (24-bit LE)
[8-63] = data payload (56 bytes max)
```

## File structure

```
src/
├── api.js                # Public API (import this for programmatic use)
├── sendImageMagick.js    # Image upload with ImageMagick preprocessing
├── uploadImage.js        # Debug: hardcoded test image upload
├── configureLights.js    # CLI for lighting configuration
├── loadPreset.js         # Preset loader
├── timesync.js           # Time sync
├── examples.js           # Example configurations
└── lib/
    └── device.js         # Core protocol library
presets.json              # Preset definitions
reference.py              # Python reference implementation (BSD license)
```

## References

- Python reference implementation by Jochen Eisinger (included as `reference.py`, BSD license)
- [@ikkentim](https://github.com/ikkentim) for the original C# reverse engineering: https://github.com/ikkentim/gmk87-usb-reverse

## License

MIT
