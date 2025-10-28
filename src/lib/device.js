// src/lib/device.js
/**
 * @fileoverview GMK87 Keyboard Communication Library (Interrupt Transfer + Safe Reattach)
 * Fixes macOS keyboard lock by reattaching kernel driver before process exit.
 */

import usb from "usb";
import Jimp from "jimp";
import HID from "node-hid";

/* -------------------------
 * Constants
 * ------------------------*/
const VENDOR_ID = 0x320f;
const PRODUCT_ID = 0x5055;
const REPORT_ID = 0x04;
const BYTES_PER_FRAME = 0x38;
const DISPLAY_WIDTH = 240;
const DISPLAY_HEIGHT = 135;
const LOG_LEVEL = "debug"; // "debug" | "info" | "warn" | "error"

/* -------------------------
 * Logging helpers
 * ------------------------*/
const L = {
  error: (...a) => console.error(...a),
  warn:  (...a) => ["warn","info","debug"].includes(LOG_LEVEL) && console.warn(...a),
  info:  (...a) => ["info","debug"].includes(LOG_LEVEL) && console.log(...a),
  debug: (...a) => LOG_LEVEL === "debug" && console.debug(...a),
};

function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }
function toRGB565(r,g,b){const r5=(r>>3)&0x1f,g6=(g>>2)&0x3f,b5=(b>>3)&0x1f;return(r5<<11)|(g6<<5)|b5;}
function checksum(buf){let s=0;for(let i=3;i<64;i++)s=(s+(buf[i]&0xff))&0xffff;return s;}
async function drain(transport, windowMs=120){const start=Date.now();let n=0;while(Date.now()-start<windowMs){const rx=await transport.readOnce(20);if(!rx)break;n++;L.debug(`[DRAIN][RX] ${rx.toString("hex")}`);}if(n)L.info(`[DRAIN] cleared ${n} messages`);}

/* -------------------------
 * Time Sync Utilities
 * ------------------------*/
function toHexNum(num) {
  if (num < 0 || num >= 100) throw new RangeError("toHexNum expects 0..99");
  const low = num % 10;
  const high = Math.floor(num / 10);
  return (high << 4) | low;
}

/* -------------------------
 * Transport (FIXED VERSION)
 * ------------------------*/
class InterruptTransport {
  constructor(dev, iface, epOut, epIn) {
    this.dev = dev;
    this.iface = iface;
    this.epOut = epOut;
    this.epIn = epIn;
    this.responseQueue = [];
    this.setupPolling();
  }

  setupPolling() {
    this.epIn.startPoll(2, 8);
    this.epIn.on('data', (data) => {
      const buf = Buffer.from(data);
      L.debug(`[INT][RX] ${buf.toString('hex')}`);
      this.responseQueue.push(buf);
    });
    this.epIn.on('error', (err) => {
      L.warn(`[INT][RX] ERROR: ${err.message}`);
    });
    L.info('[USB] IN endpoint polling active');
  }

  write(buf) {
    return new Promise((res, rej) => {
      this.epOut.transfer(buf, e => {
        if (e) return rej(e);
        L.debug(`[INT][TX] ${buf.toString('hex')}`);
        res();
      });
    });
  }

  async readFromQueue(timeoutMs = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.responseQueue.length > 0) {
        return this.responseQueue.shift();
      }
      await delay(5);
    }
    return null;
  }

  readOnce(t = 200) {
    return this.readFromQueue(t);
  }
}

function createInterruptTransport() {
  const dev = usb.getDeviceList().find(
    d =>
      d.deviceDescriptor.idVendor === VENDOR_ID &&
      d.deviceDescriptor.idProduct === PRODUCT_ID
  );
  if (!dev) throw new Error("GMK87 not found");
  dev.open();
  L.info("[USB] Device opened");

  const iface = dev.interfaces.find(i => i.interfaceNumber === 3);
  if (!iface) throw new Error("Interface #3 not found");
  const epOut = iface.endpoints.find(e => e.direction === "out");
  const epIn  = iface.endpoints.find(e => e.direction === "in");
  if (!epOut || !epIn) throw new Error("Endpoints missing on #3");

  if (iface.isKernelDriverActive && iface.isKernelDriverActive()) {
    try {
      iface.detachKernelDriver();
      L.info("[USB] Detached kernel driver #3");
    } catch (e) {
      L.warn("[USB] detach fail #3:", e.message);
    }
  }

  iface.claim();
  L.info("[USB] Claimed interface #3 (display uploader)");
  L.info(`[USB] Using interrupt endpoints OUT 0x${epOut.address.toString(16)} / IN 0x${epIn.address.toString(16)}`);
  return new InterruptTransport(dev, iface, epOut, epIn);
}

function openDevice(){return createInterruptTransport();}

/* -------------------------
 * Protocol helpers
 * ------------------------*/
async function readAckFiltered(t,timeout=200){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const rx=await t.readOnce(Math.max(10,end-Date.now()));
    if(!rx)return null;
    if(rx[0]===0x01){L.info(`[ASYNC][0x01] ${rx.toString("hex")}`);continue;}
    if(rx[0]===REPORT_ID)return rx;
    L.warn(`[RX] unexpected ReportID 0x${rx[0].toString(16)}: ${rx.toString("hex")}`);
  }
  return null;
}
async function send(t,cmd,data60=null,wait=true){
  if(!data60)data60=Buffer.alloc(60,0);if(!Buffer.isBuffer(data60)||data60.length!==60)throw new Error("data60 must be 60 bytes");
  const buf=Buffer.alloc(64,0);buf[0]=REPORT_ID;buf[3]=cmd&0xff;data60.copy(buf,4);const chk=checksum(buf);buf[1]=chk&0xff;buf[2]=(chk>>8)&0xff;
  await t.write(buf);if(!wait)return true;
  const rx=await readAckFiltered(t,200);
  if(!rx){L.warn(`[ACK] Timeout CMD 0x${cmd.toString(16)}`);return false;}
  const txHdr=buf.subarray(0,4),rxHdr=rx.subarray(0,4),status=rx.subarray(4,8);
  if(!txHdr.equals(rxHdr)){L.warn(`[ACK] header mismatch 0x${cmd.toString(16)}`);L.info(`[ACK][status] ${status.toString("hex")}`);return false;}
  L.info(`[ACK] cmd 0x${cmd.toString(16)} status ${status.toString("hex")}`);return true;
}
async function trySend(t,c,p=undefined,n=3){for(let i=1;i<=n;i++){L.info(`[TRY] CMD 0x${c.toString(16)} ${i}/${n}`);try{const ok=p===undefined?await send(t,c):await send(t,c,p);if(ok)return true;}catch(e){L.warn(`[TRY] ${e.message}`);}await delay(15);await drain(t,60);}return false;}
async function waitForReady(t,ms=600){const d=Date.now()+ms;while(Date.now()<d){const r=await t.readOnce(80);if(!r)continue;if(r[0]===0x01){L.info(`[ASYNC] ${r.toString("hex")}`);continue;}if(r[0]!==REPORT_ID)continue;if(r[3]===0x23){L.info("[READY] Device ready");return true;}}L.warn("[READY] timeout");return false;}
async function resetDeviceState(t){L.info("[RESET] Drain");await drain(t,120);await send(t,0x00,undefined,false);await delay(30);await drain(t,120);}

/* -------------------------
 * Feature Report Reader (new addition)
 * ------------------------*/
function bcdToDec(b) { return ((b >> 4) & 0x0F) * 10 + (b & 0x0F); }

function parseFeature05State(buf) {
  if (!buf || buf.length < 64) return null;

  const effect      = buf[5]  ?? 0;
  const brightness  = buf[6]  ?? 0;
  const speed       = buf[7]  ?? 0;
  const orientation = buf[8]  ?? 0;
  const rainbow     = buf[9]  ?? 0;
  const red         = buf[10] ?? 0;
  const green       = buf[11] ?? 0;
  const blue        = buf[12] ?? 0;

  const s = buf[43], m = buf[44], h = buf[45], day = buf[46], date = buf[47], month = buf[48], year = buf[49];

  const rtc = {
    sec: bcdToDec(s ?? 0),
    min: bcdToDec(m ?? 0),
    hour: bcdToDec(h ?? 0),
    day: (day ?? 0) & 0x07,
    date: bcdToDec(date ?? 0),
    month: bcdToDec(month ?? 0),
    year: 2000 + bcdToDec(year ?? 0),
  };

  return { underglow: { effect, brightness, speed, orientation, rainbow, hue: { red, green, blue } }, rtc };
}

function readStateViaFeatureReport(vendorId, productId) {
  const h = new HID.HID(vendorId, productId);
  const raw = Buffer.from(h.getFeatureReport(0x05, 64));
  h.close();
  return parseFeature05State(raw);
}

async function readCurrentConfig() {
  L.info("[CONFIG] Reading RGB + RTC via Feature Report 0x05...");
  try {
    const st = readStateViaFeatureReport(VENDOR_ID, PRODUCT_ID);
    if (!st) throw new Error("Empty report");
    L.info(`[CONFIG] ✓ Parsed Feature Report: effect=${st.underglow.effect}, bright=${st.underglow.brightness}, speed=${st.underglow.speed}, rgb=(${st.underglow.hue.red},${st.underglow.hue.green},${st.underglow.hue.blue})`);
    return {
      underglow: st.underglow,
      led: { mode: 0, saturation: 0, rainbow: st.underglow.rainbow, color: 0 },
      rtc: st.rtc
    };
  } catch (e) {
    L.error(`[CONFIG] Error reading Feature Report: ${e.message}`);
    return null;
  }
}

/* -------------------------
 * RGB Presets
 * ------------------------*/
const RGB_PRESETS = {
  white:{underglow:{effect:0,brightness:9,speed:0,orientation:0,rainbow:0,hue:{red:255,green:255,blue:255}},led:{mode:0,saturation:0,rainbow:0,color:7}},
  relaxed:{underglow:{effect:5,brightness:3,speed:7,orientation:1,rainbow:0,hue:{red:0,green:255,blue:255}},led:{mode:3,saturation:3,rainbow:0,color:4}},
  matrix:{underglow:{effect:15,brightness:7,speed:2,orientation:1,rainbow:0,hue:{red:0,green:255,blue:0}},led:{mode:3,saturation:7,rainbow:0,color:3}},
  party:{underglow:{effect:12,brightness:9,speed:0,orientation:1,rainbow:1,hue:{red:255,green:255,blue:255}},led:{mode:1,saturation:9,rainbow:1,color:0}},
  productivity:{underglow:{effect:6,brightness:4,speed:5,orientation:1,rainbow:0,hue:{red:255,green:255,blue:255}},led:{mode:3,saturation:5,rainbow:0,color:7}},
  off:{underglow:{effect:0,brightness:0,speed:0,orientation:0,rainbow:0,hue:{red:0,green:0,blue:0}},led:{mode:0,saturation:0,rainbow:0,color:0}}
};

/* -------------------------
 * Time Sync
 * ------------------------*/
function buildTimeSyncPayload(date = new Date(), rgbConfig = null) {
  const payload = Buffer.alloc(60, 0x00);
  payload[0x00] = 0x30;

  if (rgbConfig && rgbConfig.underglow) {
    const ug = rgbConfig.underglow;
    payload[5] = ug.effect ?? 0;
    payload[6] = ug.brightness ?? 9;
    payload[7] = ug.speed ?? 0;
    payload[8] = ug.orientation ?? 0;
    payload[9] = ug.rainbow ?? 0;
    if (ug.hue) {
      payload[10] = ug.hue.red ?? 255;
      payload[11] = ug.hue.green ?? 255;
      payload[12] = ug.hue.blue ?? 255;
    }
  }

  payload[39] = toHexNum(date.getSeconds());
  payload[40] = toHexNum(date.getMinutes());
  payload[41] = toHexNum(date.getHours());
  payload[42] = date.getDay();
  payload[43] = toHexNum(date.getDate());
  payload[44] = toHexNum(date.getMonth() + 1);
  payload[45] = toHexNum(date.getFullYear() % 100);
  payload[47] = 0xFF;
  payload[48] = 0xFF;
  return payload;
}

async function syncTime(date = new Date(), options = {}) {
  const { rgbConfig: explicitConfig = null, preserveRgb = true } = options;
  const t = openDevice();
  try {
    L.info("[TIME] Starting time sync...");
    await resetDeviceState(t);
    let rgbConfig = explicitConfig;
    if (!rgbConfig) {
      L.info("[TIME] No explicit RGB config provided, attempting to read via Feature Report...");
      rgbConfig = await readCurrentConfig();
      if (rgbConfig) L.info("[TIME] ✓ RGB config read via Feature Report");
      else L.warn("[TIME] ⚠ Could not read RGB config via Feature Report");
    }
    if (preserveRgb && !rgbConfig) throw new Error("ABORTED: Cannot preserve RGB settings — no config read");
    const payload = buildTimeSyncPayload(date, rgbConfig);
    const success = await trySend(t, 0x06, payload, 3);
    if (!success) {
      L.error("[TIME] Failed to sync time");
      return false;
    }
    L.info(`[TIME] ✓ Time synced: ${date.toLocaleString()}`);
    return true;
  } finally {
    await releaseAndReattach(t);
  }
}

/* -------------------------
 * Release & Diagnostics
 * ------------------------*/
async function releaseAndReattach(transport){const {epIn,iface,dev}=transport;try{if(epIn&&typeof epIn.stopPoll==="function"){epIn.stopPoll();console.log("[USB] IN endpoint polling stopped");}}catch(e){console.warn("[USB] stopPoll error:",e.message);}try{await new Promise(r=>iface.release(true,r));console.log("[USB] Interface released");}catch(e){console.warn("[USB] release error:",e.message);}try{if(typeof iface.attachKernelDriver==="function"){try{iface.attachKernelDriver();console.log("[USB] Kernel driver reattached on this interface");}catch(e){console.warn("[USB] attachKernelDriver failed:",e.message);}}}catch(e){console.warn("[USB] attachKernelDriver not available:",e.message);}try{dev.close();console.log("[USB] Device closed");}catch(e){console.warn("[USB] dev.close error:",e.message);}} 

/* -------------------------
 * Exports
 * ------------------------*/
export {
  VENDOR_ID, PRODUCT_ID, REPORT_ID, BYTES_PER_FRAME, DISPLAY_WIDTH, DISPLAY_HEIGHT,
  delay, checksum, toRGB565, toHexNum,
  openDevice, send, trySend, waitForReady, resetDeviceState,
  RGB_PRESETS, readCurrentConfig,
  buildTimeSyncPayload, syncTime,
  releaseAndReattach
};