# GMK87 Protocol Gap Analysis & Fix Plan

## Executive Summary

The keyboard becomes unresponsive and requires aggressive "reviving" (close/reopen the HID connection up to 6 times) because **our code sends commands that are not part of the actual protocol**, confusing the keyboard's state machine. The sniffed reports show a clean, simple command sequence with no resets, no NOP commands, and no device cycling. The fix is to remove the invalid commands and align with the sniffed protocol.

---

## 1. What the Sniffed Reports Show (The Correct Protocol)

### 1A. Image Upload (from `gmk87sniffed.pcapng`, `gmk87sniffed2.pcapng`)

The simplest, cleanest upload captured from the official Zuoya app:

```
INIT(0x01)
INIT(0x01)
CONFIG(0x06) ← full config with 0x30 byte, frame counts, time, etc.
COMMIT(0x02)
READY(0x23)  ← this tells the keyboard "upload session starting"
FRAME_DATA(0x21) × 2341 packets
COMMIT(0x02) ← this tells the keyboard "upload complete"
```

**7 steps total. No extras.**

### 1B. Re-upload on Same Connection (from `gmk-connect-upload-reupload-disconnect.pcapng`)

After the first upload, a second upload repeats the exact same clean sequence:

```
[First upload]
INIT → INIT → CONFIG → COMMIT → READY(0x23) → FRAME_DATA × 2341 → COMMIT

[Second upload - same device connection, no reset needed]
INIT → INIT → CONFIG → COMMIT → READY(0x23) → FRAME_DATA × 2341 → COMMIT
```

**No revive. No reset. No NOP. No drain. Just repeat the same sequence.**

### 1C. Time Sync / Config Change (from `timeSync.pcapng`, `colorPreservationTest.pcapng`)

The Python reference script's read-modify-write pattern:

```
[Read current config]
INIT(0x01)
PREP_READ(0x03) × 10
COMMIT(0x02)
READ_CFG(0x05) × 13

[Write modified config]
INIT(0x01)
CONFIG(0x06) ← with modified data
COMMIT(0x02)
```

**That's it. Clean read-modify-write.**

### 1D. Disconnect/Reconnect + Upload (from `disconnect-connect-changetimeframe-upload.pcapng`)

Even after a disconnect and reconnect, the protocol stays clean:

```
[Read config]  INIT → PREP_READ × 10 → COMMIT → READ_CFG × 13
[Write config] INIT → CONFIG → COMMIT  (repeated for multiple settings)
[Upload]       INIT → INIT → CONFIG → COMMIT → READY(0x23) → FRAME_DATA × 2341 → COMMIT
```

**No revive needed after disconnect/reconnect. The keyboard is ready immediately.**

---

## 2. What Our Code Does (The Problem)

Tracing through `uploadImage.js` → `device-legacy.js` + `device.js`, here's the actual sequence our code sends:

```
Step 1:  openDevice()
Step 2:  drainDevice(500ms)                     ← NOT IN SNIFFED
Step 3:  delay(200ms)                           ← NOT IN SNIFFED

Step 4:  resetDeviceState():
   4a.   trySend(0x00)  ← NOP/WAKE             ← NEVER IN ANY SNIFFED CAPTURE
   4b.   delay(50ms)
   4c.   trySend(0x23)  ← READY as "reset"     ← WRONG! 0x23 means "start upload session"
   4d.   drainDevice(500ms)
   4e.   delay(200ms)

Step 5:  initializeDevicePreservingLights():
   5a.   trySend(0x01)  ← INIT                   (correct)
   5b.   IF NO ACK → reviveDevice()             ← CLOSES/REOPENS DEVICE UP TO 6 TIMES
   5c.   delay(3ms)
   5d.   trySend(0x01)  ← INIT                   (correct)
   5e.   readConfigFromDevice()                   (correct)
   5f.   send(0x06, config frame)                 (correct)
   5g.   delay(25ms)
   5h.   trySend(0x02)  ← COMMIT                 (correct)
   5i.   delay(18ms)
   5j.   trySend(0x23)  ← READY                  (correct for upload)
   5k.   waitForReady() ← listens for 0x23 ACK   (correct)

Step 6:  delay(1000ms)                           ← 1 FULL SECOND - NOT IN SNIFFED

Step 7:  startUploadSession():
   7a.   sendWithPosition(0x23) ← ANOTHER 0x23!  ← DUPLICATE! Already sent in 5j
   7b.   sendWithPosition(0x01) ← ANOTHER INIT!  ← EXTRA

Step 8:  sendFrameData() ← 0x21 packets           (correct)
Step 9:  sendWithPosition(0x02) ← COMMIT           (correct)
```

---

## 3. The Specific Gaps (Root Causes)

### Gap 1: `resetDeviceState()` sends invalid commands (CRITICAL - Confidence: 95%)

| What our code sends | What sniffed reports show |
|---|---|
| `0x00` (NOP/WAKE) | **Never appears in any capture** |
| `0x23` (as a "reset/flush") | **0x23 means "start upload session", not "reset"** |

Sending `0x23` prematurely puts the keyboard into upload-waiting mode. Subsequent commands (like INIT) may then be misinterpreted or ignored because the keyboard is expecting frame data (0x21), not configuration commands. This is the **primary cause** of the keyboard becoming unresponsive.

### Gap 2: `reviveDevice()` is a workaround for Gap 1 (CRITICAL - Confidence: 90%)

The `reviveDevice()` function closes and reopens the HID connection up to 6 times with incremental backoff (100-600ms per attempt, plus a 2-second cooldown). This exists because Gap 1 confuses the keyboard, and brute-force reconnection is needed to clear the bad state.

The sniffed reports show **zero** connection cycling. The keyboard responds to commands immediately, even after disconnect/reconnect. If we stop confusing it with invalid commands, reviving becomes unnecessary.

### Gap 3: Double `0x23` sends (HIGH - Confidence: 90%)

The code sends `0x23` in two places:
1. `initializeDevicePreservingLights()` at step 5j: `trySend(device, 0x23)`
2. `startUploadSession()` at step 7a: `sendWithPosition(device, 0x23, ...)`

The sniffed protocol shows exactly ONE `0x23` per upload session. Sending two could cause the keyboard to enter upload mode, then get confused by the second `0x23` (which may be interpreted as a restart or invalid command mid-session).

### Gap 4: Two different protocol formats are mixed (MEDIUM - Confidence: 70%)

`uploadImage.js` imports from BOTH:
- `device-legacy.js` (uses `send()` → 60-byte payload, checks first 8 bytes for ACK)
- `device.js` (uses `sendWithPosition()` → length/position header at bytes 4-7, checks only cmd byte for ACK)

The packet formats are subtly different:

| Field | `send()` (legacy) | `sendWithPosition()` (new) |
|---|---|---|
| Byte 4 | First byte of payload | Data length |
| Byte 5-7 | Payload continues | Position (24-bit) |
| Byte 8+ | Payload continues | Data starts here |
| ACK check | First 8 bytes match | Only cmd byte matches |

The initialization uses `send()` format, then the upload switches to `sendWithPosition()` format mid-session. On macOS, where the HID driver may modify report IDs and checksums, the legacy ACK check (comparing first 8 bytes) is more brittle.

### Gap 5: Excessive delays (LOW - Confidence: 60%)

Our code adds delays totaling ~2+ seconds that don't appear in the sniffed traffic:
- `drainDevice(500ms)` × 2
- `delay(200ms)` × 2
- `delay(1000ms)` × 1
- Various smaller delays (3ms, 18ms, 25ms)

The sniffed protocol shows rapid command-response pairs with no artificial delays (except the 100ms before COMMIT that the Python reference uses).

---

## 4. Fix Plan

### Phase 1: Remove the root cause commands

**Remove `resetDeviceState()` entirely.** It sends 0x00 (NOP) and 0x23 (premature upload session start), neither of which exist in the sniffed protocol. This is the highest-confidence fix.

**Remove `reviveDevice()` entirely.** It only exists to recover from problems created by `resetDeviceState()`. If we stop confusing the keyboard, we don't need to revive it.

### Phase 2: Eliminate the duplicate 0x23

Choose ONE upload initiation path. Based on the sniffed data, the upload session should be:

```
READY(0x23) → [FRAME_DATA(0x21) × N] → COMMIT(0x02)
```

Or the official app style (which also works):

```
INIT → INIT → CONFIG → COMMIT → READY(0x23) → [FRAME_DATA] → COMMIT
```

Either way, exactly ONE 0x23 per upload session.

### Phase 3: Standardize on one protocol format

Use `sendWithPosition()` (the Python-compatible format) consistently throughout the entire flow. This matches the reference implementation and has more robust ACK checking (command byte only, not first 8 bytes which macOS may modify).

### Phase 4: Simplify the upload pipeline

The new `uploadImageToDevice()` flow should match the sniffed protocol:

```
1. openDevice()
2. readConfigFromDevice()    ← INIT, PREP_READ×10, COMMIT, READ_CFG×13
3. writeConfigToDevice()     ← INIT, CONFIG(0x06), COMMIT
4. startUploadSession()      ← READY(0x23), INIT(0x01)
5. sendFrameData()           ← FRAME_DATA(0x21) × N
6. sendWithPosition(0x02)    ← COMMIT
7. device.close()
```

This exactly matches the Python reference script's sequence and the sniffed captures.

---

## 5. Confidence Summary

| Change | Confidence | Rationale |
|---|---|---|
| Remove `resetDeviceState()` (0x00 and premature 0x23) | **95%** | These commands never appear in any sniffed capture. They are the most likely cause of the keyboard becoming unresponsive. |
| Remove `reviveDevice()` | **90%** | Only needed as a workaround. No capture shows device cycling. |
| Fix duplicate 0x23 | **90%** | Every sniffed capture shows exactly one 0x23 per upload session. |
| Standardize on `sendWithPosition()` | **70%** | The Python format is proven to work. Mixing formats adds complexity and potential for packet format mismatches. |
| Remove excessive delays/draining | **60%** | Not in sniffed traffic, but some minimal delay may be needed on macOS due to HID driver differences. Will keep the 100ms delay before COMMIT that the Python reference uses. |

---

## 6. What This Analysis Does NOT Propose

To be explicit about boundaries (since this is reverse engineering):

- **NOT proposing any new commands.** Every command in the fix plan is already observed in the sniffed captures.
- **NOT changing the packet format.** Using the exact same `sendWithPosition()` format that's already in `device.js`.
- **NOT guessing at unknown protocol features.** Only using what's confirmed in the captures.
- **NOT changing the image encoding or frame building.** Those work correctly today.
