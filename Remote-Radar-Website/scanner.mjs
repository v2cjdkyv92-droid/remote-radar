import { addAdvertisement, createRun } from './engine.mjs';

// There is no chooser, GATT connection, polling RSSI substitute, or demo-data path.
export class BluetoothScanner {
  constructor({ bluetooth, document: doc = globalThis.document, now = () => performance.now(), wallNow = () => Date.now(),
    every = (fn, ms) => setInterval(fn, ms), clear = id => clearInterval(id) } = {}) {
    Object.assign(this, { bluetooth, doc, now, wallNow, every, clear });
    this.job = null;
  }

  run(phase, onProgress = () => {}) {
    if (this.job) return Promise.reject(new Error('A scan is already running.'));
    if (typeof this.bluetooth?.requestLEScan !== 'function' || typeof this.bluetooth?.addEventListener !== 'function') {
      return Promise.reject(new Error('requestLEScan() and advertisement events are required. Enable beacio for this HTTPS page in iPhone Safari, then reload. requestDevice() alone is insufficient.'));
    }
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { phase, resolve, reject, handle: null, timer: null, run: null, closed: false };
    this.job = job;
    const fail = error => this.finish(job, error instanceof Error ? error : new Error(String(error)));
    job.listener = event => {
      if (job.closed || !job.run || this.doc?.hidden) return;
      const elapsed = this.now() - job.measureStart;
      addAdvertisement(job.run, event, elapsed);
    };
    job.visibility = () => { if (this.doc?.hidden) fail(new Error('Safari left the foreground. This scan was discarded. Return to this page and repeat this step.')); };
    this.bluetooth.addEventListener('advertisementreceived', job.listener);
    this.doc?.addEventListener('visibilitychange', job.visibility);
    onProgress({ state: 'permission', remainingMs: null, run: null });
    job.requestWall = this.wallNow();
    job.timer = this.every(() => {
      if (!job.handle && this.wallNow() - job.requestWall > 60000) fail(new Error('Bluetooth permission did not finish within 60 seconds. Allow Bluetooth, then retry this step.'));
    }, 250);
    let request;
    try {
      // Must happen directly in the click stack, before any awaited promise or settling timer.
      request = this.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    } catch (error) { fail(error); return result; }
    Promise.resolve(request).then(handle => {
      if (job.closed) { try { handle?.stop?.(); } catch {} return; }
      job.handle = handle;
      if (typeof handle?.stop !== 'function') { fail(new Error('The scan API did not return a stoppable BluetoothLEScan. The required scanning implementation is not verified. Close this tab to end any scan.')); return; }
      if (this.doc?.hidden) { job.visibility(); return; }
      this.clear(job.timer);
      job.started = this.now();
      job.measureStart = job.started + phase.settleMs;
      job.lastTick = job.started;
      job.lastWall = this.wallNow();
      job.run = createRun(phase, job.lastWall + phase.settleMs);
      const tick = () => {
        if (job.closed) return;
        const now = this.now(), wall = this.wallNow();
        if (this.doc?.hidden) { job.visibility(); return; }
        if (now - job.lastTick > 3000 || Math.abs((wall - job.lastWall) - (now - job.lastTick)) > 3000) {
          fail(new Error('Safari paused or the phone slept. Timing is unreliable, so this scan was discarded. Keep the screen awake and repeat the step.')); return;
        }
        job.lastTick = now;
        job.lastWall = wall;
        if (handle.active === false) { fail(new Error('Bluetooth scanning stopped before the step finished. Check Bluetooth and repeat this step.')); return; }
        const elapsed = now - job.measureStart;
        if (elapsed >= phase.durationMs) { job.run.completed = true; this.finish(job); return; }
        onProgress({ state: elapsed < 0 ? 'settling' : 'scanning', remainingMs: elapsed < 0 ? -elapsed : phase.durationMs - elapsed, run: job.run });
      };
      tick();
      if (!job.closed) job.timer = this.every(tick, 250);
    }, fail);
    return result;
  }

  finish(job, error = null) {
    if (job.closed) return;
    job.closed = true;
    this.clear(job.timer);
    this.bluetooth.removeEventListener('advertisementreceived', job.listener);
    this.doc?.removeEventListener('visibilitychange', job.visibility);
    try { job.handle?.stop?.(); } catch (stopError) { error ||= new Error(`The scan stop call failed: ${stopError.message}. Close this tab to end Bluetooth access.`); }
    if (this.job === job) this.job = null;
    if (error) job.reject(error); else job.resolve(job.run);
  }

  cancel() { if (this.job) this.finish(this.job, new Error('Scan stopped. The incomplete step was discarded; you can repeat it.')); }
}
