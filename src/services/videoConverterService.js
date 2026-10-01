'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

let currentJob = null; // { child, abortedByUser }

function parseDurationLine(line) {
  // "  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s"
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

function parseProgressLine(line) {
  // "key=value"
  const idx = line.indexOf('=');
  if (idx < 0) return null;
  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

function isCancelMessage(text) {
  return /SIGTERM|SIGINT|Exiting normally, received signal 15/i.test(text);
}

function convert(opts, send) {
  return new Promise((resolve, reject) => {
    if (currentJob) {
      reject(new Error('Ya hay una conversion en curso. Cancelala primero.'));
      return;
    }

    const inputPath  = String(opts.inputPath  || '').trim();
    const outputPath = String(opts.outputPath || '').trim();
    const crf        = Number.isFinite(+opts.crf) ? Math.min(63, Math.max(0, +opts.crf)) : 32;
    const audioKbpsRaw = Number.isFinite(+opts.audioKbps) ? +opts.audioKbps : 128;
    const noAudio    = audioKbpsRaw <= 0;
    const audioKbps  = noAudio ? 0 : Math.min(510, Math.max(32, audioKbpsRaw));

    if (!inputPath)  return reject(new Error('Falta el archivo de entrada.'));
    if (!outputPath) return reject(new Error('Falta el archivo de salida.'));
    if (!fs.existsSync(inputPath)) return reject(new Error(`Entrada no existe: ${inputPath}`));
    if (path.resolve(inputPath) === path.resolve(outputPath)) {
      return reject(new Error('La salida no puede ser igual a la entrada.'));
    }

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      try { fs.mkdirSync(outDir, { recursive: true }); }
      catch (e) { return reject(new Error(`No se pudo crear el directorio de salida: ${e.message}`)); }
    }

    const args = [
      '-hide_banner',
      '-y',
      '-i', inputPath,
      '-c:v', 'libvpx-vp9',
      '-crf', String(crf),
      '-b:v', '0',
      '-row-mt', '1',
      '-deadline', 'good',
      '-cpu-used', '2',
      ...(noAudio ? ['-an'] : ['-c:a', 'libopus', '-b:a', `${audioKbps}k`]),
      '-progress', 'pipe:1',
      '-nostats',
      outputPath
    ];

    send && send('info', `ffmpeg ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);

    let durationSec = null;
    let stdoutBuf = '';
    let stderrTail = '';
    const STDERR_TAIL_MAX = 4000;

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    currentJob = { child, abortedByUser: false };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        const kv = parseProgressLine(line);
        if (!kv) continue;
        if (kv.key === 'out_time_us' || kv.key === 'out_time_ms') {
          // out_time_us is microseconds; out_time_ms in ffmpeg is also microseconds (historical bug)
          const us = parseInt(kv.value, 10);
          if (Number.isFinite(us) && us >= 0) {
            const cur = us / 1_000_000;
            const pct = durationSec ? Math.min(100, (cur / durationSec) * 100) : null;
            send && send('progress', { currentSec: cur, durationSec, percent: pct });
          }
        } else if (kv.key === 'progress' && kv.value === 'end') {
          send && send('progress', { currentSec: durationSec, durationSec, percent: 100 });
        } else if (kv.key === 'speed') {
          send && send('speed', kv.value);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);
      if (durationSec == null) {
        const d = parseDurationLine(text);
        if (d != null) {
          durationSec = d;
          send && send('info', `Duracion detectada: ${d.toFixed(2)}s`);
        }
      }
      // Forward only "interesting" lines as log (avoid the dense stats spam)
      text.split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (!t) return;
        if (/^(Input #|Output #|Stream #|Press \[q\]|frame=|size=)/.test(t)) return;
        send && send('log', t);
      });
    });

    child.on('error', (err) => {
      currentJob = null;
      reject(new Error(`No se pudo lanzar ffmpeg: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      const wasAborted = currentJob && currentJob.abortedByUser;
      currentJob = null;
      if (wasAborted || signal === 'SIGTERM' || code === null) {
        const err = new Error('Conversion cancelada por el usuario.');
        err.cancelled = true;
        return reject(err);
      }
      if (code === 0) {
        let size = null;
        try { size = fs.statSync(outputPath).size; } catch (_) {}
        return resolve({ outputPath, sizeBytes: size, durationSec });
      }
      const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
      reject(new Error(`ffmpeg fallo (exit ${code}). ${tail}`));
    });
  });
}

function cancel() {
  if (!currentJob) return false;
  currentJob.abortedByUser = true;
  try {
    currentJob.child.kill('SIGTERM');
  } catch (_) { /* ignore */ }
  return true;
}

function isRunning() { return !!currentJob; }

module.exports = { convert, cancel, isRunning, ffmpegPath };
