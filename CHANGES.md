# Bug Fix Implementation - Configuration Overwrite Issue

## Summary

Successfully implemented the fix for the configuration overwrite bug in the GMK87 Node.js implementation. The keyboard now properly reads existing configuration before making changes, preventing settings from being overwritten.

## Root Cause

The original implementation was creating configuration frames from scratch with default/zero values instead of:
1. Reading the current configuration from the keyboard
2. Modifying only the requested fields
3. Writing the merged configuration back

This caused any configuration change (lights, time, images) to overwrite all other settings.

## Files Modified

### 1. `src/lib/device.js` (Major Changes)

#### New Functions Added (Lines 287-552):
- **`readConfigFromDevice(device)`** - Reads 48-byte config from keyboard using commands 0x03 and 0x05
- **`parseConfigBuffer(configBuffer)`** - Parses raw 48-byte buffer into structured object
- **`buildConfigBuffer(existingConfig, changes)`** - Merges changes into existing config
- **`writeConfigToDevice(device, configBuffer)`** - Writes 48-byte config using command 0x06

#### Functions Refactored:
- **`sendConfigFrame()`** (Lines 584-622) - Now reads config first, merges changes, writes back
- **`configureLighting()`** (Lines 1109-1183) - Implements read-modify-write pattern
- **`uploadImageToDevice()`** (Lines 887-982) - Preserves other slot's frame count and lighting

#### Exports Updated (Lines 1255-1298):
Added new configuration management functions to exports

### 2. `package.json`

#### Added:
- New script: `"demo": "node demo.js"`

### 3. `demo.js` (New File)

Comprehensive demo script that tests all functionality:
- **Step 1:** Configure lighting (rainbow cycle)
- **Step 2:** Sync time (should preserve lighting)
- **Step 3:** Upload image to slot 0 (should preserve lighting & time)
- **Step 4:** Upload image to slot 1 (should preserve slot 0)
- **Step 5:** Change lighting (should preserve images)
- **Step 6:** Final time sync (should preserve everything)

## How to Test

Run the comprehensive demo:

```bash
npm run demo
```

The demo will:
1. Show colored console output indicating each stage
2. Apply different configurations sequentially
3. Verify that previous settings are preserved after each change
4. Display success/failure status for each step

## Expected Behavior (After Fix)

### Before the Fix ❌
- Setting lights → overwrites image slots to 0
- Uploading image → resets lighting to defaults
- Syncing time → loses lighting configuration

### After the Fix ✅
- Setting lights → preserves image slots and time
- Uploading image → preserves lighting and other slot
- Syncing time → preserves all settings
- All operations only modify their specific fields

## Technical Details

### Configuration Buffer Structure (48 bytes)

```
Byte 0:     Unknown/reserved
Bytes 1-8:  Underglow settings (effect, brightness, speed, orientation, rainbow, RGB)
Bytes 9-20: Unknown/reserved
Byte 21:    Windows lock
Bytes 22-27: Unknown/reserved
Bytes 28-32: LED settings (mode, saturation, unknown, rainbow, color)
Byte 33:    Show image selector (0=time, 1=slot0, 2=slot1)
Byte 34:    Image slot 1 frame count
Bytes 35-41: Time/date (BCD encoded)
Byte 42:    Unknown/reserved
Bytes 43-44: Frame duration (little-endian)
Bytes 45:   Unknown/reserved
Byte 46:    Image slot 2 frame count
Bytes 47:   Unknown/reserved
```

### Read/Write Protocol

**Reading Config:**
1. Send command 0x01 (INIT)
2. Send command 0x03 with read prep data (10 times)
3. Send command 0x02 (COMMIT)
4. Send command 0x05 to read 4-byte chunks (12 times for 48 bytes)

**Writing Config:**
1. Send command 0x01 (INIT)
2. Send command 0x06 with 48-byte config buffer (prefixed with 0x30)
3. Send command 0x02 (COMMIT)

## Backward Compatibility

All existing scripts continue to work:
- `npm run lights` - Still works, now preserves other settings
- `npm run timesync` - Still works, now preserves other settings
- `npm run sendimage` - Still works, now preserves other settings
- `npm run upload` - Still works, now preserves other settings

## Verification

To verify the fix is working:

1. **Manual Test:**
   ```bash
   # Set rainbow lighting
   npm run lights -- --effect rainbow-cycle --brightness 7

   # Upload an image (lighting should NOT reset)
   npm run sendimage -- --file nyan.bmp --slot 0

   # Sync time (lighting and image should persist)
   npm run timesync

   # Verify: Lights should still be rainbow, image should still display
   ```

2. **Automated Test:**
   ```bash
   npm run demo
   ```
   Watch the console output and your keyboard to verify all settings persist.

## Next Steps

This fix resolves the critical configuration overwrite bug. Future enhancements could include:
- Reading configuration to display current settings
- Preset management (save/load complete configurations)
- Configuration export/import functionality

## Credits

Fix based on analysis of the reference Python implementation by Jochen Eisinger which correctly implements the read-modify-write pattern for USB HID configuration management.
