# Implementation Plan: Fix Configuration Overwrite Bug

## Problem Statement

The GMK87 keyboard currently has a critical bug where setting any configuration (images, lights, time) overwrites other configurations with incorrect values. This happens because:

1. The keyboard reports its current configuration when queried
2. Our Node.js implementation **does not read** this configuration before making changes
3. When we send a new configuration, we're overwriting the entire config block with default/empty values instead of preserving existing settings

## 1. Key Differences Between Current Implementation and reference.py

### A. Configuration Reading (THE CRITICAL MISSING PIECE)

**reference.py (Working Implementation):**
```python
# Lines 298-314: Keyboard.load_config()
def load_config(self):
    """Loads the current configuration from the keyboard."""
    self.send_command(1)  # Initialize

    # Read configuration in chunks (purpose unclear but required by protocol)
    for i in range(9):
        self.send_command(command_id=3, data=[0x00] * 4, pos=i*4)
    self.send_command(command_id=3, data=[0x00], pos=36)

    self.send_command(2)  # Commit

    # Read back 48 bytes of configuration data in 12 chunks of 4 bytes
    buffer=[]
    for i in range(12):
        buffer.extend(self.send_command(command_id=5, data=[0x00] * 4, pos=i*4))

    self.config_needs_update = False
    self.config = buffer  # Store the current config
```

**device.js (Current - BROKEN):**
```javascript
// NO EQUIVALENT FUNCTION EXISTS
// We never read the keyboard's current configuration!
```

**Impact:** This is the root cause of the bug. We create configuration frames from scratch with default values instead of reading the existing configuration and modifying only the fields we want to change.

---

### B. Configuration Modification Pattern

**reference.py (Working Implementation):**
```python
# Lines 333-348: set_datetime() example
def set_datetime(self):
    """Sets the keyboard's date and time to the current system time."""
    if not self.config:
        self.load_config()  # ← READS FIRST if not already loaded

    # Modify ONLY the date/time fields (bytes 35-41)
    self.config[DATE_OFFSET] = self._int_to_bcd(now.second)
    self.config[DATE_OFFSET + 1] = self._int_to_bcd(now.minute)
    # ... etc

    self.config_needs_update = True  # Mark for update
```

**device.js (Current - BROKEN):**
```javascript
// Lines 326-355: sendConfigFrame()
async function sendConfigFrame(device, shownImage = 0, ...) {
  const command = Buffer.alloc(64, 0x00);  // ← Creates EMPTY buffer!

  // Only sets specific fields, rest remain 0x00
  command[0x04] = 0x29;
  command[0x29] = shownImage;
  // ... etc

  return await send(device, 0x06, command.subarray(4));
}
```

**Impact:** We're sending a 64-byte frame with mostly zeros instead of preserving the existing configuration and only changing what we need.

---

### C. Update/Commit Pattern

**reference.py (Working Implementation):**
```python
# Lines 383-391: update_config()
def update_config(self):
    """Writes the modified configuration back to the keyboard."""
    if not self.config_needs_update:
        return  # Don't send if nothing changed

    self.send_command(1)  # Initialize
    self.send_command(command_id=6, data=self.config)  # Send FULL config buffer
    self.send_command(2)  # Commit
    self.config_needs_update = False
```

**device.js (Current - BROKEN):**
```javascript
// Lines 850-903: configureLighting()
async function configureLighting(config) {
  // ... reset/revive device ...

  const frame = buildLightingFrame(config);  // Creates NEW frame from scratch
  success = await trySendLightingFrame(device, frame, 3);

  // Missing: No read before write, no preservation of existing config
}
```

**Impact:** Every configuration change overwrites the entire config block instead of being a surgical modification.

---

### D. Configuration Buffer Structure

**reference.py Understanding:**
```python
# Configuration is 48 bytes total (lines 310-311)
# Read as 12 chunks of 4 bytes using command 0x05
#
# Known offsets (lines 39-43):
DATE_OFFSET = 35       # Bytes 35-41: time/date (7 bytes)
DELAY_OFFSET = 43      # Bytes 43-44: frame delay (2 bytes, little-endian)
FRAMES_1_OFFSET = 34   # Byte 34: number of frames in slot 1
FRAMES_2_OFFSET = 46   # Byte 46: number of frames in slot 2
#
# The full 48-byte config includes:
# - RGB lighting settings (underglow, LED modes)
# - Image display configuration
# - Time/date
# - Animation settings
# - Unknown/reserved fields
```

**device.js Current Understanding:**
```javascript
// Lines 705-778: buildLightingFrame()
// We know the structure for SENDING:
// Byte 4: 0x30 (full config) or 0x29 (display/time only)
// Bytes 9-16: Underglow settings
// Byte 29: Windows lock
// Bytes 36-40: LED settings
// Byte 41: showImage selector
// Byte 42: image1 frame count
// Bytes 43-49: Time/date
// Byte 54: image2 frame count
//
// BUT: We don't read these values back from the keyboard!
```

**Impact:** We know how to write the config but don't read it first, so we lose existing values.

---

### E. Command Protocol Differences

**reference.py Commands:**
```python
Command 1: Initialize/Start transaction
Command 2: Commit/End transaction
Command 3: Unknown read operation (used during load_config)
Command 5: Read configuration data (returns 4 bytes at a time)
Command 6: Write configuration data (sends full config)
Command 0x21: Upload image frame data
Command 0x23: Ready/sync signal
```

**device.js Commands:**
```javascript
Command 0x01: Initialize
Command 0x02: Commit
Command 0x06: Write configuration (but we don't read first!)
Command 0x21: Upload image frames
Command 0x23: Ready/sync
// Missing: Command 0x03 and 0x05 for reading config!
```

**Impact:** We're missing the read commands entirely from our implementation.

---

## 2. Implementation Plan to Fix the Bug

### Phase 1: Add Configuration Reading Capability

#### Step 1.1: Implement `readConfigFromDevice()` function in `device.js`

**Location:** After line 253 (after `send()` function)

**Implementation:**
```javascript
/**
 * Reads the current configuration from the device
 * This is critical for preserving existing settings when making changes
 * @param {HID.HID} device - Connected HID device
 * @returns {Promise<Buffer>} 48-byte configuration buffer
 * @throws {Error} If reading fails or device doesn't respond
 */
async function readConfigFromDevice(device) {
  console.log("Reading current configuration from device...");

  // Step 1: Initialize read transaction
  let success = await trySend(device, 0x01);
  if (!success) {
    throw new Error("Device not responding to INIT for config read");
  }

  // Step 2: Send read preparation commands (protocol requirement)
  // Purpose unclear but required by the keyboard's protocol
  for (let i = 0; i < 9; i++) {
    const readData = Buffer.alloc(60, 0x00);
    readData[0] = 0x04; // 4 bytes to read
    readData[1] = (i * 4) & 0xff; // Position LSB
    readData[2] = ((i * 4) >> 8) & 0xff; // Position MSB
    readData[3] = 0x00; // Position high byte

    success = await send(device, 0x03, readData, true);
    if (!success) {
      console.warn(`Warning: Read prep command ${i} not acknowledged`);
    }
  }

  // Final read prep for byte 36
  const finalReadData = Buffer.alloc(60, 0x00);
  finalReadData[0] = 0x01; // 1 byte to read
  finalReadData[1] = 36; // Position 36
  success = await send(device, 0x03, finalReadData, true);

  // Step 3: Commit read transaction
  success = await trySend(device, 0x02);
  if (!success) {
    throw new Error("Device not responding to COMMIT after read prep");
  }

  // Step 4: Read configuration data in 12 chunks of 4 bytes (48 bytes total)
  const configBuffer = Buffer.alloc(48, 0x00);

  for (let i = 0; i < 12; i++) {
    const position = i * 4;
    const readRequest = Buffer.alloc(60, 0x00);
    readRequest[0] = 0x04; // 4 bytes per chunk
    readRequest[1] = position & 0xff;
    readRequest[2] = (position >> 8) & 0xff;
    readRequest[3] = (position >> 16) & 0xff;

    // Send command 0x05 to read config chunk
    const buf = Buffer.alloc(64, 0x00);
    buf[0] = REPORT_ID;
    buf[3] = 0x05; // Read config command
    readRequest.copy(buf, 4);

    const chk = checksum(buf);
    buf[1] = chk & 0xff;
    buf[2] = (chk >> 8) & 0xff;

    device.write([...buf]);

    // Read response - should contain 4 bytes of config data
    const response = await readResponse(device, 150);
    if (!response || response.length < 8) {
      throw new Error(`Failed to read config chunk ${i} at position ${position}`);
    }

    // Extract 4 bytes from response (bytes 4-7 contain the data)
    response.slice(4, 8).copy(configBuffer, position);
  }

  console.log(`✓ Configuration read successfully (48 bytes)`);
  console.log(`  Raw config: ${configBuffer.toString('hex')}`);

  return configBuffer;
}
```

**Why this matters:** This function implements the missing read capability that reference.py has. Without it, we can never preserve existing settings.

---

#### Step 1.2: Implement `parseConfigBuffer()` helper function

**Location:** After the new `readConfigFromDevice()` function

**Implementation:**
```javascript
/**
 * Parses a 48-byte configuration buffer into a structured object
 * @param {Buffer} configBuffer - 48-byte raw configuration buffer
 * @returns {Object} Parsed configuration object
 */
function parseConfigBuffer(configBuffer) {
  if (configBuffer.length !== 48) {
    throw new Error(`Invalid config buffer length: ${configBuffer.length} (expected 48)`);
  }

  return {
    // Underglow settings (bytes 1-8 in the 48-byte buffer)
    underglow: {
      effect: configBuffer[1],
      brightness: configBuffer[2],
      speed: configBuffer[3],
      orientation: configBuffer[4],
      rainbow: configBuffer[5],
      hue: {
        red: configBuffer[6],
        green: configBuffer[7],
        blue: configBuffer[8],
      },
    },

    // Unknown/reserved bytes 9-20

    // Windows lock (byte 21 in the 48-byte buffer)
    winlock: configBuffer[21],

    // Unknown/reserved bytes 22-27

    // Big LED settings (bytes 28-32 in the 48-byte buffer)
    led: {
      mode: configBuffer[28],
      saturation: configBuffer[29],
      // byte 30 unknown
      rainbow: configBuffer[31],
      color: configBuffer[32],
    },

    // Image settings
    showImage: configBuffer[33], // byte 33: which image to display
    image1Frames: configBuffer[34], // byte 34: frames in slot 1

    // Time/date (bytes 35-41)
    time: {
      second: configBuffer[35],
      minute: configBuffer[36],
      hour: configBuffer[37],
      dayOfWeek: configBuffer[38],
      date: configBuffer[39],
      month: configBuffer[40],
      year: configBuffer[41],
    },

    // Animation delay (bytes 43-44, little-endian)
    frameDuration: configBuffer[43] | (configBuffer[44] << 8),

    // Image 2 frames
    image2Frames: configBuffer[46], // byte 46: frames in slot 2

    // Raw buffer for reference
    _raw: configBuffer,
  };
}
```

**Why this matters:** This makes the configuration human-readable and easier to work with. It also documents the config structure.

---

#### Step 1.3: Implement `buildConfigBuffer()` helper function

**Location:** After `parseConfigBuffer()`

**Implementation:**
```javascript
/**
 * Builds a 48-byte configuration buffer from a config object
 * Merges user changes with existing configuration
 * @param {Object} existingConfig - Current config (from parseConfigBuffer)
 * @param {Object} changes - Changes to apply
 * @returns {Buffer} 48-byte configuration buffer ready to send
 */
function buildConfigBuffer(existingConfig, changes) {
  // Start with the existing raw buffer if available
  const buffer = existingConfig._raw
    ? Buffer.from(existingConfig._raw)
    : Buffer.alloc(48, 0x00);

  // Apply underglow changes
  if (changes.underglow) {
    if (changes.underglow.effect !== undefined) buffer[1] = changes.underglow.effect;
    if (changes.underglow.brightness !== undefined) buffer[2] = changes.underglow.brightness;
    if (changes.underglow.speed !== undefined) buffer[3] = changes.underglow.speed;
    if (changes.underglow.orientation !== undefined) buffer[4] = changes.underglow.orientation;
    if (changes.underglow.rainbow !== undefined) buffer[5] = changes.underglow.rainbow;
    if (changes.underglow.hue) {
      if (changes.underglow.hue.red !== undefined) buffer[6] = changes.underglow.hue.red;
      if (changes.underglow.hue.green !== undefined) buffer[7] = changes.underglow.hue.green;
      if (changes.underglow.hue.blue !== undefined) buffer[8] = changes.underglow.hue.blue;
    }
  }

  // Apply winlock changes
  if (changes.winlock !== undefined) {
    buffer[21] = changes.winlock;
  }

  // Apply LED changes
  if (changes.led) {
    if (changes.led.mode !== undefined) buffer[28] = changes.led.mode;
    if (changes.led.saturation !== undefined) buffer[29] = changes.led.saturation;
    if (changes.led.rainbow !== undefined) buffer[31] = changes.led.rainbow;
    if (changes.led.color !== undefined) buffer[32] = changes.led.color;
  }

  // Apply image settings
  if (changes.showImage !== undefined) buffer[33] = changes.showImage;
  if (changes.image1Frames !== undefined) buffer[34] = changes.image1Frames;
  if (changes.image2Frames !== undefined) buffer[46] = changes.image2Frames;

  // Apply time/date changes
  if (changes.time) {
    const now = new Date();
    buffer[35] = toHexNum(now.getSeconds());
    buffer[36] = toHexNum(now.getMinutes());
    buffer[37] = toHexNum(now.getHours());
    buffer[38] = now.getDay();
    buffer[39] = toHexNum(now.getDate());
    buffer[40] = toHexNum(now.getMonth() + 1);
    buffer[41] = toHexNum(now.getFullYear() % 100);
  }

  // Apply frame duration changes
  if (changes.frameDuration !== undefined) {
    buffer[43] = changes.frameDuration & 0xff;
    buffer[44] = (changes.frameDuration >> 8) & 0xff;
  }

  return buffer;
}
```

**Why this matters:** This is the key to preserving existing config - we merge changes into the existing buffer instead of creating a new one from scratch.

---

### Phase 2: Refactor Configuration Writing Functions

#### Step 2.1: Create new `writeConfigToDevice()` function

**Location:** After the new `buildConfigBuffer()` function

**Implementation:**
```javascript
/**
 * Writes a 48-byte configuration buffer to the device
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer} configBuffer - 48-byte configuration to write
 * @returns {Promise<boolean>} True if write was successful
 * @throws {Error} If write fails
 */
async function writeConfigToDevice(device, configBuffer) {
  if (configBuffer.length !== 48) {
    throw new Error(`Invalid config buffer length: ${configBuffer.length} (expected 48)`);
  }

  console.log("Writing configuration to device...");
  console.log(`  Config data: ${configBuffer.toString('hex')}`);

  // Step 1: Initialize write transaction
  let success = await trySend(device, 0x01);
  if (!success) {
    throw new Error("Device not responding to INIT for config write");
  }

  // Step 2: Build the 64-byte frame for command 0x06
  const writeData = Buffer.alloc(60, 0x00);

  // First byte indicates config type
  // 0x30 = full config (includes RGB)
  // 0x29 = display/time only
  writeData[0] = 0x30;

  // Copy the 48-byte config into the payload
  configBuffer.copy(writeData, 1);

  // Step 3: Send command 0x06 with config data
  success = await send(device, 0x06, writeData, true);
  if (!success) {
    console.warn("⚠ Config write command may not have been acknowledged");
  }

  // Step 4: Commit the write transaction
  success = await trySend(device, 0x02);
  if (!success) {
    throw new Error("Device not responding to COMMIT after config write");
  }

  console.log("✓ Configuration written successfully");
  return true;
}
```

**Why this matters:** This matches the reference.py pattern of init → write → commit, using the actual config buffer.

---

#### Step 2.2: Refactor `configureLighting()` to use read-modify-write pattern

**Location:** Replace the existing `configureLighting()` function (lines 850-903)

**Implementation:**
```javascript
/**
 * Complete pipeline to configure lighting on the GMK87 device
 * FIXED: Now reads existing config first, then modifies only requested fields
 * @param {Object} changes - Configuration changes to apply (partial config object)
 * @returns {Promise<boolean>} True if configuration was successfully applied
 * @throws {Error} If device connection fails or configuration cannot be applied
 */
async function configureLighting(changes) {
  let device = openDevice();

  try {
    // Step 1: Drain device buffer
    console.log("Clearing device buffer...");
    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`  Drained ${stale.length} stale messages`);
    }

    // Step 2: Reset device state
    await resetDeviceState(device);

    // Step 3: Check device responsiveness (revive if needed)
    let success = await trySend(device, 0x01, undefined, 1);
    if (!success) {
      console.log("Device not responding, attempting revival...");
      const revived = await reviveDevice(device);
      if (!revived) {
        throw new Error("Device could not be revived.");
      }
      device = revived;
    }

    // Step 4: READ current configuration (THE FIX!)
    console.log("Reading current configuration from keyboard...");
    const currentConfigBuffer = await readConfigFromDevice(device);
    const currentConfig = parseConfigBuffer(currentConfigBuffer);

    console.log("Current configuration:");
    console.log(`  Underglow effect: ${currentConfig.underglow.effect}`);
    console.log(`  LED mode: ${currentConfig.led.mode}`);
    console.log(`  Image slots: ${currentConfig.image1Frames}, ${currentConfig.image2Frames}`);

    // Step 5: Merge changes with existing config
    console.log("Merging requested changes with existing configuration...");
    const newConfigBuffer = buildConfigBuffer(currentConfig, changes);

    // Step 6: Write merged configuration back
    success = await writeConfigToDevice(device, newConfigBuffer);

    if (!success) {
      console.warn("⚠ Lighting configuration may not have been acknowledged by device");
      return false;
    }

    console.log("✓ Lighting configuration applied successfully!");
    await delay(100);
    return true;
  } finally {
    try {
      if (device) device.close();
    } catch {}
  }
}
```

**Why this matters:** This is the core fix - we now read → merge → write instead of just writing defaults.

---

#### Step 2.3: Refactor `sendConfigFrame()` to use new pattern

**Location:** Replace the existing `sendConfigFrame()` function (lines 326-355)

**Implementation:**
```javascript
/**
 * Sends a configuration frame to the device with display and timing settings
 * FIXED: Now reads current config and only modifies time/display fields
 * @param {HID.HID} device - Connected HID device
 * @param {number} [shownImage=0] - Which image slot to display (0=time, 1=slot0, 2=slot1)
 * @param {number} [image0NumOfFrames=null] - Number of frames in slot 0 (null = don't change)
 * @param {number} [image1NumOfFrames=null] - Number of frames in slot 1 (null = don't change)
 * @returns {Promise<boolean>} True if command acknowledged successfully
 */
async function sendConfigFrame(
  device,
  shownImage = 0,
  image0NumOfFrames = null,
  image1NumOfFrames = null
) {
  // Read current config
  const currentConfigBuffer = await readConfigFromDevice(device);
  const currentConfig = parseConfigBuffer(currentConfigBuffer);

  // Build changes object
  const changes = {
    showImage: shownImage,
    time: true, // Indicates we want to update time to now
  };

  // Only set frame counts if explicitly provided
  if (image0NumOfFrames !== null) {
    changes.image1Frames = image0NumOfFrames;
  }
  if (image1NumOfFrames !== null) {
    changes.image2Frames = image1NumOfFrames;
  }

  // Build merged config
  const newConfigBuffer = buildConfigBuffer(currentConfig, changes);

  // Write it back
  return await writeConfigToDevice(device, newConfigBuffer);
}
```

**Why this matters:** Time sync no longer overwrites lighting settings or image configurations.

---

### Phase 3: Update Image Upload Functions

#### Step 3.1: Update `uploadImageToDevice()` to preserve config

**Location:** Replace lines 630-677 in `uploadImageToDevice()`

**Changes needed:**
```javascript
async function uploadImageToDevice(imagePath, imageIndex = 0, options = {}) {
  const { showAfter = true } = options;
  const shownImageValue = showAfter ? imageIndex + 1 : 0;

  let device = openDevice();

  try {
    // ... existing drain and reset code ...

    // CHANGE: Initialize with config reading
    device = await initializeDevice(device, shownImageValue);

    // NEW: Read current config to get frame counts for the OTHER slot
    console.log("Reading current configuration...");
    const currentConfigBuffer = await readConfigFromDevice(device);
    const currentConfig = parseConfigBuffer(currentConfigBuffer);

    // Build frames for the image we're uploading
    console.log(`Building frames for slot ${imageIndex}...`);
    const frames = await buildImageFrames(imagePath, imageIndex);
    const numFrames = Math.ceil(frames.length / 28); // Calculate frame count

    // Prepare config update with frame counts
    const configChanges = {
      showImage: shownImageValue,
      time: true, // Update time too
    };

    // Set frame count for the slot we're uploading to
    // Preserve frame count for the other slot
    if (imageIndex === 0) {
      configChanges.image1Frames = numFrames;
      // image2Frames not set, will be preserved from currentConfig
    } else {
      configChanges.image2Frames = numFrames;
      // image1Frames not set, will be preserved from currentConfig
    }

    // Update config with new frame counts
    const newConfigBuffer = buildConfigBuffer(currentConfig, configChanges);
    await writeConfigToDevice(device, newConfigBuffer);

    // Send the actual image frames
    console.log(`Uploading ${frames.length} frames...`);
    await sendFrames(device, frames, `slot ${imageIndex}`);

    const success = await trySend(device, 0x02);
    if (!success) {
      console.warn("Final COMMIT may not have been acknowledged");
    }

    console.log("✓ Upload complete!");
    return true;
  } finally {
    try {
      if (device) device.close();
    } catch {}
  }
}
```

**Why this matters:** Uploading to slot 0 won't erase the frame count for slot 1, and won't reset lighting settings.

---

### Phase 4: Update Exports and Deprecate Old Functions

#### Step 4.1: Add new exports to `device.js`

**Location:** Lines 937-975 (exports section)

**Add these exports:**
```javascript
export {
  // ... existing exports ...

  // New configuration management functions
  readConfigFromDevice,
  parseConfigBuffer,
  buildConfigBuffer,
  writeConfigToDevice,
}
```

#### Step 4.2: Deprecate `buildLightingFrame()`

**Location:** Add deprecation notice to `buildLightingFrame()` function (line 705)

**Add comment:**
```javascript
/**
 * Builds a lighting configuration frame
 * @deprecated Use readConfigFromDevice + buildConfigBuffer + writeConfigToDevice instead
 * This function creates config from scratch and will overwrite existing settings
 * ... rest of JSDoc ...
 */
function buildLightingFrame(config) {
  console.warn("⚠ buildLightingFrame is deprecated - use read-modify-write pattern instead");
  // ... existing implementation ...
}
```

---

### Phase 5: Testing Strategy

#### Test Case 1: Lighting Configuration Preservation
```bash
# Set underglow to rainbow
npm run lights -- --effect rainbow-cycle --brightness 5

# Upload an image (should NOT reset the lighting)
npm run sendimage -- --file test.png --slot 0

# Verify: Lighting should still be rainbow at brightness 5
```

#### Test Case 2: Image Slot Preservation
```bash
# Upload image to slot 0
npm run sendimage -- --file image1.png --slot 0

# Upload image to slot 1 (should NOT erase slot 0)
npm run sendimage -- --file image2.png --slot 1

# Verify: Both images should be available
```

#### Test Case 3: Time Sync Preservation
```bash
# Set lighting configuration
npm run lights -- --effect breathing --led-color blue

# Sync time (should NOT reset lighting)
npm run timesync

# Verify: Lighting should still be breathing/blue
```

#### Test Case 4: Multiple Sequential Changes
```bash
# Change lighting
npm run lights -- --effect waterfall --brightness 8

# Sync time
npm run timesync

# Upload image
npm run sendimage -- --file test.png --slot 0

# Change lighting again
npm run lights -- --speed 5

# Verify: Image still displayed, waterfall effect at speed 5, brightness 8
```

---

## Summary of Changes

### Files to Modify:
1. **`src/lib/device.js`** - Add read functions, refactor write functions
2. **`src/configureLights.js`** - Already uses `configureLighting()`, should work after device.js fix
3. **`src/timesync.js`** - Should work after `sendConfigFrame()` is fixed

### New Functions Added:
- `readConfigFromDevice()` - Reads 48-byte config from keyboard
- `parseConfigBuffer()` - Parses config buffer to object
- `buildConfigBuffer()` - Merges changes with existing config
- `writeConfigToDevice()` - Writes 48-byte config to keyboard

### Functions Modified:
- `configureLighting()` - Now uses read-modify-write pattern
- `sendConfigFrame()` - Now reads current config first
- `uploadImageToDevice()` - Now preserves other slot's frame count

### Functions Deprecated:
- `buildLightingFrame()` - Replaced by buildConfigBuffer()

### Root Cause Fixed:
**Before:** We created configuration frames from scratch with default values, overwriting everything.

**After:** We read the current configuration, modify only the requested fields, and write back the merged result.

This matches the reference.py implementation's pattern and will eliminate the configuration overwrite bug completely.
