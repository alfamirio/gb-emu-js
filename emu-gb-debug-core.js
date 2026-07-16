/* =========================================================================================
   emu-gb-debug-core.js — Debug UI Plumbing
   -----------------------------------------------------------------------------------------
   Shared infrastructure used by both debug sidebars (does not render any panel itself):

   - Clipboard-copy flash helpers, used by several panels across both other debug files.
   - Sidebar tab-switching (Debug Tools / Visualization Tools tab groups).
   - Navbar toggles: play/debug mode, screen model (GB/GBP), scanline mark overlay, layer
     tint overlay, dot-matrix overlay, the hidden dev-unlock click-combo, and the
     show/hide toggles for each sidebar + the Frame Activity panel.
   - refreshDebugTools(): the orchestrator that redraws whichever tab is active in each
     sidebar. Calls into functions defined in emu-gb-debug-visualizers.js and
     emu-gb-debug-inspectors.js, but only from callbacks/timers that run after every
     script has finished loading, so it doesn't matter that those functions live elsewhere.

   Load order (required): emu-gb-core.js -> emu-gb-app.js -> emu-gb-debug-core.js ->
   emu-gb-debug-visualizers.js -> emu-gb-debug-inspectors.js. emu-gb-debug-core.js must
   load before the other two: it declares debugToolsContainer/visualToolsContainer/
   rtcTabBtn, which emu-gb-debug-visualizers.js reads immediately (not just from inside a
   later callback) while checking initial RTC-tab availability.
   ========================================================================================= */

/* ---- shared: copy text to the clipboard and briefly flash something on `el` to confirm it.
   The three call sites below (Sprite Sheet/OAM tooltips, Sprites (OAM) table rows, and the
   Inspector tab's clickable readouts) each flash a different way - a replaced tooltip string,
   a row highlight, or an inline "Copied!" - so flashCopied() takes what to show as options
   rather than forcing one visual treatment on all of them. ---- */
function flashCopied(el, text, { className, setText, setDisplayBlock, setDataFlag } = {}) {
  navigator.clipboard.writeText(text).then(() => {
    clearTimeout(el._copiedTimeout);
    if (setDataFlag) el.dataset.copied = '1'; // lets a caller that periodically repaints el's
      // textContent (e.g. a live-refreshing panel) skip that repaint and avoid stomping on the flash
    if (setText !== undefined) el.textContent = setText;
    if (setDisplayBlock) el.style.display = 'block';
    el.classList.add(className);
    el._copiedTimeout = setTimeout(() => {
      if (setDataFlag) delete el.dataset.copied;
      el.classList.remove(className);
    }, 700);
  }).catch(() => { /* clipboard unavailable - silently ignore */ });
}

// Used by the Sprite Sheet and Sprites (OAM) tabs when a cell/row is clicked.
function flashCopiedTooltip(tooltipEl, addrText) {
  flashCopied(tooltipEl, addrText, { className: 'copied', setText: `Copied ${addrText}!`, setDisplayBlock: true });
}
function flashCopiedRow(rowEl, addrText) {
  flashCopied(rowEl, addrText, { className: 'row-copied' });
}
// Used by the Inspector tab's clickable address-range and byte-values readouts.
function flashCopiedInline(el, text) {
  flashCopied(el, text, { className: 'copied', setText: 'Copied!', setDataFlag: true });
}

/* ---- tab switching (each sidebar tracks its own active tab) ---- */
const debugToolsContainer = document.getElementById('debugTools');
const visualToolsContainer = document.getElementById('visualTools');
const cpuDebugControls = document.getElementById('cpuDebugControls');
const TOOLS_NEEDING_CPU_CONTROLS = ['trace', 'disasm', 'stack'];
const rtcTabBtn = visualToolsContainer.querySelector('.tool-tab[data-tool="rtc"]');

function updateCpuControlsVisibility(tool) {
  cpuDebugControls.classList.toggle('hidden', !TOOLS_NEEDING_CPU_CONTROLS.includes(tool));
}

// Keep emulator.stats.trackMemMap/emulator.instrumentation.trackTrace synced to (debug mode
// on) AND (that tab active), so the hot instrumentation only runs when its tab is actually open.
function syncAccessTracking(activeDebugTool) {
  const debugging = !document.body.classList.contains('playing-mode');
  emulator.stats.trackMemMap = debugging && (activeDebugTool === 'memmap' || activeDebugTool === 'banking');
  emulator.instrumentation.trackTrace = debugging && (activeDebugTool === 'trace');
  emulator.stats.trackEventLog = debugging && (activeDebugTool === 'eventlog');
}

function setupTabGroup(container) {
  const tabs = container.querySelectorAll('.tool-tab');
  const panels = container.querySelectorAll('.tool-panel');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tool).classList.remove('hidden');
      if (container === debugToolsContainer) {
        updateCpuControlsVisibility(btn.dataset.tool);
        syncAccessTracking(btn.dataset.tool);
      }
      if (btn.dataset.tool === 'rtc') syncRtcInputsFromLive(); // fresh "Set clock" defaults each time the tab is opened
      if (btn.dataset.tool === 'tileinspect') autoPasteTileInspectAddrFromClipboard();
      refreshDebugTools();
    });
  });
}

setupTabGroup(debugToolsContainer);
setupTabGroup(visualToolsContainer);

updateCpuControlsVisibility(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool);
syncAccessTracking(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool);


/* ---- play / debug mode toggle: checked = debugging GUI (default), unchecked = playing.
   Persisted in the shared UI config. ---- */
const modeToggle = document.getElementById('modeToggle');
const modeLabelPlay = document.getElementById('modeLabelPlay');
const modeLabelDebug = document.getElementById('modeLabelDebug');

function applyMode() {
  const debugging = modeToggle.checked;
  document.body.classList.toggle('playing-mode', !debugging);
  emulator.stats.trackAccess = debugging; // skip the coarser frame-activity bookkeeping entirely while just playing
  syncAccessTracking(debugToolsContainer.querySelector('.tool-tab.active').dataset.tool); // and the finer memmap/trace gates
  modeLabelDebug.classList.toggle('active', debugging);
  modeLabelPlay.classList.toggle('active', !debugging);
  saveUIConfig({ debugMode: debugging });
  if (debugging) refreshDebugTools();
}

// Restore saved mode before first render to avoid a flash of the default
if (typeof savedUIConfig.debugMode === 'boolean') modeToggle.checked = savedUIConfig.debugMode;

modeToggle.addEventListener('change', applyMode);

/* ---- screen model toggle: checked = GBP (grayscale, default), unchecked = GB (green tint) ---- */
const modelToggle = document.getElementById('modelToggle');
const modelLabelGB = document.getElementById('modelLabelGB');
const modelLabelGBP = document.getElementById('modelLabelGBP');

function applyScreenModel() {
  const isGBP = modelToggle.checked;
  emulator.setScreenModel(isGBP ? 'gbp' : 'gb');
  document.documentElement.style.setProperty('--screen-bg', isGBP ? '#343434' : '#0f380f');
  modelLabelGBP.classList.toggle('active', isGBP);
  modelLabelGB.classList.toggle('active', !isGBP);
  saveUIConfig({ gbp: isGBP });
  // Repaint immediately with the new palette and refresh any open color panels
  if (emulator.hasROM()) draw();
  refreshDebugTools();
}

if (typeof savedUIConfig.gbp === 'boolean') modelToggle.checked = savedUIConfig.gbp;

modelToggle.addEventListener('change', applyScreenModel);

/* ---- navbar toggle: overlay a line at the PPU's current scanline (LY).
   Not persisted; always starts off on load. ---- */
const scanlineMarkToggle = document.getElementById('scanlineMarkToggle');
const scanlineMarkLabelOn = document.getElementById('scanlineMarkLabelOn');

function applyScanlineMark() {
  const on = scanlineMarkToggle.checked;
  markCurrentLine = on;
  scanlineMarkLabelOn.classList.toggle('active', on);
  // Repaint immediately so toggling is visible even while paused/no frame is running.
  if (emulator.hasROM()) draw();
}

scanlineMarkToggle.addEventListener('change', applyScanlineMark);

// Lock the toggle while running (only meaningful while paused); driven by emulator.onRunStateChange
const scanlineMarkToggleWrap = scanlineMarkToggle.closest('.scanline-mark-toggle');
function setScanlineMarkToggleLocked(running) {
  scanlineMarkToggle.disabled = running;
  scanlineMarkToggleWrap.title = running ? 'Pause the emulator to change this (debug-only)' : '';
}
setScanlineMarkToggleLocked(emulator.running);
emulator.onRunStateChange = setScanlineMarkToggleLocked;

/* ---- navbar toggle: tint each PPU layer (BG/window/sprites) so overlaps are easy to tell apart.
   Not persisted; always starts off on load. ---- */
const layerTintToggle = document.getElementById('layerTintToggle');
const layerTintLabelOn = document.getElementById('layerTintLabelOn');

function applyLayerTint() {
  const on = layerTintToggle.checked;
  emulator.layerTint = on;
  layerTintLabelOn.classList.toggle('active', on);
  // Repaint immediately so toggling is visible even while paused/no frame is running.
  if (emulator.hasROM()) draw();
}

layerTintToggle.addEventListener('change', applyLayerTint);

/* ---- navbar toggle: overlay a hairline pixel grid mimicking a real GB LCD's dot matrix ---- */
const dotMatrixToggle = document.getElementById('dotMatrixToggle');
const dotMatrixLabelOn = document.getElementById('dotMatrixLabelOn');

function applyDotMatrix() {
  const on = dotMatrixToggle.checked;
  document.body.classList.toggle('dot-matrix-on', on);
  dotMatrixLabelOn.classList.toggle('active', on);
  saveUIConfig({ dotMatrix: on });
}

if (typeof savedUIConfig.dotMatrix === 'boolean') dotMatrixToggle.checked = savedUIConfig.dotMatrix;

dotMatrixToggle.addEventListener('change', applyDotMatrix);

/* ---- hidden click-combo for enableEmuDevUnlock(): click the navbar badge 13 times while
   dotMatrix is on and model is set to GB. Sets the same localStorage flag as the console
   path; requires a page reload to take effect. ---- */
const navTitle = document.getElementById('navTitle');
const DEV_UNLOCK_CLICKS_NEEDED = 13;
let devUnlockClickCount = 0;
navTitle.addEventListener('click', () => {
  if (!(dotMatrixToggle.checked && !modelToggle.checked)) {
    devUnlockClickCount = 0;
    return;
  }
  devUnlockClickCount++;
  if (devUnlockClickCount >= DEV_UNLOCK_CLICKS_NEEDED) {
    devUnlockClickCount = 0;
    enableEmuDevUnlock();
  }
});

/* ---- navbar toggles: show/hide the Debug Tools sidebar, Visualization Tools sidebar,
   and Frame Activity panel (display:none, reclaiming layout space). Persisted in UI config. ---- */
function makePanelVisToggle(toggleId, labelId, bodyClass, configKey, onShow) {
  const toggle = document.getElementById(toggleId);
  const label = document.getElementById(labelId);

  // Reflects toggle.checked into the DOM only; split from apply() so initial sync
  // doesn't fire onShow before this panel's elements exist.
  function syncVisualState() {
    const visible = toggle.checked;
    document.body.classList.toggle(bodyClass, !visible);
    label.classList.toggle('active', visible);
  }

  function apply() {
    syncVisualState();
    saveUIConfig({ [configKey]: toggle.checked });
    if (toggle.checked && typeof onShow === 'function') onShow();
  }

  if (typeof savedUIConfig[configKey] === 'boolean') toggle.checked = savedUIConfig[configKey];
  syncVisualState(); // apply initial hidden/visible state before any user interaction
  toggle.addEventListener('change', apply);
  return apply;
}

const applyDebugToolsVisibility = makePanelVisToggle(
  'debugToolsVisToggle', 'debugToolsVisLabel', 'hide-debug-tools', 'showDebugTools',
  () => refreshDebugTools()
);
const applyVisualToolsVisibility = makePanelVisToggle(
  'visualToolsVisToggle', 'visualToolsVisLabel', 'hide-visual-tools', 'showVisualTools',
  () => refreshDebugTools()
);
const applyFrameActivityVisibility = makePanelVisToggle(
  'frameActivityVisToggle', 'frameActivityVisLabel', 'hide-frame-activity', 'showFrameActivity',
  () => { drawFrameActivity(); drawFrameAnatomy(); drawLineAnatomy(); }
);


/* ---- orchestration: redraw whichever tab is currently active in each sidebar ---- */
function refreshDebugTools() {
  if (document.body.classList.contains('playing-mode')) return;

  const activeDebug = debugToolsContainer.querySelector('.tool-tab.active').dataset.tool;
  if (activeDebug === 'registers') drawRegisters();
  else if (activeDebug === 'disasm') drawDisassembly();
  else if (activeDebug === 'trace') drawTrace();
  else if (activeDebug === 'eventlog') drawEventLog();
  else if (activeDebug === 'stack') drawStack();
  else if (activeDebug === 'memmap') drawMemMap();
  else if (activeDebug === 'banking') drawBanking();
  else if (activeDebug === 'interrupts') drawInterrupts();
  else if (activeDebug === 'ramedit') drawRamEditor();
  else if (activeDebug === 'memscan') drawMemScan();

  const activeVisual = visualToolsContainer.querySelector('.tool-tab.active').dataset.tool;
  if (activeVisual === 'tiles') drawTileViewer();
  else if (activeVisual === 'tilemap') drawTileMap();
  else if (activeVisual === 'tileinspect') drawTileInspector();
  else if (activeVisual === 'oam') { drawOAMComposition(); drawOAMTable(); }
  else if (activeVisual === 'palettes') drawPalettes();
  else if (activeVisual === 'layers') drawLayers();
  else if (activeVisual === 'oscilloscope') drawOscilloscope();
  else if (activeVisual === 'scanline') drawScanlineTimeline();
  else if (activeVisual === 'rtc') drawRTC();

  // Frame Activity isn't a tab - it's always visible - so it redraws every time.
  drawFrameActivity();
  drawFrameAnatomy();
  drawLineAnatomy();
}

// Fallback redraw for when the emulator isn't running (paused, stepping, no ROM loaded).
// While running, loop() calls refreshDebugTools() itself, paced by the current speed.
setInterval(() => { if (!emulator.running) refreshDebugTools(); }, 150);
