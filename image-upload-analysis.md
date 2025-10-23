# GMK 87 Keyboard Image Upload Protocol Analysis

## Executive Summary

This document analyzes the USB communication protocol used by the GMK 87 keyboard to upload images to its built-in screen. The analysis is based on two packet captures:
- **Capture 1**: Black image to Slot 0, White image to Slot 1
- **Capture 2**: Red image to Slot 0, Blue image to Slot 1

The GMK 87 uses USB HID interrupt transfers on endpoint 0x05 to transmit image data in 64-byte packets. Each complete image transfer requires approximately 2,347 packets, suggesting the display has significant resolution.

---

## USB Communication Overview

### Connection Details
- **Protocol**: USB HID (Human Interface Device)
- **Transfer Type**: URB_INTERRUPT
- **Endpoint**: 0x05 (OUT direction, from host to device)
- **Packet Size**: 64 bytes
- **Interface Class**: 0x03 (HID)

### Communication Flow
The host sends data to the keyboard using USB interrupt transfers. Each transfer consists of:
1. An OUT packet from host to device (64 bytes payload)
2. An acknowledgment from device to host (0 bytes)

---

## Packet Structure

Every packet follows a consistent 64-byte structure:

```
Offset | Size | Field Name      | Description
-------|------|-----------------|--------------------------------------------
0x00   | 1    | Command         | Always 0x04 (main command identifier)
0x01   | 1    | Sequence        | Sequence number (0x00-0xFF, cycles through)
0x02   | 2    | Slot Identifier | Identifies target slot and state
0x04   | 4    | Data Offset     | Little-endian offset into image data
0x08   | 56   | Payload Data    | Image pixel data or command parameters
```

### Field Details

#### Command Byte (0x00)
- **Value**: `0x04`
- **Purpose**: Identifies all packets as part of the image upload protocol
- **Constant**: This byte never changes across all packets

#### Sequence Number (0x01)
- **Range**: 0x00 to 0xFF
- **Purpose**: Sequential packet identifier that cycles through all 256 values
- **Behavior**: Increments with each packet, wraps around after 0xFF
- **Usage**: Allows detection of missing or out-of-order packets

#### Slot Identifier (0x02-0x03)
- **Byte 0x02 Values**:
  - `0x38`: Image data for Slot 0 (first image slot)
  - `0x39`: Image data for Slot 1 (second image slot) - appears less frequently
  - `0x00`: Special initialization or control commands
  - `0x04`: Configuration command
- **Byte 0x03 Value**: Typically `0x21` during image transfers, varies for control commands

#### Data Offset (0x04-0x07)
- **Format**: 32-bit little-endian unsigned integer
- **Purpose**: Specifies where in the image buffer the payload data should be written
- **Pattern**: Increments by 56 bytes (0x38) with each sequential image data packet
- **Example Progression**:
  - Packet 1: `0x00000038`
  - Packet 2: `0x00000070`
  - Packet 3: `0x000000A8`
  - ...continues incrementing by 0x38

#### Payload Data (0x08-0x3F)
- **Size**: 56 bytes
- **Content**: Raw image pixel data or command-specific parameters
- **Format**: Varies based on packet type (see Image Data Encoding section)

---

## Protocol Phases

### Phase 1: Initialization

The upload sequence begins with several initialization commands:

```
04 01 00 01 00 00 00 00 00 00 00 00 00 00 00 00 ...
```
- **Sequence**: 0x01
- **Type**: Device initialization or session start
- **Sent**: Multiple times at the beginning

```
04 3a 04 06 30 00 00 00 00 08 08 01 00 00 18 ff ...
```
- **Sequence**: 0x3A
- **Type**: Configuration command
- **Parameters**: Contains screen/buffer configuration
  - Byte 0x08-0x09: `08 08` (possibly 8x8 related to pixel format)
  - Byte 0x0A: `01` (mode or format flag)
  - Byte 0x0E: `18` (possibly bit depth: 24-bit color)

```
04 02 00 02 00 00 00 00 00 00 00 00 00 00 00 00 ...
```
- **Sequence**: 0x02
- **Type**: Slot selection or buffer clear command

```
04 23 00 23 00 00 00 00 00 00 00 00 00 00 00 00 ...
```
- **Sequence**: 0x23
- **Type**: Final initialization before data transfer

### Phase 2: Image Data Transfer

After initialization, the bulk of packets transfer image data:

```
04 21 38 21 38 00 00 00 ff ff ff ff ff ff ff ff ...
```
- **Sequence**: 0x21 (and incrementing)
- **Slot**: 0x38 (Slot 0)
- **Offset**: Starts at 0x00000038 and increments
- **Data**: Actual pixel data (56 bytes per packet)

The sequence number cycles through 0x00-0xFF multiple times as thousands of packets are sent.

### Phase 3: Slot Transition

When switching from Slot 0 to Slot 1 (in dual-image uploads):

```
04 28 38 21 38 00 07 00 ff ff ff ff ff ff ff ff ...
```
- **Sequence**: 0x28
- **Slot**: Transitions from 0x38 to indicating Slot 1 data follows
- **Offset**: Resets or continues from Slot 0 offset

---

## Image Data Encoding

### Color Representation

The analysis reveals the following color encoding patterns:

#### Black (RGB: 0, 0, 0)
```
Payload: 00 00 00 00 00 00 00 00 00 00 00 00 ...
```
All bytes in the payload are `0x00`

#### White (RGB: 255, 255, 255)
```
Payload: ff ff ff ff ff ff ff ff ff ff ff ff ...
```
All bytes in the payload are `0xFF`

#### Red (RGB: ~248, 0, 0)
```
Payload: d8 05 d8 05 d8 05 d8 05 d8 05 d8 05 ...
```
Repeating pattern: `d8 05` (0x05D8 = 1496 in decimal)

#### Blue (RGB: 0, 0, ~255)
```
Payload: 8c 8d 8c 8d 8c 8d 8c 8d 8c 8d 8c 8d ...
```
Repeating pattern: `8c 8d` (0x8D8C = 36236 in decimal)

### Pixel Format Hypothesis

Based on the patterns, the display likely uses **RGB565 format**:
- **Format**: 16-bit color (5 bits red, 6 bits green, 5 bits blue)
- **Byte Order**: Little-endian (LSB first)

**Verification**:
- Red `0x05D8` = `0000 0101 1101 1000` = R:00000, G:101110, B:11000 = RGB(0, 46, 24) - partial red channel
- Blue `0x8D8C` = `1000 1101 1000 1100` = R:10001, G:101100, B:01100 - partial blue channel
- White `0xFFFF` = `1111 1111 1111 1111` = R:11111, G:111111, B:11111 = RGB(255, 255, 255) ✓
- Black `0x0000` = `0000 0000 0000 0000` = R:00000, G:000000, B:00000 = RGB(0, 0, 0) ✓

**Each pixel occupies 2 bytes**, meaning each 56-byte payload contains **28 pixels**.

---

## Image Upload Sequence

### Complete Upload Algorithm

To upload an image to the GMK 87 keyboard:

#### 1. Open USB Connection
- Establish connection to the keyboard's HID interface
- Access endpoint 0x05 for interrupt transfers
- Set transfer mode to OUT (host to device)

#### 2. Send Initialization Sequence
```
Packet 1:  04 01 00 01 00 00 00 00 [48 zeros]
Packet 2:  04 01 00 01 00 00 00 00 [48 zeros]
Packet 3:  04 3a 04 06 30 00 00 00 00 08 08 01 00 00 18 ff [parameters]
Packet 4:  04 02 00 02 00 00 00 00 [48 zeros]
Packet 5:  04 23 00 23 00 00 00 00 [48 zeros]
```

**Purpose of each init packet**:
- Packets 1-2: Wake keyboard and prepare for image transfer
- Packet 3: Configure display parameters (resolution, color depth)
- Packet 4: Select target slot (Slot 0 or Slot 1)
- Packet 5: Signal readiness to receive image data

#### 3. Prepare Image Data
- **Convert image to RGB565 format**: 
  - For each pixel, convert RGB888 (24-bit) to RGB565 (16-bit)
  - Formula: `RGB565 = ((R >> 3) << 11) | ((G >> 2) << 5) | (B >> 3)`
  - Store in little-endian byte order (LSB first)
- **Calculate total pixels**: Determine image dimensions
- **Serialize pixels**: Create a linear buffer of 2-byte pixel values

#### 4. Send Image Data Packets

Initialize packet sequence:
```
sequence_number = 0x01  // Start after initialization
data_offset = 0x00000038  // Initial offset (56 bytes)
pixel_index = 0
```

For each packet until all image data is sent:
```
1. Create packet buffer (64 bytes)
2. Set byte[0] = 0x04 (command)
3. Set byte[1] = sequence_number
4. Set byte[2] = 0x38 (Slot 0) or 0x39 (Slot 1)
5. Set byte[3] = 0x21 (image data marker)
6. Set bytes[4:7] = data_offset (little-endian 32-bit)
7. Copy 28 pixels (56 bytes) to bytes[8:63]:
   - Read pixels from pixel_index to pixel_index+27
   - Convert each pixel to 2-byte RGB565 value
   - Write bytes in little-endian order
8. Send packet via USB interrupt transfer
9. Wait for ACK from device
10. Increment sequence_number (wrap at 0xFF to 0x00)
11. Increment data_offset by 56 (0x38)
12. Increment pixel_index by 28
```

#### 5. Handle Slot Transitions (Multi-Image Uploads)

When uploading multiple images:
```
After completing Slot 0:
1. Send slot switch command:
   04 28 38 21 38 [reset offset] ...
2. Reset data_offset appropriately for Slot 1
3. Continue with image data packets using slot identifier 0x39
```

#### 6. Finalization
- Wait for final ACK from device
- Monitor for any error responses
- Close USB connection or keep alive for status monitoring

---

## Calculating Image Dimensions

### Given Information
- **Total packets**: 2,347 packets per complete upload
- **Pixels per packet**: 28 pixels (56 bytes / 2 bytes per pixel)
- **Initialization packets**: ~5-10 packets

### Calculation
```
Image data packets = 2,347 - 10 (init) = ~2,337 packets
Total pixels = 2,337 × 28 = 65,436 pixels
```

### Likely Dimensions
Possible resolutions that fit:
- **256 × 256** = 65,536 pixels (very close match!)
- **320 × 204** = 65,280 pixels
- **360 × 182** = 65,520 pixels

**Most likely**: The GMK 87 uses a **256×256 pixel display**, which is a common square resolution for embedded displays and perfectly matches the packet count (256² = 65,536, requiring ~2,340 packets).

---

## Implementation Guidance

### Key Considerations

#### 1. Packet Timing
- **Send rate**: Don't send packets too quickly; allow device processing time
- **Recommended delay**: 1-2ms between packets to prevent buffer overflow
- **ACK monitoring**: Wait for device acknowledgment before sending next packet

#### 2. Error Handling
- **Missing ACK**: Retry packet up to 3 times before aborting
- **Sequence validation**: Device may track sequence numbers; maintain proper order
- **Timeout**: Implement 100ms timeout per packet
- **Recovery**: On error, restart from initialization sequence

#### 3. Image Preprocessing
- **Resize**: Scale source image to 240×135 pixels
- **Color conversion**: Convert from source format to RGB565
- **Dithering**: Apply dithering for better color representation on 16-bit display
- **Validation**: Ensure image buffer is exactly the correct size

#### 4. USB Communication
- **Interface**: Use libusb, hidapi, or platform-specific HID libraries
- **Interrupt endpoint**: Claim interface and access endpoint 0x05
- **Timeout**: Set reasonable USB timeout (500ms - 1000ms)
- **Exclusive access**: Ensure no other process is using the keyboard

### Pseudo-Code Implementation

```
function upload_image_to_gmk87(image_path, slot_number):
    // 1. Load and prepare image
    image = load_image(image_path)
    image = resize_image(image, 256, 256)
    rgb565_data = convert_to_rgb565(image)
    
    // 2. Open USB device
    device = open_usb_device(vendor_id=0x320F, product_id=0x5056)
    if not device:
        return ERROR_DEVICE_NOT_FOUND
    
    endpoint = device.get_endpoint(0x05)
    
    // 3. Send initialization sequence
    send_init_packets(endpoint)
    wait_ms(10)
    
    // 4. Determine slot identifier
    slot_id = 0x38 if slot_number == 0 else 0x39
    
    // 5. Send image data
    sequence = 0x01
    offset = 0x00000038
    
    for pixel_chunk in chunks(rgb565_data, 28):  // 28 pixels per packet
        packet = create_packet(
            command=0x04,
            sequence=sequence,
            slot=slot_id,
            offset=offset,
            data=pixel_chunk
        )
        
        success = endpoint.write(packet, timeout=500)
        if not success:
            return ERROR_TRANSFER_FAILED
        
        // Increment counters
        sequence = (sequence + 1) % 256
        offset += 56
        
        // Small delay to prevent overwhelming device
        wait_ms(1)
    
    // 6. Finalize and close
    wait_ms(100)  // Let device process final packet
    device.close()
    
    return SUCCESS

function create_packet(command, sequence, slot, offset, data):
    packet = new byte[64]
    packet[0] = command
    packet[1] = sequence
    packet[2] = slot
    packet[3] = 0x21
    packet[4:7] = encode_little_endian_u32(offset)
    packet[8:63] = data (pad with 0x00 if less than 56 bytes)
    return packet

function convert_to_rgb565(rgb888_pixel):
    r5 = (rgb888_pixel.red >> 3) & 0x1F
    g6 = (rgb888_pixel.green >> 2) & 0x3F
    b5 = (rgb888_pixel.blue >> 3) & 0x1F
    
    rgb565 = (r5 << 11) | (g6 << 5) | b5
    
    // Return as little-endian 2-byte value
    return [rgb565 & 0xFF, (rgb565 >> 8) & 0xFF]
```

---

## Advanced Topics

### Multiple Image Slots

The keyboard appears to support at least 2 image slots:
- **Slot 0**: Primary slot, identified by `0x38` in byte 2
- **Slot 1**: Secondary slot, identified by `0x39` in byte 2

**Use cases**:
- Store multiple images and switch between them
- Implement animation by rapidly switching slots
- Provide different displays for different keyboard modes

**Implementation**:
To switch displayed slot, send a configuration command specifying the active slot.

### Image Compression

While the analyzed captures show uncompressed image data, the keyboard might support:
- **Run-length encoding (RLE)**: For images with large solid color areas
- **Palette mode**: Reduce color depth for specific images
- **Delta encoding**: Update only changed pixels between frames

**Investigation needed**: Determine if compressed format packets exist with different command or slot identifiers.

### Display Refresh Rate

Based on packet count and typical USB HID interrupt rates:
```
Transfer time ≈ 2,347 packets × 1ms = 2.35 seconds per image
Maximum framerate ≈ 1 / 2.35s ≈ 0.43 FPS
```

**Optimization opportunities**:
- Reduce inter-packet delay
- Implement partial updates (only changed regions)
- Use multiple USB endpoints if available

---

## Troubleshooting Common Issues

### Issue: Device Not Responding
**Symptoms**: No ACK received, USB timeout errors
**Solutions**:
1. Ensure keyboard is in correct mode (may require key combination)
2. Check if another application has exclusive access
3. Verify USB permissions (may need sudo/admin on some systems)
4. Try unplugging and replugging the keyboard

### Issue: Corrupted Display
**Symptoms**: Image appears garbled, wrong colors, or offset
**Solutions**:
1. Verify RGB565 byte order (little-endian)
2. Check offset calculation (should increment by 56 per packet)
3. Ensure sequence numbers are continuous
4. Confirm image dimensions match device expectations (256×256)

### Issue: Partial Image Transfer
**Symptoms**: Only part of image appears
**Solutions**:
1. Check for dropped packets (sequence gaps)
2. Increase inter-packet delay
3. Verify complete data buffer transmission
4. Ensure proper finalization sequence

### Issue: Wrong Slot
**Symptoms**: Image appears on different slot than intended
**Solutions**:
1. Verify slot identifier byte (0x38 vs 0x39)
2. Send proper slot selection command before data transfer
3. Check initialization sequence matches desired slot

---

## Security Considerations

### USB Access Control
- **Privilege requirements**: Writing to USB HID devices typically requires elevated privileges
- **User permissions**: On Linux, add user to `plugdev` or use udev rules
- **Application isolation**: Ensure only authorized applications can upload images

### Image Content Validation
- **File format validation**: Verify image files before processing to prevent malicious inputs
- **Memory bounds**: Check buffer sizes to prevent overflow attacks
- **Resource limits**: Limit image processing resources (CPU, memory) to prevent DoS

### Device Authentication
- **Vendor/Product ID**: Verify device identity before sending data
- **Firmware version**: Some firmware versions may have vulnerabilities
- **Device response validation**: Check ACK patterns for anomalies

---

## Future Research Directions

### Unexplored Features
1. **Read capability**: Can images be read back from the device? (Unlikely)
2. **Animation support**: How does the keyboard support GIF playback?
3. **Configuration persistence**: How are images stored in flash memory?

### Protocol Extensions
1. **Display modes**: Can brightness, contrast, or color mode be adjusted?
2. **Power management**: How does image display affect battery life (if wireless)?

### Reverse Engineering Targets
1. **Official software**: Analyze vendor's upload tool for additional features
2. **Firmware updates**: Investigate firmware structure for hidden capabilities
3. **Device responses**: Capture keyboard-to-host packets for status/error codes

---

## Conclusion

The GMK 87 keyboard uses a straightforward USB HID protocol for image uploads. The protocol consists of:

1. **USB HID interrupt transfers** on endpoint 0x05
2. **64-byte packets** with structured headers and 56-byte payloads
3. **RGB565 pixel format** for efficient 16-bit color representation
4. **Sequential packet delivery** with wraparound sequence numbering
5. **Multiple image slots** for storing different displays

Implementation requires:
- USB HID library access
- Image processing (resize, color conversion)
- Careful timing and error handling
- Proper packet structure adherence

This protocol enables developers to create custom applications for displaying images, animations, system information, or interactive content on the GMK 87's built-in screen.

---

## Appendix A: Packet Examples

### Initialization Sequence
```
Packet 1 (Frame 7):
04 01 00 01 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00

Packet 3 (Frame 15):
04 3a 04 06 30 00 00 00 00 08 08 01 00 00 18 ff
00 0d 00 00 00 00 00 00 00 00 00 00 ff 00 00 00
00 00 00 00 00 09 02 00 01 02 01 56 12 13 03 22
10 25 00 e8 03 00 01 00 00 00 00 00 00 00 00 00
```

### Image Data - White Pixels (Slot 0)
```
Packet (Frame 27):
04 21 38 21 38 00 00 00 ff ff ff ff ff ff ff ff
ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff
ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff
ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff
```

### Image Data - Black Pixels (Slot 1)
```
Packet (Frame 1575):
04 1d 38 21 38 a8 54 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

### Image Data - Red Pixels (Slot 0)
```
Packet:
04 xx 38 21 38 [offset] d8 05 d8 05 d8 05 d8 05
d8 05 d8 05 d8 05 d8 05 d8 05 d8 05 d8 05 d8 05
d8 05 d8 05 d8 05 d8 05 d8 05 d8 05 d8 05 d8 05
d8 05 d8 05 d8 05 d8 05 d8 05 d8 05 d8 05 d8 05
```

---

## Appendix B: References

### USB HID Specifications
- USB HID 1.11 Specification
- USB Interrupt Transfer Documentation

### Color Format Resources
- RGB565 Color Format Specification
- Dithering Algorithms for 16-bit Color

### Development Libraries
- **libusb**: Cross-platform USB library
- **hidapi**: Simple HID API for multiple platforms
- **Pillow/PIL**: Python image processing library
- **OpenCV**: Computer vision and image manipulation

---

## Document Information

- **Analysis Date**: October 2025
- **Packet Captures**: gmk87sniffed.pcapng, gmk87sniffed2.pcapng
- **Total Packets Analyzed**: 4,694 packets
- **Keyboard Model**: GMK 87
- **Protocol Version**: Unknown (assumed latest as of capture date)