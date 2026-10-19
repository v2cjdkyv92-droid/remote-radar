import { VERSION, PHASES, apiVerdict, rankCandidates, reliability, summarize, redactedReport } from './engine.mjs';
import { BluetoothScanner } from './scanner.mjs';

const $ = id => document.getElementById(id);
const PENDING_KEY = 'remote-radar.pending.v1';
const SAVED_KEY = 'remote-radar.candidate.v1';
const MAX_CHECKPOINT_AGE = 30 * 60 * 1000;
let runs = [], selected = null, phaseIndex = 0, busy = false, mode = 'phase';
let outcome = 'untested', comparison = null, previousSession = null, wakeLock = null;
let scanGeneration = 0;
let facts = { probe: null, comparison: null, idle: null, reload: null };
const scanner = new BluetoothScanner({ bluetooth: navigator.bluetooth });

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function storageRead(area, key) { try { return JSON.parse(window[area].getItem(key) || 'null'); } catch { return null; } }
function storageRemove(area, key) { try { window[area].removeItem(key); } catch {} }
function showNotice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; $('notice').hidden = !message; }
function setCheck(id, text, kind = '') { $(id).textContent = text; $(id).className = `check-pill ${kind}`; }
function badge(text, kind = '') { $('status-badge').replaceChildren(element('span'), document.createTextNode(text)); $('status-badge').className = `status-badge ${kind}`; }
function formatTime(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function displayID(id) { return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id; }

function refreshFeatures() {
  const supported = typeof navigator.bluetooth?.requestLEScan === 'function' && typeof navigator.bluetooth?.addEventListener === 'function';
  scanner.bluetooth = navigator.bluetooth;
  setCheck('check-secure', window.isSecureContext ? 'Secure' : 'HTTPS required', window.isSecureContext ? 'good' : 'bad');
  setCheck('check-api', supported ? 'Present · untested' : 'Not available', supported ? 'pending' : 'bad');
  if (facts.probe) setCheck('check-api', facts.probe.ok ? 'Scan verified' : 'Not verified', facts.probe.ok ? 'good' : 'bad');
  $('unsupported-help').hidden = supported && window.isSecureContext;
  return supported && window.isSecureContext;
}

function updateChecks(run = null) {
  const observations = run || runs.at(-1);
  if (observations) {
    setCheck('check-events', observations.events ? 'Observed' : 'None observed', observations.events ? 'good' : 'bad');
    setCheck('check-rssi', observations.events > observations.invalidRSSI ? 'Observed' : 'Not observed', observations.events > observations.invalidRSSI ? 'good' : 'bad');
  } else if (facts.probe?.ok) {
    setCheck('check-events', 'Observed earlier', 'good'); setCheck('check-rssi', 'Observed earlier', 'good');
  }
  if (facts.reload?.ok) setCheck('check-id', 'Same after reload', 'good');
  else if (facts.reload?.ok === false) setCheck('check-id', 'Not reverified', 'bad');
  else if (facts.comparison === 'candidate') setCheck('check-id', 'Repeats · 2 rounds', 'pending');
  else if (facts.probe?.ok) setCheck('check-id', 'Repeats · API test', 'pending');
  if (facts.idle) setCheck('check-idle', facts.idle.ok ? 'Passed · 5 minutes' : 'Not reliable', facts.idle.ok ? 'good' : 'bad');
  refreshFeatures();
}

function renderPhase() {
  const phase = PHASES[phaseIndex];
  $('phase-label').textContent = phase.label.toUpperCase();
  $('phase-title').textContent = phase.title;
  $('phase-instruction').textContent = phase.instruction;
  $('consent').checked = false;
  $('consent-row').hidden = !phase.consent;
  $('consent-text').textContent = phase.consent || '';
  $('start').replaceChildren(element('span', phase.button), element('span', '↗', 'button-arrow'));
  $('start').disabled = !!phase.consent;
  $('start').hidden = false;
  $('stop').hidden = true;
  $('timer-panel').hidden = true;
  $('radar').classList.remove('scanning', 'complete-icon');
  $('radar-caption').textContent = 'NO SIGNAL ASSUMED';
  $('action-footnote').textContent = phase.settleMs
    ? `${formatTime(phase.settleMs)} settling + ${formatTime(phase.durationMs)} scan · stay on this page`
    : `${formatTime(phase.durationMs)} scan · stay on this page`;
  badge(phaseIndex ? 'Ready for next step' : 'Not tested');
  showNotice('');
  document.querySelectorAll('[data-group]').forEach(node => {
    const group = Number(node.dataset.group);
    node.classList.toggle('current', group === phase.group);
    node.classList.toggle('done', group < phase.group);
    if (group === phase.group) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
  });
  updateChecks();
}

function renderHistory() {
  const total = runs.filter(r => r.completed).length + (previousSession?.runs.length || 0);
  $('scan-total').textContent = `${total} complete`;
  $('history').replaceChildren();
  for (const row of previousSession?.runs || []) {
    const entry = element('div', undefined, 'history-entry');
    entry.append(element('strong', PHASES.find(p => p.id === row.phase)?.label || row.phase), element('span', `${row.events} events · ${row.devices} IDs`));
    $('history').append(entry);
  }
  for (const run of runs) {
    const entry = element('div', undefined, 'history-entry');
    entry.append(element('strong', PHASES.find(p => p.id === run.phase).label), element('span', `${run.events} events · ${run.devices.size} IDs`));
    $('history').append(entry);
  }
  if (total) $('history').append(element('p', 'Only completed foreground scans count. “Devices” means exposed IDs, not confirmed physical devices.', 'history-note'));
  else $('history').append(element('p', 'Completed scans will appear here. Nothing has been measured yet.', 'muted small'));
  $('export').disabled = !total;
}

function renderComparison(result) {
  $('results').hidden = false;
  $('result-message').textContent = result.message;
  $('result-badge').textContent = result.status === 'candidate' ? 'LIKELY · UNCONFIRMED' : result.status.toUpperCase();
  $('candidate-list').replaceChildren();
  for (const candidate of result.candidates.slice(0, 4)) {
    const item = element('div', undefined, `candidate ${candidate.strict ? 'likely' : ''}`);
    item.append(element('span', candidate.strict ? 'BATTERY-CHANGE MATCH · NOT CONFIRMED' : 'INSUFFICIENT EVIDENCE', 'candidate-label'));
    item.append(element('strong', candidate.name));
    item.append(element('span', `ID ${displayID(candidate.id)} · ${candidate.repeated ? 'same ID in both comparisons' : 'seen in only one comparison'}`, 'candidate-meta'));
    const samples = candidate.stats.map((s, i) => `Round ${i + 1}: ${s.rssiCount} RSSI samples, ${Math.round(s.coverage * 100)}% window coverage`).join(' · ');
    item.append(element('span', samples, 'candidate-meta'));
    if (candidate.collision) item.append(element('span', 'Conflicting names were observed for this ID; excluded as a reliable match.', 'candidate-meta'));
    $('candidate-list').append(item);
  }
  if (!result.candidates.length) $('candidate-list').append(element('p', 'No candidate has been identified.', 'small muted'));
  if (result.candidates.length > 4) $('candidate-list').append(element('p', `${result.candidates.length - 4} additional weak candidates omitted. None is accepted without both comparison rounds.`, 'small muted'));
}

function blocked(message) {
  mode = 'blocked'; outcome = 'not-verified';
  $('phase-title').textContent = 'A finder isn’t verified.';
  $('phase-instruction').textContent = 'The measured evidence does not support a reliable idle proximity finder. We stop at the feasibility test.';
  $('consent-row').hidden = true;
  $('start').hidden = false;
  $('start').textContent = 'Repeat the controlled test';
  $('start').disabled = false;
  $('action-footnote').textContent = 'No distance or proximity reading has been generated.';
  $('radar-caption').textContent = 'DETECTION NOT VERIFIED';
  badge('Not verified', 'blocked'); showNotice(message, 'error');
}

function reloadReady() {
  mode = 'reloadReady'; outcome = 'reload-check-needed';
  $('phase-title').textContent = 'One more check: the identifier.';
  $('phase-instruction').textContent = 'The likely candidate stayed detectable during the idle test. Reload this page and scan again to see whether its exact ID survives a new page session. Keep the remote untouched.';
  $('consent-row').hidden = true;
  $('start').textContent = 'Reload to verify identifier';
  $('start').disabled = false;
  $('start').hidden = false;
  $('action-footnote').textContent = 'Only the candidate and test summary stay in this tab for the reload.';
  $('radar-caption').textContent = 'IDLE TEST PASSED';
  badge('ID check remaining', 'active');
  showNotice('This is evidence for the measured period with the TV on. It does not guarantee that the remote will advertise overnight, with the TV off, or after its identifier changes.', 'good');
}

function done() {
  mode = 'done'; outcome = 'measured-feasibility-pass';
  $('phase-title').textContent = 'The candidate passed this test.';
  $('phase-instruction').textContent = 'The likely device returned with the same ID after reload and supplied continuous RSSI. Its association with the remote is inferred from your battery tests. Hardware behavior outside this test remains unverified.';
  $('consent-row').hidden = true;
  $('start').hidden = false; $('start').disabled = false;
  $('start').textContent = 'Remember this candidate';
  $('action-footnote').textContent = 'Saved only in this browser, for this website. No scan history is saved.';
  $('radar-caption').textContent = 'MEASURED FEASIBILITY PASS';
  $('radar').classList.add('complete-icon');
  badge('Test passed', 'good');
  showNotice('The feasibility prototype ends here. Download the report to review the real hardware results before a live finder is built. No hot/cold, distance, or direction is being claimed.', 'good');
  $('results').hidden = false;
  $('result-message').textContent = 'Candidate passed two controlled comparison rounds, a 5-minute untouched test, and a 1-minute same-ID test after reload. This is bounded evidence, not a manufacturer-verified identity or permanent identifier guarantee.';
  $('result-badge').textContent = 'TESTED · STILL A CANDIDATE';
  $('candidate-list').replaceChildren();
  const item = element('div', undefined, 'candidate likely');
  item.append(element('strong', selected.name), element('span', `Observed ID ${displayID(selected.id)} · no live scan running`, 'candidate-meta'));
  $('candidate-list').append(item);
  updateChecks();
}

function acceptRun(run) {
  runs = runs.filter(r => r.phase !== run.phase); runs.push(run);
  $('event-count').textContent = run.events.toLocaleString();
  $('device-count').textContent = run.devices.size.toLocaleString();
  $('rssi-count').textContent = (run.events - run.invalidRSSI).toLocaleString();
  renderHistory(); updateChecks(run);
  if (run.phase === 'probe') {
    facts.probe = apiVerdict(run); updateChecks(run);
    if (!facts.probe.ok) { outcome = 'api-not-verified'; badge('API not verified', 'blocked'); showNotice(facts.probe.message, 'error'); return; }
    outcome = 'comparison-needed'; phaseIndex = 1; renderPhase(); showNotice(facts.probe.message, 'good');
  } else if (run.phase === 'on2') {
    comparison = rankCandidates(runs); facts.comparison = comparison.status; renderComparison(comparison);
    if (comparison.status !== 'candidate') { blocked(comparison.message); return; }
    selected = comparison.selected; outcome = 'idle-check-needed'; phaseIndex = 5; renderPhase(); showNotice(comparison.message);
  } else if (run.phase === 'idle') {
    facts.idle = reliability(run, selected.id); updateChecks(run);
    if (!facts.idle.ok) { blocked(facts.idle.message); return; }
    reloadReady();
  } else if (run.phase === 'recheck') {
    facts.reload = reliability(run, selected.id); updateChecks(run);
    if (!facts.reload.ok) { blocked(facts.reload.message); return; }
    storageRemove('sessionStorage', PENDING_KEY); done();
  } else { phaseIndex++; renderPhase(); showNotice('Scan complete. Follow the next battery step to continue.'); }
}

function onProgress(progress) {
  const phase = PHASES[phaseIndex];
  $('timer-panel').hidden = false;
  $('timer').textContent = progress.remainingMs === null ? '—' : formatTime(progress.remainingMs);
  $('timer-stage').textContent = progress.state === 'permission' ? 'Allow Bluetooth in Safari' : progress.state === 'settling' ? 'Settling · measurements excluded' : 'Collecting real advertisements';
  $('foreground-tip').textContent = progress.state === 'settling' && phase.id.startsWith('on')
    ? 'Leave the remote untouched. Keep Safari visible and the screen awake.'
    : 'Keep Safari visible and your screen awake. Interrupted scans are discarded.';
  $('radar').classList.toggle('scanning', progress.state === 'scanning');
  $('radar-caption').textContent = progress.state === 'scanning' ? 'LISTENING · NO PROXIMITY ESTIMATE' : progress.state === 'settling' ? 'WAITING FOR THE REMOTE TO SETTLE' : 'WAITING FOR BLUETOOTH';
  const total = phase.settleMs + phase.durationMs;
  const remaining = progress.state === 'settling' ? progress.remainingMs + phase.durationMs : progress.remainingMs ?? total;
  $('scan-progress').value = Math.max(0, ((total - remaining) / total) * 100);
  if (progress.state === 'scanning') {
    $('event-count').textContent = progress.run.events.toLocaleString();
    $('device-count').textContent = progress.run.devices.size.toLocaleString();
    $('rssi-count').textContent = (progress.run.events - progress.run.invalidRSSI).toLocaleString();
  }
}

async function runPhase() {
  if (busy) return;
  const phase = PHASES[phaseIndex];
  if (phase.consent && !$('consent').checked) return;
  if (!refreshFeatures()) {
    showNotice('The required Bluetooth scanning API is unavailable here. Open the HTTPS site in iPhone Safari, enable beacio for this website, then reload. This browser cannot establish iPhone or remote feasibility.', 'error');
    badge('API unavailable', 'blocked'); return;
  }
  busy = true; outcome = 'scan-in-progress'; showNotice(''); badge('Testing', 'active');
  const generation = ++scanGeneration;
  $('reset').disabled = true;
  $('start').hidden = true; $('stop').hidden = false; $('consent-row').hidden = true;
  $('action-footnote').textContent = 'Only actual advertisement events count. No simulated readings.';
  $('event-count').textContent = '—'; $('device-count').textContent = '—'; $('rssi-count').textContent = '—';
  const running = scanner.run(phase, onProgress); // Starts scanning in this tap, before any await.
  if (navigator.wakeLock?.request) {
    navigator.wakeLock.request('screen').then(lock => {
      if (busy && generation === scanGeneration) wakeLock = lock; else lock.release().catch(() => {});
    }).catch(() => {});
  }
  try {
    const run = await running;
    busy = false;
    $('timer-panel').hidden = true; $('stop').hidden = true; $('radar').classList.remove('scanning');
    $('start').hidden = false; $('consent-row').hidden = !phase.consent;
    $('radar-caption').textContent = 'REAL SCAN COMPLETE';
    acceptRun(run);
  } catch (error) {
    busy = false; outcome = 'scan-not-completed';
    renderPhase();
    $('event-count').textContent = '—'; $('device-count').textContent = '—'; $('rssi-count').textContent = '—';
    badge('Step incomplete', 'blocked');
    showNotice(`${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`, 'error');
  } finally {
    busy = false;
    $('reset').disabled = false;
    const completedLock = wakeLock; wakeLock = null;
    if (completedLock) { try { await completedLock.release(); } catch {} }
  }
}

function resetComparisons() {
  const probe = runs.find(r => r.phase === 'probe');
  runs = probe ? [probe] : []; selected = null; comparison = null; previousSession = null;
  facts = { probe: probe ? apiVerdict(probe) : null, comparison: null, idle: null, reload: null };
  phaseIndex = probe && facts.probe.ok ? 1 : 0; mode = 'phase'; outcome = 'untested';
  storageRemove('sessionStorage', PENDING_KEY);
  $('results').hidden = true;
  setCheck('check-id', 'Not tested'); setCheck('check-idle', 'Not tested');
  renderPhase(); renderHistory();
}

function prepareReload() {
  if (!selected || !facts.idle?.ok || facts.comparison !== 'candidate') return;
  const checkpoint = { version: VERSION, createdAt: Date.now(), candidate: { id: selected.id, name: selected.name }, facts,
    previousSession: { runs: runs.map(r => ({ phase: r.phase, events: r.events, devices: r.devices.size, durationMs: r.durationMs })),
      candidateEvidence: runs.filter(r => ['on1', 'on2', 'idle'].includes(r.phase)).map(r => ({ phase: r.phase, ...summarize(r.devices.get(selected.id), r) })) } };
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(checkpoint));
    if (!sessionStorage.getItem(PENDING_KEY)) throw new Error('Storage unavailable');
    window.location.reload();
  } catch { showNotice('Safari did not allow this tab to retain the candidate for a reload. Identifier stability cannot be verified without that checkpoint. You can still download the current report.', 'error'); }
}

function restoreCheckpoint() {
  const data = storageRead('sessionStorage', PENDING_KEY);
  const age = Date.now() - (data?.createdAt || 0);
  if (!data || data.version !== VERSION || age < 0 || age > MAX_CHECKPOINT_AGE || typeof data.candidate?.id !== 'string' || !data.candidate.id.trim() || data.candidate.id.length > 512 || typeof data.candidate.name !== 'string' || data.facts?.comparison !== 'candidate' || data.facts?.idle?.ok !== true || data.facts?.probe?.ok !== true || !Array.isArray(data.previousSession?.runs)) {
    storageRemove('sessionStorage', PENDING_KEY); return;
  }
  selected = data.candidate; facts = data.facts; previousSession = data.previousSession;
  phaseIndex = 6; outcome = 'reload-check-needed';
}

$('start').addEventListener('click', () => {
  if (mode === 'blocked') { resetComparisons(); return; }
  if (mode === 'reloadReady') { prepareReload(); return; }
  if (mode === 'done') {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify({ version: VERSION, id: selected.id, name: selected.name, testedAt: Date.now(), evidenceScope: 'two controlled battery rounds, five minutes idle, same-tab reload; TV on and paired' }));
      $('saved-note').textContent = 'Candidate saved in this browser · no live detection running';
      $('start').textContent = 'Candidate remembered locally'; $('start').disabled = true;
    } catch { showNotice('Local storage is unavailable. The candidate has not been saved. The redacted report is still downloadable.', 'error'); }
    return;
  }
  runPhase();
});
$('stop').addEventListener('click', () => scanner.cancel());
$('consent').addEventListener('change', () => { if (!busy) $('start').disabled = !$('consent').checked; });
$('export').addEventListener('click', () => {
  const report = { ...redactedReport(runs, selected, outcome, facts), ...(previousSession ? { previousSession } : {}) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = 'remote-radar-redacted-report.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('reset').addEventListener('click', () => {
  if (busy) return;
  storageRemove('sessionStorage', PENDING_KEY); storageRemove('localStorage', SAVED_KEY);
  runs = []; facts = { probe: null, comparison: null, idle: null, reload: null };
  selected = null; comparison = null; previousSession = null; phaseIndex = 0; mode = 'phase'; outcome = 'untested';
  $('saved-note').textContent = '';
  ['check-events', 'check-rssi', 'check-id', 'check-idle'].forEach(id => setCheck(id, 'Not tested'));
  $('results').hidden = true; $('event-count').textContent = '—'; $('device-count').textContent = '—'; $('rssi-count').textContent = '—';
  renderPhase(); renderHistory(); showNotice('This tab’s scan evidence, reload checkpoint, and saved candidate have been cleared. beacio manages its own Bluetooth permission and device records.');
});
window.addEventListener('beacio:ready', () => { if (!busy) refreshFeatures(); });
window.addEventListener('beacio:extension:ready', () => { if (!busy) refreshFeatures(); });
window.addEventListener('pagehide', () => scanner.cancel());
restoreCheckpoint(); renderPhase(); renderHistory();
const saved = storageRead('localStorage', SAVED_KEY);
if (saved?.id && saved?.version === VERSION) $('saved-note').textContent = 'A previously tested candidate is saved · not currently detected';
