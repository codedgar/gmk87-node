// src/lib/device.js
/**
 * @fileoverview GMK87 Keyboard Communication Library (Interrupt Transfer + Safe Reattach)
 * Fixes macOS keyboard lock by reattaching kernel driver before process exit.
 */

import usb from "usb";
import Jimp from "jimp";

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
 * Transport (FIXED VERSION)
 * ------------------------*/
class InterruptTransport {
  constructor(dev, iface, epOut, epIn) {
    this.dev = dev;
    this.iface = iface;
    this.epOut = epOut;
    this.epIn = epIn;
    this.responseQueue = [];  // ✅ ADD: Queue for polled responses
    this.setupPolling();       // ✅ ADD: Set up event handlers
  }

  // ✅ NEW: Proper polling setup with event handlers
  setupPolling() {
    // Start continuous polling: 2 concurrent transfers, 8 bytes each
    this.epIn.startPoll(2, 8);
    
    // Handle incoming data - push to queue
    this.epIn.on('data', (data) => {
      const buf = Buffer.from(data);
      L.debug(`[INT][RX] ${buf.toString('hex')}`);
      this.responseQueue.push(buf);
    });
    
    // Handle errors
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

  // ✅ CHANGED: Read from queue instead of calling transfer()
  async readFromQueue(timeoutMs = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.responseQueue.length > 0) {
        return this.responseQueue.shift();
      }
      await delay(5); // Check every 5ms
    }
    return null; // Timeout
  }

  // ✅ CHANGED: Use readFromQueue instead of transfer()
  readOnce(t = 200) {
    return this.readFromQueue(t);
  }
}

/** Claim only interface exposing OUT 0x05 / IN 0x83 */
function createInterruptTransport() {
  const dev = usb.getDeviceList().find(
    d =>
      d.deviceDescriptor.idVendor === VENDOR_ID &&
      d.deviceDescriptor.idProduct === PRODUCT_ID
  );
  if (!dev) throw new Error("GMK87 not found");
  dev.open();
  L.info("[USB] Device opened");

  // ✅ Do NOT detach interface #1 (keeps keyboard alive)

  // --- Use display interface #3 (0x05 OUT / 0x83 IN) ---
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
  L.info(
    `[USB] Using interrupt endpoints OUT 0x${epOut.address.toString(
      16
    )} / IN 0x${epIn.address.toString(16)}`
  );

  // ✅ FIXED: Polling setup now happens in InterruptTransport constructor
  return new InterruptTransport(dev, iface, epOut, epIn);
}

function openDevice(){return createInterruptTransport();}

/* -------------------------
 * Protocol helpers
 * ------------------------*/
async function readAckFiltered(t,timeout=200){  // ✅ CHANGED: 120→200ms timeout
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
  const rx=await readAckFiltered(t,200);  // ✅ CHANGED: 160→200ms
  if(!rx){L.warn(`[ACK] Timeout CMD 0x${cmd.toString(16)}`);return false;}
  const txHdr=buf.subarray(0,4),rxHdr=rx.subarray(0,4),status=rx.subarray(4,8);
  if(!txHdr.equals(rxHdr)){L.warn(`[ACK] header mismatch 0x${cmd.toString(16)}`);L.info(`[ACK][status] ${status.toString("hex")}`);return false;}
  L.info(`[ACK] cmd 0x${cmd.toString(16)} status ${status.toString("hex")}`);return true;
}
async function trySend(t,c,p=undefined,n=3){for(let i=1;i<=n;i++){L.info(`[TRY] CMD 0x${c.toString(16)} ${i}/${n}`);try{const ok=p===undefined?await send(t,c):await send(t,c,p);if(ok)return true;}catch(e){L.warn(`[TRY] ${e.message}`);}await delay(15);await drain(t,60);}return false;}
async function waitForReady(t,ms=600){const d=Date.now()+ms;while(Date.now()<d){const r=await t.readOnce(80);if(!r)continue;if(r[0]===0x01){L.info(`[ASYNC] ${r.toString("hex")}`);continue;}if(r[0]!==REPORT_ID)continue;if(r[3]===0x23){L.info("[READY] Device ready");return true;}}L.warn("[READY] timeout");return false;}
async function resetDeviceState(t){L.info("[RESET] Drain");await drain(t,120);await send(t,0x00,undefined,false);await delay(30);await drain(t,120);}

/* -------------------------
 * Image pipeline
 * ------------------------*/
async function buildImageFrames(path,index=0){
  L.info(`[IMG] Build ${path}`);const img=await Jimp.read(path);
  if(img.bitmap.width!==DISPLAY_WIDTH||img.bitmap.height!==DISPLAY_HEIGHT){img.resize(DISPLAY_WIDTH,DISPLAY_HEIGHT);L.info(`[IMG] Resized ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`);}
  const frames=[],block=Buffer.alloc(64,0),BY=BYTES_PER_FRAME;let off=0,ptr=8;
  function flush(){if(ptr===8)return;block[4]=BY;block[5]=off&0xff;block[6]=(off>>8)&0xff;block[7]=index&0xff;frames.push(Buffer.from(block.subarray(4,64)));off+=BY;ptr=8;block.fill(0,8);}
  for(let y=0;y<DISPLAY_HEIGHT;y++)for(let x=0;x<DISPLAY_WIDTH;x++){const {r,g,b}=Jimp.intToRGBA(img.getPixelColor(x,y));const rgb=toRGB565(r,g,b);block[ptr++]=(rgb>>8)&0xff;block[ptr++]=rgb&0xff;if(ptr>=64)flush();}flush();L.info(`[IMG] Frames ${frames.length}`);return frames;
}
async function sendFrames(t,f){
  L.info(`[PIPE] ${f.length} frames`);
  for(let i=0;i<f.length;i++){
    const ok=await send(t,0x21,f[i],true);
    if(!ok)L.warn(`[PIPE] frame ${i} fail`);
    if(i>0&&(i%256)===0)L.info(`[PIPE] progress ${i}/${f.length}`);
    await delay(40);  // ✅ CHANGED: 3→40ms to match original timing
  }
  L.info("[PIPE] done");
}

/* -------------------------
 * Init + Upload
 * ------------------------*/
async function initializeDevice(t){await drain(t,150);await trySend(t,0x01,undefined,3);await delay(10);await trySend(t,0x23,undefined,3);await waitForReady(t,600);return true;}
async function uploadImageToDevice(path,index=0){const t=openDevice();try{await resetDeviceState(t);await initializeDevice(t);const f=await buildImageFrames(path,index);await sendFrames(t,f);await trySend(t,0x02,undefined,2);L.info("[PIPE] Upload complete");return true;}finally{await releaseAndReattach(t);}}

/* -------------------------
 * Safe release + reattach
 * ------------------------*/
// Safely stop poll, release interface, reattach driver if supported, and close device
async function releaseAndReattach(transport) {
  const { epIn, iface, dev } = transport;

  // 1) Stop the IN endpoint polling thread to avoid libusb teardown crashes
  try {
    if (epIn && typeof epIn.stopPoll === "function") {
      epIn.stopPoll();
      console.log("[USB] IN endpoint polling stopped");
    }
  } catch (e) {
    console.warn("[USB] stopPoll error:", e.message);
  }

  // 2) Release the claimed interface
  try {
    await new Promise((resolve) => iface.release(true, resolve)); // 'true' => close endpoints first
    console.log("[USB] Interface released");
  } catch (e) {
    console.warn("[USB] release error:", e.message);
  }

  // 3) Try to re-attach kernel driver on this interface (may be a no-op on macOS)
  try {
    if (typeof iface.attachKernelDriver === "function") {
      try {
        iface.attachKernelDriver();
        console.log("[USB] Kernel driver reattached on this interface");
      } catch (e) {
        // Many macOS HID stacks don't implement this; warn but continue.
        console.warn("[USB] attachKernelDriver failed:", e.message);
      }
    }
  } catch (e) {
    console.warn("[USB] attachKernelDriver not available or errored:", e.message);
  }

  // 4) Close the device handle
  try {
    dev.close();
    console.log("[USB] Device closed");
  } catch (e) {
    console.warn("[USB] dev.close error:", e.message);
  }
}


/* -------------------------
 * Diagnostics
 * ------------------------*/
function printUsbTopology(){
  const dev=usb.getDeviceList().find(d=>d.deviceDescriptor.idVendor===VENDOR_ID&&d.deviceDescriptor.idProduct===PRODUCT_ID);
  if(!dev){console.log("No GMK87 device found.");return;}dev.open();
  console.log("USB Interfaces:",dev.interfaces.length);
  dev.interfaces.forEach((i,idx)=>{console.log(`Interface #${idx}:`);i.endpoints.forEach(ep=>console.log(` EP 0x${(ep.address&0xff).toString(16)} (${ep.direction}, type=${ep.transferType})`));});
  try{dev.close();}catch{}
}

/* -------------------------
 * Exports
 * ------------------------*/
export{
  VENDOR_ID,PRODUCT_ID,REPORT_ID,BYTES_PER_FRAME,DISPLAY_WIDTH,DISPLAY_HEIGHT,
  delay,checksum,toRGB565,
  printUsbTopology,openDevice,
  send,trySend,waitForReady,resetDeviceState,
  buildImageFrames,sendFrames,initializeDevice,uploadImageToDevice,
  releaseAndReattach
};