# GMK87 Configurator

![Status](https://img.shields.io/badge/status-stable-green)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

Upload images to the keyboard display, configure RGB lighting, sync the clock, and apply presets on the Zuoya GMK87 keyboard.

## Hardware

- **Keyboard:** Zuoya GMK87
- **Vendor ID:** `0x320f` | **Product ID:** `0x5055`
- **Display:** 240x135 pixels, RGB565, 2 image slots
- **USB Interface:** 3 (vendor-specific, `usagePage 0xFF1C`)

## App

Desktop application with a graphical interface. Supports Windows, macOS, and Linux.

[![Windows](https://img.shields.io/badge/Windows-Download-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/codedgar/gmk87-node/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-Download-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/codedgar/gmk87-node/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-Download-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/codedgar/gmk87-node/releases/latest)

Go to [Releases](https://github.com/codedgar/gmk87-node/releases/latest), download the file for your OS, and install it.

| OS | File |
|---|---|
| Windows | `.exe` installer |
| macOS | `.dmg` |
| Linux | `.AppImage` or `.deb` |

> **Linux users:** Copy the included `50-gmk87.rules` to `/etc/udev/rules.d/` and reload udev to allow HID access without root.

## CLI

Command-line tools for the terminal. Requires [Node.js](https://nodejs.org) (v14+).

### Install

```bash
git clone https://github.com/codedgar/gmk87-node.git
cd gmk87-node
npm install
```

### Commands

| Command | What it does |
|---|---|
| `npm run sendimage` | Upload images to the display |
| `npm run lights` | Configure RGB underglow and LEDs |
| `npm run preset` | Apply a preset lighting profile |
| `npm run timesync` | Sync system time to the keyboard |

### Upload images

Both slots at once (recommended, upload session overwrites all image memory):

```bash
npm run sendimage -- --slot0 image1.png --slot1 image2.jpg
```

Single slot (the other slot will be blank):

```bash
npm run sendimage -- --file image.png --slot 0
```

Animated GIFs:

```bash
npm run sendimage -- --slot0 animation.gif --slot1 static.png --ms 100
```

Options:

| Flag | Description |
|---|---|
| `--slot0` / `--slot1` | Path for each display slot (static or GIF) |
| `--file` + `--slot` | Single image mode |
| `--ms <number>` | Animation delay in ms (min 60, default 100) |
| `--show` | Which slot to display after upload |

Images are automatically resized to 240x135. Max 36 frames total across both slots.

### Configure lighting

```bash
npm run lights -- --effect breathing --brightness 7 --red 255 --green 0 --blue 0
npm run lights -- --led-color blue --led-mode 3
npm run lights -- --effect rainbow-waterfall --brightness 9 --speed 3
```

Underglow options:

| Flag | Values |
|---|---|
| `--effect` | Name or 0-18 |
| `--brightness` | 0-9 |
| `--speed` | 0-9 (0 = fast, 9 = slow) |
| `--orientation` | 0 (left-to-right) or 1 (right-to-left) |
| `--rainbow` | true / false |
| `--red`, `--green`, `--blue` | 0-255 |

LED options:

| Flag | Values |
|---|---|
| `--led-mode` | 0-4 |
| `--led-color` | Name or 0-8 (red, orange, yellow, green, teal, blue, purple, white, off) |
| `--led-saturation` | 0-9 |
| `--led-rainbow` | true / false |

Other:

| Flag | Values |
|---|---|
| `--winlock` | true / false |
| `--show-image` | 0 (time), 1 (slot 0), 2 (slot 1) |

### Apply presets

```bash
npm run preset -- gaming
```

Available: `gaming`, `relaxed`, `party`, `minimal`, `productivity`, `purple-wave`, `matrix`, `sunset`

### Sync time

```bash
npm run timesync
```

### Debug logging

```bash
DEBUG=1 npm run sendimage -- --slot0 image.png --slot1 image2.jpg
```

## API

Import `src/api.js` to control the keyboard from your own code.

```bash
npm install codedgar/gmk87-node
```

```js
import gmk87 from "gmk87-hid-uploader";
```

Or with named imports:

```js
import { uploadImage, setLighting, showSlot, syncTime, readConfig, getKeyboardInfo } from "gmk87-hid-uploader";
```

### Functions

#### `uploadImage(imagePath, slot, options)`

Upload static images or GIFs to the display.

```js
await gmk87.uploadImage("cat.png", 0, { slot0File: "cat.png", slot1File: "dog.jpg" });
await gmk87.uploadImage("anim.gif", 0, { slot0File: "anim.gif", frameDuration: 100 });
```

#### `setLighting(changes)`

Configure underglow and LED settings. Uses read-modify-write, so unspecified settings are preserved.

```js
await gmk87.setLighting({
  underglow: { effect: 5, brightness: 7, hue: { red: 255, green: 0, blue: 128 } },
});

await gmk87.setLighting({
  led: { mode: 3, color: 5 },
});
```

#### `showSlot(slot)`

Switch the display. `0` = time, `1` = slot 0, `2` = slot 1.

```js
await gmk87.showSlot(2);
```

#### `syncTime()`

Send system time to the keyboard clock.

```js
await gmk87.syncTime();
```

#### `readConfig()`

Read the current keyboard configuration.

```js
const config = await gmk87.readConfig();
// config.underglow  -> { effect, brightness, speed, orientation, rainbow, hue }
// config.led        -> { mode, saturation, rainbow, color }
// config.showImage  -> 0, 1, or 2
```

#### `getKeyboardInfo()`

Get device info (manufacturer, product, vendor/product IDs).

```js
const info = gmk87.getKeyboardInfo();
```

All API functions handle device open/close automatically.

## Protocol

Based on USB captures of the official Zuoya app. Uses command-response on USB interface 3.

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

## References

- Python reference implementation by Jochen Eisinger (included as `reference.py`, BSD license)
- [@ikkentim](https://github.com/ikkentim) for the original C# reverse engineering: https://github.com/ikkentim/gmk87-usb-reverse

## License

MIT
