// src/timesync.js
import HID from 'node-hid';

const VENDOR_ID  = 0x320f;
const PRODUCT_ID = 0x5055;
const REPORT_ID  = 0x04;

// Sum of buf[3..63] (uint16 little-endian output)
function checksum(buf) {
  let sum = 0;
  for (let i = 3; i < 64; i++) sum = (sum + (buf[i] & 0xFF)) & 0xFFFF;
  return sum; // 0..65535
}

function toHexNum(num) {
  if (num < 0 || num >= 100) throw new RangeError('toHexNum expects 0..99');
  const low  = num % 10;
  const high = Math.floor(num / 10);
  return (high << 4) | low; // e.g., 34 -> 0x34
}

function send(device, command, data60 = null) {
  // Allow calling without data60 parameter
  if (data60 === null) {
    data60 = Buffer.alloc(60, 0x00);
  }
  
  if (!Buffer.isBuffer(data60) || data60.length !== 60) {
    throw new Error('invalid data len: need 60 bytes');
  }
  const buf = Buffer.alloc(64, 0x00);
  buf[0] = REPORT_ID;  // report id
  buf[3] = command;    // command id
  data60.copy(buf, 4); // payload

  const chk = checksum(buf);
  buf[1] = chk & 0xFF;       // checksum LSB
  buf[2] = (chk >> 8) & 0xFF; // checksum MSB

  // node-hid .write expects an array/Buffer that includes the reportId as first byte
  device.write([...buf]);
}

function sendConfigFrame(device, shownImage = 0, image0NumOfFrames = 1, image1NumOfFrames = 1) {
  const now = new Date();

  const frameDurationMs = 1000; // 1000 ms
  const frameDurationLsb = frameDurationMs & 0xFF;
  const frameDurationMsb = (frameDurationMs >> 8) & 0xFF;

  // Build a 64-byte working buffer (we'll only send bytes 4.. as payload)
  const command = Buffer.alloc(64, 0x00);

  // These fields mirror the C# offsets/values:
  command[0x04] = 0x30; // ???
  command[0x09] = 0x08; // ???
  command[0x0a] = 0x08; // ???
  command[0x0b] = 0x01; // ???
  command[0x0e] = 0x18; // ???
  command[0x0f] = 0xff; // ???

  command[0x11] = 0x0d; // ???
  command[0x1c] = 0xff; // ???

  command[0x25] = 0x09; // ???
  command[0x26] = 0x02; // ???
  command[0x28] = 0x01; // ???
  command[0x29] = shownImage; // show image 0(time)/1/2
  command[0x2a] = image0NumOfFrames; // frame count in image 1

  command[0x2b] = toHexNum(now.getSeconds());
  command[0x2c] = toHexNum(now.getMinutes());
  command[0x2d] = toHexNum(now.getHours());
  command[0x2e] = now.getDay();              // 0=Sunday..6=Saturday
  command[0x2f] = toHexNum(now.getDate());   // day of month

  command[0x30] = toHexNum(now.getMonth() + 1);
  command[0x31] = toHexNum(now.getFullYear() % 100);
  command[0x33] = frameDurationLsb;
  command[0x34] = frameDurationMsb;
  command[0x36] = image1NumOfFrames; // frame count in image 2

  // Send as command 0x06 (config), payload = bytes 4..63
  send(device, 0x06, command.subarray(4));
}

function findDevice() {
  const devices = HID.devices();
  return devices.find(d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
}

async function main() {
  const info = findDevice();
  if (!info) {
    console.log('No device with PID 0x5055 found.');
    process.exit(1);
  }
  console.log(`Device Found: ${info.product || '(unknown name)'} | VID: ${info.vendorId.toString(16)} PID: ${info.productId.toString(16)}`);

  // On Windows and Linux, prefer opening by path
  let device;
  try {
    if (process.platform === 'darwin') {
      device = new HID.HID(VENDOR_ID, PRODUCT_ID);
    } else {
      device = new HID.HID(info.path);
    }
  } catch (e) {
    console.error('Failed to open HID device:', e.message);
    console.error('Try running with sudo or check permissions.');
    process.exit(1);
  }

  sendConfigFrame(device);

  device.close();
}

// Check if this is the main module being run directly
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { sendConfigFrame, checksum, toHexNum, send, findDevice };