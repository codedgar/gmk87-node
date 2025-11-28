# Real Fix: Implement Python Protocol in Node.js

## Root Cause Found

The Python `reference.py` and our Node.js implementation use **different packet structures**:

### Python Protocol (Working):
```
[0]    = 0x04 (report ID)
[1-2]  = checksum
[3]    = command
[4]    = data length
[5-7]  = position (24-bit, little-endian)
[8+]   = actual data
```

### Current Node.js Protocol (Incomplete):
```
[0]    = 0x04 (report ID)
[1-2]  = checksum
[3]    = command
[4-63] = raw data (no metadata)
```

## The Fix

We need to create a NEW send function that matches Python's protocol for commands 0x03, 0x05, and 0x06:

```javascript
/**
 * Sends a command using the Python/USB protocol format
 * This is different from the HID format - includes length and position
 */
async function sendWithPosition(device, commandId, data, pos = 0) {
  if (data.length > 56) {
    throw new Error("Data cannot exceed 56 bytes");
  }

  const buffer = Buffer.alloc(64, 0x00);
  buffer[0] = 0x04;           // Report ID
  buffer[3] = commandId;      // Command
  buffer[4] = data.length;    // LENGTH (this is what we were missing!)
  buffer[5] = pos & 0xff;     // Position LSB
  buffer[6] = (pos >> 8) & 0xff;  // Position mid
  buffer[7] = (pos >> 16) & 0xff; // Position MSB

  // Data starts at byte 8
  data.copy(buffer, 8);

  // Checksum bytes 3-63
  const chk = checksum(buffer);
  buffer[1] = chk & 0xff;
  buffer[2] = (chk >> 8) & 0xff;

  device.write([...buffer]);

  // Wait for response
  const response = await readResponse(device, 150);
  if (!response) {
    return null;
  }

  // Check if response header matches (bytes 0-3)
  if (response[0] === buffer[0] &&
      response[1] === buffer[1] &&
      response[2] === buffer[2]) {
    // Return data from byte 4 onwards (like Python does)
    return response.slice(4);
  }

  return null;
}
```

## Updated Read Implementation

```javascript
async function readConfigFromDevice(device) {
  // Step 1: Init
  let resp = await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);

  // Step 2: Send command 0x03 to prepare reading
  for (let i = 0; i < 9; i++) {
    await sendWithPosition(device, 0x03, Buffer.alloc(4, 0), i * 4);
  }
  await sendWithPosition(device, 0x03, Buffer.alloc(1, 0), 36);

  // Step 3: Commit
  await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);
  await delay(100); // Python waits before command 2

  // Step 4: Read config in 4-byte chunks using command 0x05
  const configBuffer = Buffer.alloc(48, 0x00);

  for (let i = 0; i < 12; i++) {
    const position = i * 4;
    const chunk = await sendWithPosition(device, 0x05, Buffer.alloc(4, 0), position);

    if (chunk && chunk.length >= 4) {
      // chunk contains the response data starting from byte 0
      chunk.slice(0, 4).copy(configBuffer, position);
    }
  }

  return configBuffer;
}
```

## Updated Write Implementation

```javascript
async function writeConfigToDevice(device, configBuffer) {
  // Step 1: Init
  await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);

  // Step 2: Write config using command 0x06
  await sendWithPosition(device, 0x06, configBuffer, 0);

  // Step 3: Commit
  await delay(100); // Python waits before command 2
  await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);

  return true;
}
```

## Why This Will Work

1. **Matches Python's exact protocol** - byte-for-byte compatible
2. **Includes length metadata** - keyboard knows how much data to expect
3. **Includes position metadata** - keyboard knows where data goes
4. **Returns actual data** - response parsing matches Python
5. **Data starts at byte 8** - not byte 4 like we were doing

## Implementation Steps

1. Add `sendWithPosition()` function to device.js
2. Rewrite `readConfigFromDevice()` to use it
3. Rewrite `writeConfigToDevice()` to use it
4. Keep existing `send()` function for other commands (0x21 image upload, etc.)
5. Test read/write independently before integrating

This should work because we're now speaking the exact same protocol as the Python reference!
