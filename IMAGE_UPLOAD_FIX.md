# GMK87 Image Upload Fix - macOS Compatibility

## Status: ✅ SLOT 1 WORKING | ⚠️ SLOT 2 WHITE IMAGE

## The Journey: From Broken to Working

### Initial Problem
Image upload worked on Linux but completely failed on macOS with the OLD protocol, causing:
- Device lockups requiring constant reconnections
- ACK mismatches
- Images not writing to device
- Corrupted/mixed data between slots

### Root Cause Discovery

The fundamental issue was a **protocol mismatch between macOS and Linux**:

#### 1. **Report ID Changes (macOS HID Layer)**
- Linux: HID report ID stays `0x04`
- macOS: HID layer changes report ID from `0x04` → `0x01`
- This caused checksum mismatches because checksums include the report ID

#### 2. **Python's Protocol is Different**
Looking at `reference.py`, we discovered:
- Python uses **`while True` loop** that keeps reading responses until it gets a match
- Python discards non-matching responses (handles unsolicited messages like 0x23 ready signals)
- Our old code only read ONCE and failed if checksums didn't match

#### 3. **Data Format Mismatch**
- OLD protocol: Sent frames with metadata (slot index embedded in each 60-byte chunk)
- Python protocol: Sends **raw pixel data** padded to 32KB boundaries
- Each image must be 65,536 bytes (rounded to 32KB: `((240*135*2) + 0x7fff) & ~0x7fff`)

#### 4. **Upload Strategy**
- Python CAN upload both images concatenated
- But our device seems to require **separate uploads per slot**
- Each slot needs its own: config → upload session → data → commit cycle

## The Solution

### Key Changes Made

#### 1. **Fixed `sendWithPosition()` to Loop Like Python**
```javascript
// OLD: Read once, fail if no match
const response = await readResponse(device, 150);
if (!response) return null;

// NEW: Loop and discard non-matching responses (Python style)
while (Date.now() - startTime < timeout) {
  const response = await readResponse(device, 50);
  if (!response) {
    await delay(5);
    continue;
  }

  // Check if command byte matches
  if (response[3] === buffer[3]) {
    return response.slice(4);  // Match found!
  }

  // Discard non-matching response, keep reading
  console.log(`Discarding non-matching response, continuing...`);
}
```

**Why this works**: macOS HID layer sends multiple responses, including unsolicited messages. Python's `while True` loop handles this by reading until it finds the right one.

#### 2. **Created `buildRawImageData()` Function**
```javascript
async function buildRawImageData(imagePath) {
  const img = await Jimp.read(imagePath);
  img.resize(DISPLAY_WIDTH, DISPLAY_HEIGHT);

  // Python: frame_size = ((DISPLAY_WIDTH * DISPLAY_HEIGHT * 2) + 0x7fff) & ~0x7fff
  const frameSize = ((DISPLAY_WIDTH * DISPLAY_HEIGHT * 2) + 0x7fff) & ~0x7fff;
  const frameBuffer = Buffer.alloc(frameSize, 0x00);  // 65,536 bytes

  // Convert pixels to RGB565
  let idx = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y++) {
    for (let x = 0; x < DISPLAY_WIDTH; x++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);
      frameBuffer[idx++] = (rgb565 >> 8) & 0xff;
      frameBuffer[idx++] = rgb565 & 0xff;
    }
  }

  return frameBuffer;  // Returns exactly 65,536 bytes
}
```

**Why this works**: Matches Python's `encode_frame` exactly - raw RGB565 data padded to 32KB boundaries.

#### 3. **Separate Uploads Per Slot**
```javascript
// Upload slot 0
await initializeDevice(device, 0, 1, 0);  // Config: slot0=1 frame, slot1=0
await startUploadSession(device);
await sendFrameData(device, imageData0);
await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);

// Wait between uploads
await delay(1000);

// Upload slot 1
await initializeDevice(device, 2, 1, 1);  // Config: both slots, show slot1
await startUploadSession(device);
await sendFrameData(device, imageData1);
await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);
```

**Why this works**: The device needs separate config→upload→commit cycles per slot. Concatenating both images confused the device about which data goes where.

#### 4. **Used Read-Modify-Write for Config**
```javascript
// Read current config
const currentConfig = parseConfigBuffer(await readConfigFromDevice(device));

// Modify only what we need
const configBuffer = buildConfigBuffer(currentConfig, {
  image1Frames: slot0Frames,
  image2Frames: slot1Frames,
  showImage: shownImage,
  time: true,
});

// Write back
await writeConfigToDevice(device, configBuffer);
```

**Why this works**: Preserves all existing device settings (lighting, LED, etc.) while only changing image-related fields.

## Current Status

### ✅ What's Working
- Slot 1 displays correct image
- No more device lockups
- No ACK mismatches
- Python protocol fully compatible with macOS
- Lighting/time sync still work (demo.js passing all tests)

### ⚠️ Current Issue
- **Slot 2 shows white image** instead of the second image
- Upload completes successfully but data isn't rendering correctly

### Possible Causes for Slot 2 Issue
1. **Frame count configuration**: Maybe slot 2 needs different config values
2. **Upload sequence**: Maybe we need to upload slot 2 BEFORE slot 1?
3. **Commit timing**: Maybe need different delays between operations
4. **Display setting**: The `showImage` parameter might need adjustment

## Files Changed

### `/src/lib/device.js`
- **`sendWithPosition()`**: Added Python-style response loop
- **`buildRawImageData()`**: New function for 32KB-padded raw pixel data
- **`initializeDevice()`**: Now uses read-modify-write config approach
- **`sendFrameData()`**: Sends raw data in 56-byte chunks with position tracking
- **`startUploadSession()`**: Uses Python protocol (sendWithPosition)

### `/src/uploadImage.js`
- Changed to upload each slot separately
- Uses `buildRawImageData()` instead of `buildImageFrames()`
- Separate config→upload→commit cycle per slot

## Protocol Comparison

### OLD Protocol (Broken on macOS)
```javascript
// Uses send() which compares full 8-byte ACK
// Each frame has metadata embedded
// Single read, no retry loop
// Failed due to macOS HID report ID changes
```

### NEW Protocol (Python-compatible, Works on macOS)
```javascript
// Uses sendWithPosition() with response loop
// Raw pixel data, no metadata per chunk
// Loops reading responses until match
// Handles macOS HID differences gracefully
```

## Next Steps

1. **Fix Slot 2 white image**:
   - Try different upload order (slot 2 first?)
   - Check if frame count needs adjustment
   - Verify data integrity for second upload

2. **Add error handling**:
   - Better retry logic
   - Verify image data before upload

3. **Clean up debug output**:
   - Remove DEBUG logs from sendWithPosition

4. **Test with animations**:
   - Verify multi-frame GIFs work
   - Test frame duration settings

## Key Learnings

1. **macOS HID is different**: Can't assume cross-platform USB compatibility
2. **Python's simplicity hides complexity**: The `while True` loop was critical but easy to miss
3. **Device protocol is finicky**: Separate uploads per slot matters even though Python concatenates
4. **Read-modify-write is essential**: Never send minimal configs, always preserve existing settings
5. **Patience and comparison**: Comparing working Python implementation was the breakthrough

## Testing Commands

```bash
# Test current implementation
node src/uploadImage.js

# Test lighting (should still work)
node demo.js

# Check device can be opened
node -e "import('./src/lib/device.js').then(d => console.log(d.findDeviceInfo()))"
```

---

**Author**: Debugging session with Claude Code
**Date**: 2025-11-28
**Status**: In Progress - 50% working (slot 1 ✓, slot 2 needs fix)
