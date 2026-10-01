'use strict';

/**
 * Feedback sonoro del runner (sin archivos de audio: se generan tonos con la
 * WebAudio API, asi evitamos problemas de CSP/empaquetado y de autoplay con
 * <audio>). Expuesto como window.__caliSound.
 *
 *  - tick():   "tic" corto para la cuenta regresiva (ultimos 3s de un descanso/intervalo).
 *  - bell():   campana al terminar un descanso/intervalo.
 *  - beep(hi): pitido de la cuenta 3-2-1 (hi=true para el "ya").
 *
 * El AudioContext arranca suspendido hasta un gesto del usuario (politica de
 * autoplay). `unlock()` debe llamarse desde un click (ej: "Ejecutar") para
 * habilitarlo. La preferencia on/off se guarda en localStorage.
 */
(function () {
  const KEY = 'devlauncher.cali.sound';
  let ctx = null;
  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== '0'; } catch (_) { /* ignore */ }

  // Anti-rebote: no repetir el mismo sonido si se dispara dos veces casi juntas.
  const lastAt = {};
  function debounced(tag, ms) {
    const now = Date.now();
    if (lastAt[tag] && now - lastAt[tag] < ms) return false;
    lastAt[tag] = now;
    return true;
  }

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  function unlock() {
    const c = ensureCtx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  // Tono simple con envolvente para que no "cliquee".
  function tone(freq, durMs, type, gainPeak) {
    if (!enabled) return;
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    const peak = gainPeak == null ? 0.18 : gainPeak;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.02);
  }

  function tick() { if (debounced('tick', 250)) tone(880, 90, 'square', 0.12); }
  function bell() {
    if (!debounced('bell', 600)) return;
    tone(1320, 320, 'sine', 0.2);
    setTimeout(() => tone(1760, 360, 'sine', 0.16), 70);
  }
  function beep(hi) {
    if (!debounced(hi ? 'beepHi' : 'beep', 250)) return;
    tone(hi ? 1245 : 660, hi ? 420 : 200, 'triangle', 0.2);
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (_) { /* ignore */ }
    if (enabled) unlock();
  }
  function isEnabled() { return enabled; }

  window.__caliSound = { unlock, tick, bell, beep, setEnabled, isEnabled };
})();
