// diagnostic.js - Run this to see what device sends on connection
import { openDevice, delay } from "./lib/device.js";

async function diagnose() {
  console.log("Opening device...");
  const device = openDevice();
  
  console.log("Listening for any data from device (5 seconds)...\n");
  
  const messages = [];
  
  device.on('data', (data) => {
    const hex = Buffer.from(data).toString('hex');
    const timestamp = Date.now();
    messages.push({ timestamp, hex, data: Buffer.from(data) });
    console.log(`[${messages.length}] Received: ${hex}`);
  });
  
  device.on('error', (err) => {
    console.error('Device error:', err);
  });
  
  // Wait and see what device sends spontaneously
  await delay(5000);
  
  console.log(`\n\nTotal spontaneous messages: ${messages.length}`);
  
  if (messages.length === 0) {
    console.log("\nDevice sent nothing. Now trying to send 0x01...\n");
    
    // Try sending 0x01 and see what comes back
    const buf = Buffer.alloc(64, 0x00);
    buf[0] = 0x04;
    buf[3] = 0x01;
    
    // Calculate checksum
    let sum = 0;
    for (let i = 3; i < 64; i++) {
      sum = (sum + (buf[i] & 0xff)) & 0xffff;
    }
    buf[1] = sum & 0xff;
    buf[2] = (sum >> 8) & 0xff;
    
    console.log("Sending: " + buf.slice(0, 8).toString('hex'));
    device.write([...buf]);
    
    await delay(2000);
    
    console.log(`\nReceived ${messages.length} responses`);
  }
  
  device.close();
  console.log("\nDone!");
}

diagnose().catch(console.error);