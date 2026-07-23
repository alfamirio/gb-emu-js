/* =========================================================================================
   emu-gb-tas.js — Input recording & playback ("TAS-lite")
   -----------------------------------------------------------------------------------------
   Records the joypad state sampled at the start of every emulated frame into a plain array,
   optionally starting from a save-state snapshot; playback re-drives the joypad from the
   recorded array, one entry per frame, instead of the keyboard. Because the core is
   deterministic given (starting state + per-frame input), replaying the array from its
   embedded snapshot reproduces the exact same run every time - a small, hands-on
   demonstration of that determinism, and a natural pairing with the save-state system.

   Two playback modes (see the "Reset to recorded start state" checkbox in the panel):
     - From the recording's snapshot (default): pauses, restores that exact save state, then
       replays - a deterministic from-the-top TAS run.
     - Live, from wherever you are right now: skips the reset and applies the recorded
       frames on top of whatever's currently happening - for firing a button combo/macro at
       any moment mid-play, optionally with Loop checked to repeat it indefinitely (mashing
       a button, walking in place, cycling a menu, etc.) to get through a repetitive stretch
       without babysitting it.

   Recordings can be exported/imported as JSON so they can be shared or replayed later.

   Frame granularity only: this hooks GBEmulator.prototype.runFrame(), so it drives/records
   whole frames (runFrame/stepFrame/stepOneSecond/the normal run loop) but not the
   single-instruction/line/mode debugger steps (stepOne/stepLine/stepMode), which don't
   advance a full frame at a time.

   Load order: after emu-gb-core.js/emu-gbc-core.js (patches GBEmulator.prototype.runFrame,
   inherited by CGBEmulator) and after emu-gb-app.js, which owns `emulator`, `draw()`,
   `refreshDebugTools()`, `resyncJoypadFromHeldKeys()`, `downloadBlob()`, and `safeRomName()`
   - all reused here rather than duplicated. Wraps a few of app.js's own top-level functions
   (see "lifecycle hooks" below) so a recording/playback in progress doesn't silently go
   stale under a ROM reload, reset, or save-state jump.
   ========================================================================================= */

/* ---- joypad <-> pressed-bitmask helpers ----
   Joypad.directionState/buttonState are active-low nibbles (0 = pressed); a recorded frame
   stores the more readable active-high form: bits 0-3 = Right/Left/Up/Down, bits 4-7 =
   A/B/Select/Start. One byte per frame. */
function tasReadPressedMask(joypad) {
  const dir = (~joypad.directionState) & 0x0F;
  const btn = (~joypad.buttonState) & 0x0F;
  return dir | (btn << 4);
}
function tasApplyPressedMask(emu, mask) {
  for (let bit = 0; bit < 4; bit++) emu.setButton(bit, !!(mask & (1 << bit)), true);
  for (let bit = 0; bit < 4; bit++) emu.setButton(bit, !!(mask & (1 << (bit + 4))), false);
}

class TASRecorder {
  constructor() {
    this.mode = 'idle';        // 'idle' | 'recording' | 'playing'
    this.frames = [];          // one pressed-bitmask byte per recorded frame, oldest first
    this.playIndex = 0;        // next index into `frames` to apply during playback
    this.loop = false;         // if true, playback wraps back to frame 0 instead of stopping
    this.startState = null;    // save-state snapshot the current/last recording began from
    this.romTitle = null;      // romTitle at record time, for a mismatch warning on playback
    this.onChange = null;      // (reason?) => void; UI hook, see wireTasUI() below
  }

  isRecording() { return this.mode === 'recording'; }
  isPlaying() { return this.mode === 'playing'; }
  hasRecording() { return this.frames.length > 0 && !!this.startState; }

  // Drops any in-progress recording/playback without touching emulator state. Used by the
  // lifecycle hooks below when the emulator state has moved out from under it.
  cancel(reason) {
    if (this.mode === 'idle') return;
    const wasPlaying = this.mode === 'playing';
    this.mode = 'idle';
    if (wasPlaying) resyncJoypadFromHeldKeys(); // hand control back to the physical keyboard
    this.onChange?.(reason || 'cancelled');
  }

  startRecording() {
    if (!emulator.hasROM()) return;
    this.frames = [];
    this.startState = emulator.getSaveState();
    this.romTitle = emulator.romTitle;
    this.playIndex = 0;
    this.mode = 'recording';
    this.onChange?.('recording-started');
  }

  stopRecording() {
    if (this.mode !== 'recording') return;
    this.mode = 'idle';
    this.onChange?.('recording-stopped');
  }

  /* ---- playback ----
     `fromSnapshot` (default true): pause and restore the recording's embedded save state
     before playing, for exact deterministic replay of that original run.
     `fromSnapshot: false`: skip the reset entirely and apply the recorded frames on top of
     whatever's happening right now, live, mid-play - for firing off a button combo/macro at
     any moment rather than only as a full from-the-top TAS replay.
     `loop`: when the frame array runs out, wrap back to frame 0 and keep going instead of
     stopping - for repeating a short combo (e.g. mash A, walk in place, cycle a menu)
     indefinitely to get through a boring/repetitive stretch, rather than one playthrough. */
  startPlayback({ fromSnapshot = true, loop = false } = {}) {
    if (!this.hasRecording()) return;
    if (fromSnapshot && this.romTitle && emulator.romTitle && this.romTitle !== emulator.romTitle) {
      const proceed = confirm(
        `This recording was made on "${this.romTitle}" but the currently loaded ROM is ` +
        `"${emulator.romTitle}". Play it anyway?`
      );
      if (!proceed) return;
    }
    if (fromSnapshot) {
      emulator.pause();
      emulator.loadSaveState(this.startState);
      draw();             // repaint immediately from the restored framebuffer
      refreshDebugTools();
    }
    this.playIndex = 0;
    this.loop = loop;
    this.mode = 'playing';
    if (!emulator.running) emulator.start(); // drive continuously; patched runFrame() below feeds each frame's input
    this.onChange?.('playback-started');
  }

  stopPlayback(reason) {
    if (this.mode !== 'playing') return;
    this.mode = 'idle';
    this.loop = false;
    resyncJoypadFromHeldKeys();
    this.onChange?.(reason || 'playback-stopped');
  }

  // Called from the patched runFrame(), once per emulated frame, before that frame runs -
  // so a recorded frame captures the input it's actually about to execute with, and a
  // played-back frame executes with the input it was recorded with.
  _beforeFrame(emu) {
    if (this.mode === 'playing') {
      if (this.playIndex >= this.frames.length) {
        if (!this.loop) { this.stopPlayback('playback-ended'); return; }
        this.playIndex = 0; // wrap around and keep applying frames - no state reload mid-loop
      }
      tasApplyPressedMask(emu, this.frames[this.playIndex]);
      this.playIndex++;
    }
    if (this.mode === 'recording') {
      this.frames.push(tasReadPressedMask(emu.joypad));
    }
  }

  /* ---- export / import ----
     Frame bytes are packed into a Uint8Array and base64-encoded (u8ToBase64/base64ToU8,
     both from emu-gb-core.js) rather than emitted as a giant JSON number array, matching
     how save states already pack their binary blobs. */
  toJSON() {
    if (!this.hasRecording()) return null;
    return {
      format: 'jsgb-tasmovie',
      version: 1,
      createdAt: new Date().toISOString(),
      romTitle: this.romTitle,
      frameCount: this.frames.length,
      frames: u8ToBase64(Uint8Array.from(this.frames)),
      startState: this.startState,
    };
  }

  loadFromJSON(movie) {
    if (!movie || movie.format !== 'jsgb-tasmovie' || !movie.startState || typeof movie.frames !== 'string') {
      throw new Error("That file doesn't look like a valid input-recording movie.");
    }
    this.frames = Array.from(base64ToU8(movie.frames));
    this.startState = movie.startState;
    this.romTitle = movie.romTitle || null;
    this.playIndex = 0;
    this.mode = 'idle';
    this.onChange?.('loaded');
  }
}

const tas = new TASRecorder();

/* ---- patch GBEmulator.prototype.runFrame(): CGBEmulator extends GBEmulator and doesn't
   override runFrame, so this one patch covers both cores, and survives core-toggle/ROM-
   reload recreation in emu-gb-app.js's createEmulator() since it lives on the prototype. ---- */
(function patchRunFrameForTAS() {
  const _origRunFrame = GBEmulator.prototype.runFrame;
  GBEmulator.prototype.runFrame = function () {
    tas._beforeFrame(this);
    _origRunFrame.call(this);
  };
})();

/* ---- lifecycle hooks: a recording's `startState` (and a playback's `playIndex`) only mean
   anything relative to the emulator state they were captured against, so any jump that
   changes that state out from under TAS - a fresh ROM load, a power-cycle reset, a save-
   state load, or a rewind - cancels whatever's in progress rather than silently going
   stale/desynced. Each of these is a top-level `function` declaration in emu-gb-app.js (or,
   for rewind(), a GBEmulator prototype method), so wrapping the name/prototype slot here
   reaches every call site without editing those files. ---- */
(function wireTasLifecycleHooks() {
  const _origLoadROMBytes = loadROMBytes;
  loadROMBytes = async function (bytes) { tas.cancel('rom-loaded'); return _origLoadROMBytes(bytes); };

  const _origResetEmulator = resetEmulator;
  resetEmulator = function (statusMsg) { tas.cancel('reset'); return _origResetEmulator(statusMsg); };

  const _origApplyLoadedState = applyLoadedState;
  applyLoadedState = function (state) { tas.cancel('state-loaded'); return _origApplyLoadedState(state); };

  const _origRewind = GBEmulator.prototype.rewind;
  GBEmulator.prototype.rewind = function () { tas.cancel('rewind'); return _origRewind.call(this); };
})();

/* ---- UI wiring: small panel under Saved States (markup lives in index.html) ---- */
(function wireTasUI() {
  const btnRecord = document.getElementById('btnTasRecord');
  const btnPlay = document.getElementById('btnTasPlay');
  const btnStop = document.getElementById('btnTasStop');
  const btnExport = document.getElementById('btnTasExport');
  const btnImportLabel = document.getElementById('btnTasImportLabel');
  const importInput = document.getElementById('tasImportInput');
  const frameCountBadge = document.getElementById('tasFrameCount');
  const tasInfo = document.getElementById('tasInfo');
  const fromSnapshotCheck = document.getElementById('tasFromSnapshot');
  const loopCheck = document.getElementById('tasLoop');
  const fromSnapshotLabel = document.getElementById('tasFromSnapshotLabel');
  const loopLabel = document.getElementById('tasLoopLabel');
  if (!btnRecord) return; // markup not present - skip UI wiring, the recorder still works headless

  // Game Boy frame rate (154 scanlines x 456 T-cycles at 4.194304MHz), used only to turn a
  // frame count into a human-readable elapsed-time readout below.
  const GB_FPS = 59.73;
  const fmtSecs = (frameCount) => (frameCount / GB_FPS).toFixed(1) + 's';

  function render(reason) {
    const hasROM = emulator.hasROM();
    const recording = tas.isRecording();
    const playing = tas.isPlaying();

    btnRecord.disabled = !hasROM || playing;
    btnRecord.textContent = recording ? '⏺ Recording…' : '⏺ Record';
    btnRecord.classList.toggle('recording', recording);

    btnPlay.disabled = !hasROM || recording || playing || !tas.hasRecording();
    btnPlay.textContent = fromSnapshotCheck.checked ? '▶ Play' : '▶ Play here';
    btnStop.disabled = !(recording || playing);
    btnExport.disabled = !tas.hasRecording() || recording;
    btnImportLabel.classList.toggle('disabled', recording || playing);
    // Changing either option mid-run wouldn't affect the run already in progress, so lock
    // them while recording/playing rather than let them silently do nothing.
    fromSnapshotCheck.disabled = recording || playing;
    loopCheck.disabled = recording || playing;
    fromSnapshotLabel.classList.toggle('active', fromSnapshotCheck.checked);
    loopLabel.classList.toggle('active', loopCheck.checked);

    frameCountBadge.textContent = playing
      ? `${tas.playIndex}/${tas.frames.length} frames${tas.loop ? ' (looping)' : ''}`
      : tas.frames.length + ' frames';

    const liveNote = tas.loop ? ' looping, live, no state reload' : ' live, no state reload';
    switch (reason) {
      case 'recording-started': tasInfo.textContent = 'Recording input from the current save point…'; break;
      case 'recording-stopped': tasInfo.textContent = `Recording stopped (${tas.frames.length} frames, ${fmtSecs(tas.frames.length)} of emulated time).`; break;
      case 'playback-started': tasInfo.textContent = fromSnapshotCheck.checked
        ? `Playing back ${tas.frames.length} frames (${fmtSecs(tas.frames.length)})${tas.loop ? ', looping' : ''}…`
        : `Playing ${tas.frames.length} frames (${fmtSecs(tas.frames.length)}) on top of the current game state -${liveNote}…`;
        break;
      case 'playback-ended': tasInfo.textContent = `Playback finished (${tas.frames.length} frames, ${fmtSecs(tas.frames.length)}).`; break;
      case 'playback-stopped': tasInfo.textContent = `Playback stopped early at frame ${tas.playIndex}/${tas.frames.length}.`; break;
      case 'loaded': tasInfo.textContent = `Recording loaded (${tas.frames.length} frames, ${fmtSecs(tas.frames.length)}) — ready to play.`; break;
      case 'cancelled': if (!recording && !playing) tasInfo.textContent = 'Recording/playback cancelled (emulator state changed).'; break;
      default: if (!tas.hasRecording()) tasInfo.textContent = 'No recording yet.';
    }
  }
  tas.onChange = render;
  render();
  fromSnapshotCheck.addEventListener('change', () => render());
  loopCheck.addEventListener('change', () => render());

  // Live ticker: the frame count only changes inside the hot per-frame path
  // (TASRecorder._beforeFrame), which is too hot to push a UI update from directly, so this
  // polls at a UI-appropriate rate instead - the same pattern emu-gb-guardrails.js uses for
  // the play-time badge. Without this, the panel only refreshed on start/stop and gave no
  // sign that recording had stalled (run loop paused, tab backgrounded, a blocking alert()
  // elsewhere, etc.) until you stopped and found far fewer frames than expected.
  setInterval(() => {
    if (tas.isRecording()) {
      frameCountBadge.textContent = tas.frames.length + ' frames';
      tasInfo.textContent = `Recording… ${tas.frames.length} frames (${fmtSecs(tas.frames.length)}) captured so far.`;
    } else if (tas.isPlaying()) {
      frameCountBadge.textContent = `${tas.playIndex}/${tas.frames.length} frames${tas.loop ? ' (looping)' : ''}`;
      tasInfo.textContent = tas.loop
        ? `Looping… frame ${tas.playIndex}/${tas.frames.length} of the combo.`
        : `Playing back… frame ${tas.playIndex}/${tas.frames.length} (${fmtSecs(tas.playIndex)}/${fmtSecs(tas.frames.length)}).`;
    }
  }, 250);

  btnRecord.addEventListener('click', () => tas.startRecording());
  btnPlay.addEventListener('click', () => tas.startPlayback({
    fromSnapshot: fromSnapshotCheck.checked,
    loop: loopCheck.checked,
  }));
  btnStop.addEventListener('click', () => {
    if (tas.isRecording()) tas.stopRecording();
    else if (tas.isPlaying()) tas.stopPlayback();
  });

  btnExport.addEventListener('click', () => {
    const movie = tas.toJSON();
    if (!movie) return;
    const blob = new Blob([JSON.stringify(movie)], { type: 'application/json' });
    downloadBlob(blob, `${safeRomName()}.tasmovie.json`);
    tasInfo.textContent = 'Recording exported ✓';
  });

  importInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let movie;
      try {
        movie = JSON.parse(ev.target.result);
      } catch {
        alert("That file doesn't look like a valid input-recording movie (not valid JSON).");
        return;
      }
      try {
        tas.loadFromJSON(movie);
        render('loaded');
      } catch (err) {
        alert('Could not load recording: ' + err.message);
      }
    };
    reader.readAsText(file);
    importInput.value = ''; // allow re-importing the same file again later
  });

  // Keep the panel's enabled/disabled state in sync with ROM load/unload the same way the
  // save-state panel does, by piggybacking on its own refresh function rather than adding
  // another lifecycle hook.
  const _origUpdateStateButtons = updateStateButtons;
  updateStateButtons = function () {
    _origUpdateStateButtons();
    render();
  };
})();
