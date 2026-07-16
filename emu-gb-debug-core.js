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
   The four call sites below (Sprite Sheet/OAM tooltips, Sprites (OAM) table rows, the
   Inspector tab's clickable readouts, and the ROM checksum badges) each flash a different way
   - a replaced tooltip string, a row highlight, an inline "Copied!" with a live-refreshing
   panel to restore it, or an inline "Copied!" restored directly after the flash - so
   flashCopied() takes what to show as options rather than forcing one visual treatment on
   all of them. ---- */
function flashCopied(el, text, { className, setText, setDisplayBlock, setDataFlag, restoreText } = {}) {
  navigator.clipboard.writeText(text).then(() => {
    clearTimeout(el._copiedTimeout);
    // Captured before setText overwrites it below, so it can be put back once the flash ends -
    // for callers (e.g. the checksum badges in emu-gb-app.js) whose element isn't otherwise
    // periodically repainted, unlike setDataFlag's "let the next repaint restore it" approach.
    const original = restoreText ? el.textContent : undefined;
    if (setDataFlag) el.dataset.copied = '1'; // lets a caller that periodically repaints el's
      // textContent (e.g. a live-refreshing panel) skip that repaint and avoid stomping on the flash
    if (setText !== undefined) el.textContent = setText;
    if (setDisplayBlock) el.style.display = 'block';
    el.classList.add(className);
    el._copiedTimeout = setTimeout(() => {
      if (setDataFlag) delete el.dataset.copied;
      if (restoreText) el.textContent = original;
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
// Used by the ROM checksum badges (emu-gb-app.js). Unlike flashCopiedInline's panel, badges
// are only ever rendered once per ROM load rather than on a repaint loop, so restoreText is
// used instead of setDataFlag to put the original label back once the flash ends.
function flashCopiedBadge(el, text) {
  flashCopied(el, text, { className: 'copied', setText: 'Copied!', restoreText: true });
}

/* ---- shared: "scroll-freeze + autoscroll" behavior for live-updating scrollback lists (the
   Execution Trace and Event Log panels in emu-gb-debug-inspectors.js). Such a list only keeps
   auto-scrolling to the bottom as new entries arrive if the autoscroll toggle is on AND the
   user hasn't scrolled up to read older entries - otherwise it freezes in place (showing a
   "frozen" note + "Jump to latest" button) so a burst of new entries can't yank the view out
   from under someone. The two panels used to each hand-roll an identical copy of this; this is
   the one shared implementation both build their `drawX()` around. ---- */
function createAutoscrollList({ listEl, toggleEl, followBtn, frozenNoteEl, configKey, emptySelector }) {
  function isAtBottom() {
    return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 24;
  }

  // Off by default, so the list never jumps on its own until the person opts in. Even when
  // on, scrolling up still freezes it - the toggle only controls whether being at the bottom
  // is enough to keep following new entries.
  let autoscrollEnabled = typeof savedUIConfig[configKey] === 'boolean' ? savedUIConfig[configKey] : false;
  toggleEl.checked = autoscrollEnabled;

  // Shows/hides the "frozen" UI (note + jump button) to match current state, without touching
  // the list content itself. The note text only applies to the scrolled-up case; when
  // autoscroll is simply off (but we're at the bottom), the button alone is enough.
  function setFrozenUI(frozen) {
    followBtn.style.display = frozen ? '' : 'none';
    frozenNoteEl.style.display = (frozen && !isAtBottom()) ? '' : 'none';
  }

  let lastRender = null; // remembered so the follow button/toggle handlers can re-invoke it

  // Only live-updates while autoscroll is on AND pinned to the bottom; otherwise freezes the
  // DOM so scrolled-up (or deliberately paused) content doesn't get swapped out under the user.
  // `render` rebuilds the list's content from scratch and pins scrollTop to the bottom.
  function draw(render) {
    lastRender = render;
    const hasContent = listEl.childElementCount > 0 && !listEl.querySelector(emptySelector);
    if (hasContent && (!autoscrollEnabled || !isAtBottom())) {
      setFrozenUI(true);
      return;
    }
    setFrozenUI(false);
    render();
  }

  // Manual scroll should immediately reflect frozen/live state.
  listEl.addEventListener('scroll', () => setFrozenUI(!autoscrollEnabled || !isAtBottom()));

  // Jump to latest always renders current entries and scrolls down, regardless of the
  // autoscroll setting - a one-off catch-up, not a way to silently turn autoscroll on. If
  // autoscroll is still off, the next new entry will freeze it again, which is correct.
  followBtn.addEventListener('click', () => {
    if (lastRender) lastRender();
    setFrozenUI(false);
  });

  toggleEl.addEventListener('change', () => {
    autoscrollEnabled = toggleEl.checked;
    saveUIConfig({ [configKey]: autoscrollEnabled });
    if (lastRender) draw(lastRender);
  });

  return { draw };
}

/* ---- tab switching (each sidebar tracks its own active tab) ---- */
const debugToolsContainer = document.getElementById('debugTools');
const visualToolsContainer = document.getElementById('visualTools');
const cpuDebugControls = document.getElementById('cpuDebugControls');
const rtcTabBtn = visualToolsContainer.querySelector('.tool-tab[data-tool="rtc"]');

/* ---- Panel registries: one entry per tab, keyed by its data-tool value. This is the single
   place a panel's dispatch-relevant metadata lives - adding a new panel means adding one entry
   here (plus the HTML tab button + panel div), not also hand-editing refreshDebugTools(),
   updateCpuControlsVisibility(), and syncAccessTracking() to mention its tool name again.

   `draw` is required and does the panel's actual redraw; wrapped in an arrow function (rather
   than referencing e.g. drawRegisters directly) because these registries are built while this
   script runs, before emu-gb-debug-visualizers.js/emu-gb-debug-inspectors.js have declared
   their draw functions - the arrow function just defers the lookup until refreshDebugTools()
   is actually called later, by which point every script has loaded. `needsCpuControls` shows
   the CPU debug controls (step/run-to/breakpoint row) while that tab is active. `tracksAccess`
   names which of emulator.stats/instrumentation's hot tracking flags should be enabled while
   that tab is active (see syncAccessTracking below) - omit it for panels that don't need any.
   `onActivate`, if present, runs once when the tab is clicked (before the resulting redraw) -
   for one-off "reset to fresh defaults on open" behavior that isn't just a normal redraw. ---- */
const DEBUG_PANELS = {
  registers:  { draw: () => drawRegisters() },
  disasm:     { draw: () => drawDisassembly(), needsCpuControls: true },
  trace:      { draw: () => drawTrace(), needsCpuControls: true, tracksAccess: 'trace' },
  eventlog:   { draw: () => drawEventLog(), tracksAccess: 'eventlog' },
  stack:      { draw: () => drawStack(), needsCpuControls: true },
  memmap:     { draw: () => drawMemMap(), tracksAccess: 'memmap' },
  banking:    { draw: () => drawBanking(), tracksAccess: 'memmap' },
  interrupts: { draw: () => drawInterrupts() },
  ramedit:    { draw: () => drawRamEditor() },
  memscan:    { draw: () => drawMemScan() },
};
const VISUAL_PANELS = {
  tiles:        { draw: () => drawTileViewer() },
  tilemap:      { draw: () => drawTileMap() },
  tileinspect:  { draw: () => drawTileInspector(), onActivate: () => autoPasteTileInspectAddrFromClipboard() },
  oam:          { draw: () => { drawOAMComposition(); drawOAMTable(); } },
  palettes:     { draw: () => drawPalettes() },
  layers:       { draw: () => drawLayers() },
  oscilloscope: { draw: () => drawOscilloscope() },
  scanline:     { draw: () => drawScanlineTimeline() },
  rtc:          { draw: () => drawRTC(), onActivate: () => syncRtcInputsFromLive() },
};

function updateCpuControlsVisibility(tool) {
  cpuDebugControls.classList.toggle('hidden', !DEBUG_PANELS[tool]?.needsCpuControls);
}

// Keep emulator.stats.trackMemMap/emulator.instrumentation.trackTrace/emulator.stats.trackEventLog
// synced to (debug mode on) AND (that tab active), so the hot instrumentation only runs when its
// tab is actually open. Driven by DEBUG_PANELS[tool].tracksAccess rather than hand-listing tool
// names here, so it can't fall out of sync with which tab actually needs which flag.
function syncAccessTracking(activeDebugTool) {
  const debugging = !document.body.classList.contains('playing-mode');
  const tracksAccess = debugging ? DEBUG_PANELS[activeDebugTool]?.tracksAccess : undefined;
  emulator.stats.trackMemMap = tracksAccess === 'memmap';
  emulator.instrumentation.trackTrace = tracksAccess === 'trace';
  emulator.stats.trackEventLog = tracksAccess === 'eventlog';
}

function setupTabGroup(container) {
  const tabs = container.querySelectorAll('.tool-tab');
  const panels = container.querySelectorAll('.tool-panel');
  const registry = container === debugToolsContainer ? DEBUG_PANELS : VISUAL_PANELS;
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
      registry[btn.dataset.tool]?.onActivate?.(); // e.g. rtc's fresh defaults, tileinspect's clipboard auto-paste
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
  DEBUG_PANELS[activeDebug]?.draw();

  const activeVisual = visualToolsContainer.querySelector('.tool-tab.active').dataset.tool;
  VISUAL_PANELS[activeVisual]?.draw();

  // Frame Activity isn't a tab - it's always visible - so it redraws every time.
  drawFrameActivity();
  drawFrameAnatomy();
  drawLineAnatomy();
}

// Fallback redraw for when the emulator isn't running (paused, stepping, no ROM loaded).
// While running, loop() calls refreshDebugTools() itself, paced by the current speed.
setInterval(() => { if (!emulator.running) refreshDebugTools(); }, 150);
