# Diagnostics Feature — Analysis

## Why

Issue #13: two Windows users get `Upload failed: keyboard did not respond to READY (0x23)`.
Edgar's keyboard works out of the box, so we need data from the affected keyboards rather than guesses.

## What the captures say (baseline)

Measured from `gmk87-sniffed-reports/*.pcapng` (official app, Edgar's keyboard):

| Command | Response latency |
|---|---|
| 0x01 / 0x02 / 0x03 / 0x05 / 0x06 | 1.3 – 4.5 ms |
| 0x21 (frame data) | 1.2 – 5.4 ms |
| **0x23 (READY)** | **262 – 338 ms** |

Official upload sequence (all 4 upload captures):
`0x01 → 0x01 → 0x06 → 0x02 → 0x23 → 0x21 × N → 0x02`

Official config read: `0x01 → 0x03 × 10 → 0x02 → 0x05 × 13` (first 0x05 is len=1 at pos 0).

## Gaps found while investigating (not fixed by this change)

1. **v1.0.4 (what users run) ≠ main.** PR #10 was merged after the v1.0.4 tag. v1.0.4 waits 5 s per
   command and throws on a missed 0x23. `main` waits 30 s and doesn't throw. Users haven't received PR #10.
2. **Extra INIT after READY.** Both v1.0.4 and `main` send `0x23 → 0x01 → 0x21…`. The official app
   never sends 0x01 after 0x23 (it goes straight to 0x21). This comes from `reference.py`, not the captures.
3. Our config read sends 12 × 0x05; the official app sends 13 (an extra len=1 read at pos 0 first).

These are recorded here so the diagnostics data can confirm or rule them out. No change made yet.

## What the feature does

New **Diagnostics** page in the Electron app with two modes. Both produce a JSON report the user can
copy (pre-wrapped in a ```json block for GitHub) or save to a file.

### Read-only check (safe)
1. Environment: app/Electron/Node versions, OS, arch.
2. HID enumeration: every interface with VID 0x320f (any PID), incl. interface number, usage page,
   firmware `release`, and which one we'd open. Serial numbers are omitted.
3. Open the device, listen passively for 1 s (no commands sent), record unsolicited reports.
4. Config read using the existing `readConfigFromDevice()`; every command's latency and ACK recorded.
5. Close, reopen, read config again, compare (excluding clock bytes 35–41).
6. Sanity checks on parsed values and keyboard clock vs system clock (warnings only).

### Full function test (writes to the keyboard; user picks which)
Runs the read-only check first. If the baseline read fails, write tests are skipped (no backup = no restore).
- **Lighting:** existing `setLighting()` with test values, read back and verify.
- **Time:** existing `syncTime()`, read back and verify clock is within 10 s.
- **Image:** existing `uploadImage()` (same path as the Upload page) with two generated test patterns,
  read back frame counts. **Original images, including factory animations, cannot be restored**
  (there's no command to read image data back).
- **Restore:** writes the backed-up config (lighting, LED, winlock, display slot, frame delay) with
  current time and, if images were replaced, the new frame counts. Then verifies.

## Protocol impact

**No new commands and no new sequences.** Diagnostics only calls functions the app already uses
(`readConfigFromDevice`, `writeConfigToDevice`, `setLighting`, `syncTime`, `uploadImage`).

The one change to `device.js` is an opt-in trace hook (`setProtocolTrace(fn)`) inside `sendWithPosition()`
that reports `{cmd, pos, len, ms, ok, response, discarded}` after each command. When no hook is set
(normal app use) behavior is identical.

Diagnostics stops a stage after 2 consecutive timeouts, by throwing from the hook, so a dead keyboard
doesn't take 30 s × 23 commands. That leaves the keyboard mid-sequence, the same state the normal
app leaves it in after a timeout.

## Reporting a problem from the app

Users shouldn't need to know the Diagnostics page exists, so the report is offered where the problem happens.

1. **Record the failed operation.** Upload, lighting, preset and time sync run inside
   `withOperationTrace()` in `electron/main.cjs`, which sets the same trace hook while they run. It only
   observes; it never throws, so the operation runs exactly as before. If the operation throws, or any
   command gets no response (for example 0x23, which the upload code logs and continues past),
   the record is kept in memory as `lastIssue`: commands with timing, 0x21 summary, error and log lines.
2. **Offer the report.** The view shows a toast that stays until dismissed, with **Report this problem**.
   An upload that finished but missed 0x23 gets a warning version of it.
3. **Run the read-only check.** The button, and the sidebar's *Report Issue*, open Diagnostics and run the
   read-only check automatically. The report includes the earlier failure as `failedOperation`.
4. **Open a pre-filled issue.** *Report on GitHub* opens `.github/ISSUE_TEMPLATE/bug_report.yml` with the
   title (`[OS] Operation: error (vX.Y.Z)`), the description and a short summary filled in through
   the URL (GitHub cuts off long URLs, so the summary is trimmed to fit). The full JSON goes to the
   clipboard for the *Diagnostics report* field.

Nothing is sent anywhere automatically; the user sees the report and submits the issue themselves.

## Confidence

- Read-only mode is safe: it runs the same sequence the Home page runs on every visit. **High.**
- Full test write paths are the existing ones, so it reproduces exactly what users hit. **High.**
- Whether the report pins down the 0x23 root cause depends on what the users' keyboards do. Expect
  it to at least show: firmware release, interface layout, real 0x23 latency (or absence), and
  whether 0x21 is accepted after a missed 0x23. **Medium.**
