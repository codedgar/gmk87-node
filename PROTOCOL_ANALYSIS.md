# GMK87 HID Protocol Analysis - Finding the Real Read Method

## Critical Discovery

The keyboard IS responding to our read commands, but we're misinterpreting the protocol. Let me analyze the actual responses:

### Response Pattern Analysis

When we send command 0x03 (read prep):
```
Sent:     04 07 00 03 04 00 00 00 [rest zeros]
Received: 04 07 00 03 aa 55 00 00

Sent:     04 0b 00 03 04 04 00 00 [rest zeros]
Received: 04 0b 00 03 03 00 18 00

Sent:     04 0f 00 03 04 08 00 00 [rest zeros]
Received: 04 0f 00 03 02 00 00 00
```

**Pattern found:**
- Bytes 0-2: MATCH (report ID + checksum)
- Byte 3: MATCH (command 0x03)
- Bytes 4-7: CONTAIN DATA (not echoing our request!)

### What We Were Doing Wrong

Our code expected the keyboard to echo back our request:
```javascript
const expectedAck = buf.slice(0, 8);
const receivedAck = response.slice(0, 8);
if (expectedAck.equals(receivedAck)) // This will ALWAYS fail!
```

But the keyboard is sending ACTUAL DATA in bytes 4-7, not echoing our request!

### Decoding the Responses

Looking at consistent patterns:

**Read prep 0 (pos 0):**
- Sent: position 0, length 4
- Response bytes 4-7: `aa 55 00 00`

**Read prep 1 (pos 4):**
- Sent: position 4, length 4
- Response bytes 4-7: `03 00 18 00`

**Read prep 2 (pos 8):**
- Sent: position 8, length 4
- Response bytes 4-7: `02 00 00 00`

These ARE the configuration bytes! The keyboard is responding correctly, we're just checking the wrong thing!

### Command 0x05 Responses

When reading actual config with command 0x05, we get 48 bytes total:
```
Raw config: 0001090200ffffffff0000000000000000000000ff00000000000000000902ff0000002756190228102500ffff000000
```

Breaking this down by the Python reference structure:
```
Byte 0:     00          - Unknown
Bytes 1-8:  01 09 02 00 ff ff ff ff - Underglow (effect=1, brightness=9, speed=2, etc.)
Bytes 9-20: 00 00 00... - Reserved
Byte 21:    00          - Winlock
Bytes 22-27: 00 00...   - Reserved
Bytes 28-32: 00 00 00 00 00 - LED settings
Byte 33:    00          - Show image
Byte 34:    09          - Image 1 frames (WAIT - this is NOT zero!)
Bytes 35-41: 02 ff 00 00 00 - Time
Bytes 43-44: 27 56      - Frame duration
Byte 46:    00          - Image 2 frames
```

## The Real Problem

### Issue 1: ACK Checking
We're checking if response === request, but we should check:
- Bytes 0-3 match (report ID, checksum, command)
- Bytes 4-7 contain DATA (not a copy of our request)

### Issue 2: Command 0x03 Purpose
Command 0x03 might not be "read prep" - it might be asking the keyboard to SEND data!

Let me check the Python reference more carefully:

```python
# Python sends command 3 with data=[0x00] * 4, pos=i*4
self.send_command(command_id=3, data=[0x00] * 4, pos=i*4)
```

This is WRITING zeros to prepare for reading, not reading itself!

Then command 5 reads:
```python
buffer.extend(self.send_command(command_id=5, data=[0x00] * 4, pos=i*4))
```

## New Understanding

The protocol is:
1. **Command 0x01** - Init
2. **Command 0x03** - Write zeros (clear read buffer?)
3. **Command 0x02** - Commit
4. **Command 0x05** - Read chunks

But we're getting data back from command 0x03 too!

## Alternative: The keyboard might use command 0x06 to READ

Looking at the reference.py send_command:
```python
def send_command(self, command_id, data=[], pos=0):
    ...
    self.usb.write(buffer)

    while True:
        response = self.usb.read()
        if response[0:3] == array.array('B', buffer[0:3]):
            return response[4:]  # Returns data from byte 4 onwards!
```

So the Python version:
- Sends a command
- Waits for response with matching header
- Returns bytes 4+ as the data

We should do the same!

## Corrected Read Implementation

Instead of checking for exact ACK match, we should:

```javascript
async function readConfigFromDevice(device) {
  // Step 1: Init
  await send(device, 0x01, Buffer.alloc(60, 0), false);

  // Step 2: Command 0x06 might READ when we send mostly zeros?
  // OR command 0x05 with different parameters?

  // Let me check what VIA does...
}
```

## Next Step: Analyze VIA Protocol

The official VIA software must read config. Let me check if there's a different command or if we need to use the QMK/VIA protocol instead of raw HID.

## QMK/VIA Protocol

VIA uses the QMK protocol which has specific commands:
- `0x01` - Get protocol version
- `0x02` - Get keyboard value
- `0x03` - Set keyboard value
- `0x04` - Dynamic keymap get
- etc.

But this keyboard might not use QMK/VIA protocol at all!

## Testing Strategy

Let's try a different approach - send command 0x06 with a READ flag:

Option A: Use byte 0x04 = 0x00 instead of 0x30/0x29 for read?
Option B: Use a different command entirely (0x04, 0x07, 0x08)?
Option C: The responses we're getting ARE the config, we just need to parse them correctly

## Critical Realization

Looking at our demo output again:
```
Raw config: 0001090200ffffffff...
Current configuration:
  Underglow effect: 1    ← This is NOT zero!
  LED mode: 0
  Image slots: 0, 0
```

**The config IS being read!** Effect = 1 matches the default!

The issue is that when we WRITE, we're not seeing the changes stick. Let me check if the write is actually working...

## New Hypothesis

What if:
1. Reading works fine (we get the config)
2. Writing is the problem (our writes don't stick)
3. The keyboard needs a different write sequence

Let me check the write protocol in Python:
```python
def update_config(self):
    self.send_command(1)
    self.send_command(command_id=6, data=self.config)  # Sends 48 bytes
    self.send_command(2)
```

We're doing the same thing! So why doesn't it work?

## Byte Offset Issue

Wait - in Python:
```python
buffer[8:8+len(data)] = data  # Data starts at byte 8!
```

But we're doing:
```javascript
writeData[0] = 0x30;
configBuffer.copy(writeData, 1);  // Config starts at byte 1!
```

**The offset might be wrong!**

Python puts data at byte 8 of the 64-byte buffer.
We're putting it at byte 4 (via send() which uses subarray(4)).

Let me check this offset issue...
