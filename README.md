# GMK87 HID Image Uploader & Time Sync

![Status](https://img.shields.io/badge/status-WIP-yellow)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

Node.js utilities for uploading images and syncing time on GMK87 keyboard displays via HID protocol.

## Status

**Work in progress.** The upload works but consistency is hit-or-miss. Looking for help improving reliability, especially around:

- First row corruption (white pixels/artifacts)
- Frame timing and device backpressure
- HID write failures (EPIPE, EBUSY)
- Platform-specific quirks (macOS vs Linux vs Windows)

## Hardware

- **Vendor ID:** `0x320f`
- **Product ID:** `0x5055`
- **Display:** 240x135 pixels, RGB565 encoding
- **Slots:** 2 image slots (0 and 1)

## Install

```bash
npm install
```

### Dependencies

- `node-hid` - HID device communication
- `jimp` - Image processing
- ImageMagick (`magick` or `convert` binary in PATH) - for `sendImageMagick.js`

## Scripts

```bash
npm run sendimage   # Upload image with ImageMagick preprocessing
npm run upload      # Upload hardcoded test images
npm run timesync    # Sync device time and config
```

## Usage

### Upload with ImageMagick preprocessing

Recommended approach. Handles format conversion and resizing automatically.

```bash
npm run sendimage -- --file path/to/image.png --slot 0
npm run sendimage -- --file image.jpg --slot 1 --show=false
```

Options:
- `--file` (required) - Path to input image
- `--slot` (required) - Target slot: `0` or `1`
- `--show` (optional) - Display after upload (default: `true`)

### Upload multiple images

```bash
npm run upload
```

Hardcoded to upload `nyan.bmp` to slot 0 and `encoded-rgb555.bmp` to slot 1. Edit `src/uploadImage.js` to change sources.

### Time sync

```bash
npm run timesync
```

Syncs device clock and configures display settings. Sets the current system time on the keyboard's RTC and configures frame duration, shown image slot, and other display parameters.

**Config frame fields:**
- System time (seconds, minutes, hours, day, date, month, year)
- Frame duration (default: 1000ms)
- Shown image selector (0=time widget, 1=slot 0, 2=slot 1)
- Frame counts for each image slot

This command is also auto-run as part of the upload sequence. Can be run standalone to just update time without uploading images.

## Protocol

### Frame structure

64-byte HID reports with 60-byte payloads:

```
[0]    = 0x04 (report ID)
[1-2]  = checksum (uint16 LE, sum of bytes 3-63)
[3]    = command byte
[4-63] = payload (60 bytes)
```

### Image upload frames (0x21)

```
payload[0]    = 0x38 (56 data bytes flag)
payload[1-2]  = pixel offset (uint16 LE)
payload[3]    = image slot (0 or 1)
payload[4-59] = RGB565 pixel data (MSB first)
```

### Upload sequence

```
0x01                      → init
0x06 (config frame)       → time + display config
0x02                      → commit config
0x23                      → ???
0x01                      → init again
<500ms delay>
0x21 (frames...)          → pixel data
0x02                      → final commit
```

## Known issues

- **First row artifacts:** White pixels or corruption at y=0. Workaround: 500-600ms delay before pixel upload.
- **HID write failures:** Transient EPIPE/EBUSY errors. Mitigated with retry logic and pacing delays.
- **Offset calculation:** `sendImageMagick.js` uses `imageIndex * 0x28` offset (matches C# reference). `uploadImage.js` uses `0x00`. Both work inconsistently.
- **macOS open issues:** Opening by VID/PID sometimes fails. Retry logic helps.
- **Green keyboard flash:** Keyboard backlighting changes to green when image upload succeeds. Side effect of the display switch command.

## File structure

```
.
├── src/
│   ├── sendImageMagick.js  # ImageMagick pipeline (recommended)
│   ├── uploadImage.js      # Direct upload (hardcoded images)
│   └── timesync.js         # Time sync + config frame
├── nyan.bmp                # Test image
├── encoded-rgb555.bmp      # Test image
└── package.json
```

## Contributing

Help wanted on:

1. Reliable frame transmission (no drops, no corruption)
2. Understanding the mystery command bytes (0x23, config frame fields)
3. Proper offset calculation logic
4. Cross-platform HID stability

Open an issue or PR if you've got ideas.

## References

Huge thanks to [@ikkentim](https://github.com/ikkentim) for the original reverse engineering work:  
https://github.com/ikkentim/gmk87-usb-reverse

This Node.js port is based on that C# implementation. All protocol knowledge comes from their research.

## License

MIT