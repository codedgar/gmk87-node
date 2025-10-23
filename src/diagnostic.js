// src/diagnostic.js
import {
  openDevice,
  drainDevice,
  trySend,
  sendConfigFrame,
  delay,
  findDeviceInfo,
  send,
  checksum,
} from "./lib/device.js";

async function runDiagnostics() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║   GMK87 Comprehensive Device Diagnostic Tool     ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  let device;
  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // ========================================
    // TEST 1: Device Detection
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 1: Device Detection                        │");
    console.log("└─────────────────────────────────────────────────┘");
    
    const info = findDeviceInfo();
    if (!info) {
      console.error("✗ FAILED: Device not found!");
      console.error("  Expected VID: 0x320f (12815)");
      console.error("  Expected PID: 0x5055 (20565)");
      console.error("\n  Troubleshooting:");
      console.error("  - Ensure GMK87 keyboard is connected via USB");
      console.error("  - Try a different USB port");
      console.error("  - Check if another app has exclusive access");
      console.error("  - On Linux, verify udev rules (see README)");
      process.exit(1);
    }
    
    console.log("✓ PASSED: Device found!");
    console.log(`  Vendor ID:    0x${info.vendorId.toString(16).padStart(4, '0')} (${info.vendorId})`);
    console.log(`  Product ID:   0x${info.productId.toString(16).padStart(4, '0')} (${info.productId})`);
    console.log(`  Path:         ${info.path}`);
    console.log(`  Manufacturer: ${info.manufacturer || "N/A"}`);
    console.log(`  Product:      ${info.product || "N/A"}`);
    console.log(`  Serial:       ${info.serialNumber || "N/A"}`);
    testsPassed++;
    console.log();

    // ========================================
    // TEST 2: Device Connection
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 2: Device Connection                       │");
    console.log("└─────────────────────────────────────────────────┘");
    
    try {
      device = openDevice();
      console.log("✓ PASSED: Device opened successfully!");
      testsPassed++;
    } catch (e) {
      console.error("✗ FAILED: Could not open device!");
      console.error(`  Error: ${e.message}`);
      testsFailed++;
      process.exit(1);
    }
    console.log();

    // ========================================
    // TEST 3: Spontaneous Messages
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 3: Spontaneous Device Messages            │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("Listening for 2 seconds...");
    
    const spontaneous = [];
    device.on('data', (data) => {
      spontaneous.push(Buffer.from(data).toString('hex'));
    });
    
    await delay(2000);
    device.removeAllListeners('data');
    
    if (spontaneous.length > 0) {
      console.log(`⚠ WARNING: Device sent ${spontaneous.length} spontaneous message(s)`);
      console.log("  This may indicate stale data in the buffer.");
      spontaneous.slice(0, 3).forEach((msg, i) => {
        console.log(`  [${i + 1}] ${msg.substring(0, 48)}...`);
      });
      console.log("  → Buffer draining will handle this automatically.");
    } else {
      console.log("✓ PASSED: No spontaneous messages (buffer clean)");
      testsPassed++;
    }
    console.log();

    // ========================================
    // TEST 4: Buffer Draining
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 4: Buffer Draining                         │");
    console.log("└─────────────────────────────────────────────────┘");
    
    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`✓ PASSED: Drained ${stale.length} stale message(s)`);
      console.log("  First few messages:");
      stale.slice(0, 3).forEach((msg, i) => {
        console.log(`    [${i + 1}] ${msg.substring(0, 48)}...`);
      });
    } else {
      console.log("✓ PASSED: Buffer was already clean");
    }
    testsPassed++;
    console.log();

    // ========================================
    // TEST 5: Checksum Calculation
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 5: Checksum Calculation                    │");
    console.log("└─────────────────────────────────────────────────┘");
    
    const testBuf = Buffer.alloc(64, 0x00);
    testBuf[0] = 0x04;
    testBuf[3] = 0x01;
    const chk = checksum(testBuf);
    testBuf[1] = chk & 0xff;
    testBuf[2] = (chk >> 8) & 0xff;
    
    console.log(`  Test packet:  ${testBuf.slice(0, 8).toString('hex')}`);
    console.log(`  Checksum:     0x${chk.toString(16).padStart(4, '0')} (${chk})`);
    console.log(`  Checksum LSB: 0x${(chk & 0xff).toString(16).padStart(2, '0')}`);
    console.log(`  Checksum MSB: 0x${((chk >> 8) & 0xff).toString(16).padStart(2, '0')}`);
    
    // Verify checksum is correct
    let verifySum = 0;
    for (let i = 3; i < 64; i++) {
      verifySum = (verifySum + (testBuf[i] & 0xff)) & 0xffff;
    }
    
    if (verifySum === chk) {
      console.log("✓ PASSED: Checksum calculation verified");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Checksum mismatch!");
      testsFailed++;
    }
    console.log();

    // ========================================
    // TEST 6: First INIT Command (0x01)
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 6: First INIT Command (0x01)              │");
    console.log("└─────────────────────────────────────────────────┘");
    
    let success = await trySend(device, 0x01, undefined, 1);
    if (success) {
      console.log("✓ PASSED: INIT command acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: INIT command not acknowledged");
      console.error("  Possible causes:");
      console.error("  - Device is in wrong state");
      console.error("  - USB communication issue");
      console.error("  - Device requires reset (unplug/replug)");
      testsFailed++;
    }
    
    await delay(10);
    console.log();

    // ========================================
    // TEST 7: Second INIT Command (0x01)
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 7: Second INIT Command (0x01)             │");
    console.log("└─────────────────────────────────────────────────┘");
    
    success = await trySend(device, 0x01, undefined, 1);
    if (success) {
      console.log("✓ PASSED: Second INIT command acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Second INIT command not acknowledged");
      testsFailed++;
    }
    
    await delay(10);
    console.log();

    // ========================================
    // TEST 8: Configuration Frame (0x06)
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 8: Configuration Frame (0x06)             │");
    console.log("└─────────────────────────────────────────────────┘");
    
    const now = new Date();
    console.log(`  Setting time: ${now.toLocaleString()}`);
    console.log(`  Target slot:  0 (no display change)`);
    
    success = await sendConfigFrame(device, 0, 1, 1);
    if (success) {
      console.log("✓ PASSED: Config frame acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Config frame not acknowledged");
      console.error("  Device may not be in correct state");
      testsFailed++;
    }
    
    await delay(50);
    console.log();

    // ========================================
    // TEST 9: COMMIT Command (0x02)
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 9: COMMIT Command (0x02)                  │");
    console.log("└─────────────────────────────────────────────────┘");
    
    success = await trySend(device, 0x02, undefined, 1);
    if (success) {
      console.log("✓ PASSED: COMMIT command acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: COMMIT command not acknowledged");
      testsFailed++;
    }
    
    await delay(50);
    console.log();

    // ========================================
    // TEST 10: Ready Signal (0x23)
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 10: Ready Signal (0x23)                   │");
    console.log("└─────────────────────────────────────────────────┘");
    
    success = await trySend(device, 0x23, undefined, 1);
    if (success) {
      console.log("✓ PASSED: Ready signal acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Ready signal not acknowledged");
      testsFailed++;
    }
    
    await delay(50);
    console.log();

    // ========================================
    // TEST 11: Test Frame Data Packet (0x21)
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 11: Test Frame Data Packet (0x21)        │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("Sending a single test frame with black pixels...");
    
    const testFrame = Buffer.alloc(60, 0x00);
    testFrame[0x00] = 0x38; // BYTES_PER_FRAME
    testFrame[0x01] = 0x00; // Offset LSB
    testFrame[0x02] = 0x00; // Offset MSB
    testFrame[0x03] = 0x00; // Image slot 0
    // Rest is zeros (black pixels)
    
    success = await trySend(device, 0x21, testFrame, 1);
    if (success) {
      console.log("✓ PASSED: Frame data packet acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Frame data packet not acknowledged");
      console.error("  Device may not be ready for frame data");
      testsFailed++;
    }
    
    await delay(10);
    console.log();

    // ========================================
    // TEST 12: Final COMMIT
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 12: Final COMMIT (0x02)                   │");
    console.log("└─────────────────────────────────────────────────┘");
    
    success = await trySend(device, 0x02, undefined, 1);
    if (success) {
      console.log("✓ PASSED: Final COMMIT acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Final COMMIT not acknowledged");
      testsFailed++;
    }
    console.log();

    // ========================================
    // TEST 13: Response Timing
    // ========================================
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 13: Response Timing Analysis              │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("Measuring response times for 10 commands...");
    
    const timings = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await trySend(device, 0x01, undefined, 1);
      const elapsed = Date.now() - start;
      timings.push(elapsed);
      await delay(5);
    }
    
    const avgTiming = timings.reduce((a, b) => a + b, 0) / timings.length;
    const minTiming = Math.min(...timings);
    const maxTiming = Math.max(...timings);
    
    console.log(`  Average: ${avgTiming.toFixed(1)}ms`);
    console.log(`  Min:     ${minTiming}ms`);
    console.log(`  Max:     ${maxTiming}ms`);
    
    if (avgTiming < 200) {
      console.log("✓ PASSED: Response times are good");
      testsPassed++;
    } else {
      console.log("⚠ WARNING: Response times are slow");
      console.log("  This may cause upload issues");
    }
    console.log();

    // Add after TEST 5 (Checksum Calculation) in diagnostic.js

// ========================================
// TEST 6: Initialization Variants
// ========================================
console.log("┌─────────────────────────────────────────────────┐");
console.log("│ TEST 6: Initialization Variants                 │");
console.log("└─────────────────────────────────────────────────┘");

const variants = [
  { name: "Normal", preCmd: null, warmup: 0, delayMs: 3, checksumMode: "standard" },
  { name: "Warm-up 1 s", preCmd: null, warmup: 1000, delayMs: 3, checksumMode: "standard" },
  { name: "State-Reset 0x00", preCmd: 0x00, warmup: 0, delayMs: 3, checksumMode: "standard" },
  { name: "State-Reset 0x23", preCmd: 0x23, warmup: 0, delayMs: 3, checksumMode: "standard" },
  { name: "Long Delay (30 ms)", preCmd: null, warmup: 0, delayMs: 30, checksumMode: "standard" },
  { name: "Alt-Checksum (0–63)", preCmd: null, warmup: 0, delayMs: 3, checksumMode: "full" },
];

const variantResults = [];

for (const v of variants) {
  console.log(`\n→ Variant: ${v.name}`);

  if (v.warmup > 0) {
    console.log(`  Waiting ${v.warmup} ms before start...`);
    await delay(v.warmup);
  }

  if (v.preCmd !== null) {
    console.log(`  Sending pre-command 0x${v.preCmd.toString(16).padStart(2, "0")}`);
    await trySend(device, v.preCmd, undefined, 1);
    await delay(50);
  }

  // override checksum if needed
  const oldChecksum = checksum;
  if (v.checksumMode === "full") {
    global.checksum = (buf) => {
      let s = 0;
      for (let i = 0; i < 64; i++) s = (s + (buf[i] & 0xff)) & 0xffff;
      return s;
    };
  }

  const start = Date.now();
  const ok = await trySend(device, 0x01, undefined, 1);
  const elapsed = Date.now() - start;

  // restore original checksum
  global.checksum = oldChecksum;

  variantResults.push({
    variant: v.name,
    acknowledged: ok,
    timeMs: elapsed,
  });

  console.log(
    ok
      ? `  ✓ ACK in ${elapsed} ms`
      : `  ✗ No ACK (${elapsed} ms)`
  );

  await delay(v.delayMs);
}

// Display summary
console.log("\n╔═══════════════════════════════════════════════════╗");
console.log("║              INIT VARIANT SUMMARY                ║");
console.log("╚═══════════════════════════════════════════════════╝");
for (const r of variantResults) {
  console.log(
    `${r.acknowledged ? "✓" : "✗"} ${r.variant.padEnd(22)}  (${r.timeMs} ms)`
  );
}
console.log();

    // ========================================
    // Summary
    // ========================================
    console.log("╔═══════════════════════════════════════════════════╗");
    console.log("║              DIAGNOSTIC SUMMARY                   ║");
    console.log("╚═══════════════════════════════════════════════════╝");
    console.log();
    console.log(`  Tests Passed:  ${testsPassed}`);
    console.log(`  Tests Failed:  ${testsFailed}`);
    console.log(`  Total Tests:   ${testsPassed + testsFailed}`);
    console.log();
    
    if (testsFailed === 0) {
      console.log("✓ ALL TESTS PASSED!");
      console.log();
      console.log("Your device is functioning correctly and ready for image uploads.");
      console.log();
      console.log("Next steps:");
      console.log("  1. Upload an image:");
      console.log("     node src/sendImageMagick.js --file image.png --slot 0");
      console.log();
      console.log("  2. Upload to both slots:");
      console.log("     node src/uploadImage.js");
      console.log();
      console.log("  3. Sync time:");
      console.log("     node src/timesync.js");
    } else {
      console.log("✗ SOME TESTS FAILED");
      console.log();
      console.log("Troubleshooting steps:");
      console.log("  1. Unplug the keyboard and plug it back in");
      console.log("  2. Try a different USB port or cable");
      console.log("  3. Close any other applications accessing the keyboard");
      console.log("  4. On Linux, check udev rules (see README)");
      console.log("  5. Restart your computer");
      console.log();
      console.log("If issues persist, the device may need a firmware reset.");
    }
    console.log();

  } catch (err) {
    console.error("\n✗ DIAGNOSTIC FAILED WITH ERROR:");
    console.error(err);
    console.log();
    console.log("This may indicate a serious device or USB issue.");
    process.exit(1);
  } finally {
    if (device) {
      try {
        device.close();
        console.log("Device connection closed.");
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}

// Run diagnostics
runDiagnostics().catch((err) => {
  console.error("\n✗ Fatal error:");
  console.error(err);
  process.exit(1);
});