// Only advertisement events feed this module. Names and payloads never establish identity.
export const VERSION = '0.1.0';
export const BUCKET_MS = 5000;
export const MAX_DEVICES = 750;
export const PHASES = [
  { id: 'probe', group: 0, title: 'Check the Bluetooth API', label: 'Bluetooth check', settleMs: 0, durationMs: 20000,
    instruction: 'Keep Safari open and your iPhone near the TV. Allow Bluetooth when asked. We’ll check real advertisements for RSSI and device IDs.', button: 'Test Bluetooth', consent: null },
  { id: 'off1', group: 1, title: 'Take the batteries out', label: 'Baseline · round 1', settleMs: 15000, durationMs: 45000,
    instruction: 'Remove both batteries from the Magic Remote. Keep the TV on and the iPhone in one place. After a 15-second settling period, we’ll scan the background devices for 45 seconds.', button: 'Scan with batteries out', consent: 'Both remote batteries are removed. My TV is on and my iPhone will stay in the same place.' },
  { id: 'on1', group: 1, title: 'Put the batteries back in', label: 'Comparison · round 1', settleMs: 180000, durationMs: 60000,
    instruction: 'Install both batteries and confirm the Magic Remote pointer or voice control works on the TV; power or volume alone may use infrared. Leave it paired; do not reset or unpair it. Set it down near the iPhone. We’ll wait 3 minutes, then scan for 1 minute without touching it.', button: 'Scan with batteries in', consent: 'Magic Remote pointer or voice control works and the remote remains paired. I will leave it untouched and keep my iPhone in the same place.' },
  { id: 'off2', group: 1, title: 'Repeat with batteries out', label: 'Baseline · round 2', settleMs: 15000, durationMs: 45000,
    instruction: 'Remove both batteries again. This second baseline helps exclude neighboring devices that happened to appear during the first comparison. Keep the TV and iPhone in the same positions.', button: 'Repeat batteries-out scan', consent: 'Both remote batteries are removed again. The TV is on and the iPhone has not moved.' },
  { id: 'on2', group: 1, title: 'Repeat with batteries in', label: 'Comparison · round 2', settleMs: 180000, durationMs: 60000,
    instruction: 'Reinstall both batteries and confirm Magic Remote pointer or voice control once more; power or volume alone may use infrared. Leave the remote paired and set it down. We’ll wait 3 minutes and scan for 1 minute. No button presses or movement during the wait or scan.', button: 'Repeat batteries-in scan', consent: 'Magic Remote pointer or voice control still works and the remote remains paired. I will leave the remote untouched and keep my iPhone still.' },
  { id: 'idle', group: 2, title: 'Let the remote stay idle', label: 'Untouched · 5 minutes', settleMs: 0, durationMs: 300000,
    instruction: 'Leave the remote exactly where it is, still paired to the powered-on TV. Do not touch it. We’ll measure the likely candidate for 5 more minutes and look for long gaps that would make a finder unreliable.', button: 'Test idle reliability', consent: 'The TV is on, the remote remains paired, and I will not touch or move the remote for 5 minutes.' },
  { id: 'recheck', group: 3, title: 'Check the ID after reload', label: 'Identifier check · 1 minute', settleMs: 0, durationMs: 60000,
    instruction: 'The page has reloaded. Keep the remote paired, untouched, and close to your stationary iPhone. We’ll check whether the exact same device ID returns with usable RSSI.', button: 'Verify the same identifier', consent: 'The remote is still paired to the powered-on TV and has stayed untouched since the idle test.' }
];

export const isRSSI = value => typeof value === 'number' && Number.isFinite(value) && value >= -127 && value <= 20;
export const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function createRun(phase, wallNow = Date.now()) {
  return { phase: phase.id, durationMs: phase.durationMs, startedAt: wallNow,
    events: 0, missingIDs: 0, invalidRSSI: 0, droppedDevices: 0, completed: false, devices: new Map() };
}

export function addAdvertisement(run, event, elapsedMs) {
  if (elapsedMs < 0 || elapsedMs >= run.durationMs || run.completed) return;
  run.events++;
  const rssi = isRSSI(event?.rssi) ? event.rssi : null;
  if (rssi === null) run.invalidRSSI++;
  // An ID is opaque. Do not trim it, derive it, or substitute the device name.
  const id = event?.device?.id;
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 512) {
    run.missingIDs++;
    return;
  }
  if (!run.devices.has(id)) {
    if (run.devices.size >= MAX_DEVICES) { run.droppedDevices++; return; }
    run.devices.set(id, { id, names: new Set(), count: 0, rssiCount: 0, firstMs: elapsedMs,
      lastMs: elapsedMs, maxInnerGapMs: 0, buckets: new Map(), rssiSample: [] });
  }
  const row = run.devices.get(id);
  const name = typeof event.name === 'string' ? event.name : event.device?.name;
  if (typeof name === 'string' && name.trim() && row.names.size < 4) row.names.add(name.slice(0, 120));
  row.count++;
  // Include *RSSI* arrival gaps, rather than filling gaps with identifier-only events.
  if (rssi !== null) {
    if (row.rssiCount) row.maxInnerGapMs = Math.max(row.maxInnerGapMs, elapsedMs - row.lastRSSIMs);
    else row.firstRSSIMs = elapsedMs;
    row.lastRSSIMs = elapsedMs;
    row.rssiCount++;
    if (row.rssiSample.length < 1500) row.rssiSample.push(rssi);
    const bin = Math.floor(elapsedMs / BUCKET_MS);
    row.buckets.set(bin, (row.buckets.get(bin) || 0) + 1);
  }
  row.lastMs = elapsedMs;
}

export function summarize(row, run) {
  if (!row) return { count: 0, rssiCount: 0, coverage: 0, medianRSSI: null, maxGapMs: run.durationMs, buckets: 0 };
  return { count: row.count, rssiCount: row.rssiCount, buckets: row.buckets.size,
    coverage: row.buckets.size / Math.ceil(run.durationMs / BUCKET_MS),
    medianRSSI: median(row.rssiSample),
    maxGapMs: row.rssiCount ? Math.max(row.firstRSSIMs, row.maxInnerGapMs, run.durationMs - row.lastRSSIMs) : run.durationMs };
}

export function apiVerdict(run) {
  if (!run?.completed) return { ok: false, code: 'incomplete', message: 'The API check has not completed.' };
  if (run.droppedDevices) return { ok: false, code: 'capacity', message: 'Too many devices to complete a reliable test. No result has been accepted.' };
  if (!run.events) return { ok: false, code: 'no-events', message: 'The scan opened, but no advertisements arrived. Check Bluetooth and beacio’s permission for this website. This cannot establish whether the remote is detectable.' };
  if (run.missingIDs) return { ok: false, code: 'missing-identifiers', message: 'Some advertisements arrived without usable device.id values. Those devices cannot be tracked across baseline and comparison scans, so reliable neighbor subtraction is not verified.' };
  const repeat = [...run.devices.values()].some(row => row.rssiCount >= 3 && row.buckets.size >= 2 && row.names.size <= 1);
  if (!repeat) return { ok: false, code: 'missing-fields', message: 'No device delivered repeated numeric RSSI with the same usable device.id across multiple time windows. Continuous signal scanning is not verified. A device chooser alone cannot provide this test.' };
  return { ok: true, code: 'observed', message: 'Real advertisement events include usable RSSI and repeating device IDs. Remote identity and longer-term ID stability are still unverified.' };
}

export function healthy(run, exceptID = null) {
  return !!run?.completed && !run.droppedDevices && !run.missingIDs && [...run.devices.values()].some(row => row.id !== exceptID && row.rssiCount >= 3 && row.buckets.size >= 2);
}

export function rankCandidates(runs) {
  const off = ['off1', 'off2'].map(id => runs.find(r => r.phase === id));
  const on = ['on1', 'on2'].map(id => runs.find(r => r.phase === id));
  if ([...off, ...on].some(r => !r?.completed)) return { status: 'incomplete', candidates: [], message: 'Complete both controlled comparison rounds first.' };
  if ([...off, ...on].some(r => !healthy(r))) return { status: 'inconclusive', candidates: [], message: 'At least one scan lacked repeatable background devices, contained missing identifiers, or exceeded capacity. An empty or incomplete baseline cannot confirm a remote. Repeat the test with Safari in the foreground.' };
  const ids = new Set(on.flatMap(r => [...r.devices.keys()]));
  const candidates = [];
  for (const id of ids) {
    if (off.some(r => r.devices.has(id))) continue;
    const rows = on.map(r => r.devices.get(id));
    const stats = rows.map((row, i) => summarize(row, on[i]));
    const names = new Set(rows.flatMap(row => row ? [...row.names] : []));
    const repeated = rows.every(Boolean);
    const usable = stats.every(s => s.rssiCount >= 5 && s.coverage >= 0.5 && s.buckets >= 3);
    const strict = repeated && usable && names.size <= 1 && on.every(r => healthy(r, id));
    candidates.push({ id, name: [...names][0] || 'Unnamed Bluetooth device', strict, repeated, stats,
      score: (repeated ? 4 : 0) + (usable ? 2 : 0) + Math.min(...stats.map(s => s.coverage)), collision: names.size > 1 });
  }
  candidates.sort((a, b) => Number(b.strict) - Number(a.strict) || b.score - a.score || a.id.localeCompare(b.id));
  const strong = candidates.filter(c => c.strict);
  if (strong.length > 1) return { status: 'ambiguous', candidates, message: `${strong.length} devices follow the battery changes. We cannot safely identify one remote. Repeat the controlled test; names and signal strength cannot resolve this ambiguity.` };
  if (strong.length === 1) return { status: 'candidate', candidates, selected: strong[0], message: 'One device appeared with the same ID in both batteries-in scans and neither batteries-out scan. It is a likely candidate, not a verified LG identity. Test it untouched next.' };
  return { status: 'no-match', candidates, message: 'No repeatable idle candidate passed both comparison rounds. A hot/cold finder is not justified by these results. The remote may sleep, remain connected without advertising, or use a radio mode this BLE scanner cannot observe. This test does not prove it never advertises.' };
}

export function reliability(run, id) {
  const stats = summarize(run?.devices.get(id), run || { durationMs: 60000 });
  const ok = !!run?.completed && healthy(run, id) && stats.rssiCount >= 12 && stats.coverage >= 0.8 && stats.maxGapMs <= 10000 && run.devices.get(id)?.names.size <= 1;
  return { ok, stats, message: ok
    ? 'The exact candidate ID supplied RSSI in at least 80% of 5-second windows, with no gap over 10 seconds, during this test.'
    : 'The same candidate ID did not provide sufficiently continuous RSSI, or the background scan was unhealthy. We cannot distinguish a sleeping remote, a changed identifier, or scanner limitations. A reliable idle finder is not verified.' };
}

export function redactedReport(runs, selected, outcome, facts) {
  const labels = new Map();
  for (const run of runs) for (const id of run.devices.keys()) if (!labels.has(id)) labels.set(id, `Device ${String(labels.size + 1).padStart(3, '0')}`);
  if (selected && !labels.has(selected.id)) labels.set(selected.id, 'Previously tested candidate');
  return { app: 'Remote Radar', version: VERSION, reportType: 'redacted, user-downloaded, real-event summaries',
    outcome, facts, candidate: selected ? labels.get(selected.id) : null,
    limitations: ['Device association is inferred from controlled battery changes, not manufacturer identity.', 'No distance, direction, or hot/cold estimate is produced.', 'An idle pass applies only to the measured period, paired state, and powered-on TV.', 'No permanent identifier stability guarantee is possible.'],
    runs: runs.map(run => ({ phase: run.phase, durationMs: run.durationMs, completed: run.completed, events: run.events,
      missingIDs: run.missingIDs, invalidRSSI: run.invalidRSSI, droppedDevices: run.droppedDevices,
      devices: [...run.devices.values()].map(row => ({ label: labels.get(row.id), ...summarize(row, run), conflictingNames: row.names.size > 1 })) })) };
}
