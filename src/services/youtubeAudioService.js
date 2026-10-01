'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');
const ffmpegPath = require('ffmpeg-static');
const ffprobeInstall = require('@ffprobe-installer/ffprobe');

const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let currentJob = null; // { child, abortedByUser }
let mediaBinDir = null;
let cachedNodePath; // undefined = not checked yet, null = not found

function getMediaBinDir() {
  if (mediaBinDir) return mediaBinDir;
  mediaBinDir = path.join(app.getPath('userData'), 'media-bin');
  if (!fs.existsSync(mediaBinDir)) fs.mkdirSync(mediaBinDir, { recursive: true });
  return mediaBinDir;
}

function getYtDlpPath() {
  return path.join(getMediaBinDir(), 'yt-dlp.exe');
}

function ensureFfBinaries() {
  const dir = getMediaBinDir();
  const ff   = path.join(dir, 'ffmpeg.exe');
  const ffp  = path.join(dir, 'ffprobe.exe');
  try {
    if (!fs.existsSync(ff))  fs.copyFileSync(ffmpegPath, ff);
    if (!fs.existsSync(ffp)) fs.copyFileSync(ffprobeInstall.path, ffp);
  } catch (e) {
    throw new Error('No se pudo preparar ffmpeg/ffprobe en ' + dir + ': ' + e.message);
  }
  return dir;
}

function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    function request(currentUrl, redirects) {
      if (redirects > 5) { file.close(); fs.unlink(tmp, () => reject(new Error('Demasiados redirects'))); return; }
      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return request(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          fs.unlink(tmp, () => reject(new Error('HTTP ' + res.statusCode + ' descargando ' + currentUrl)));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total) onProgress(downloaded, total);
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.rename(tmp, dest, (err) => err ? reject(err) : resolve());
          });
        });
        file.on('error', (err) => { fs.unlink(tmp, () => reject(err)); });
      }).on('error', (err) => { file.close(); fs.unlink(tmp, () => reject(err)); });
    }
    request(url, 0);
  });
}

function getUpdateMarkerPath() {
  return path.join(getMediaBinDir(), '.last-update-check');
}

// yt-dlp is only downloaded once; YouTube changes frequently break old
// builds (HTTP 403 / "unable to download video data"). Self-update at most
// once a day so a stale binary doesn't silently keep failing.
function maybeSelfUpdate(ytdlpPath, send) {
  return new Promise((resolve) => {
    const marker = getUpdateMarkerPath();
    let age = Infinity;
    try { age = Date.now() - fs.statSync(marker).mtimeMs; } catch (_) { /* never checked */ }
    if (age < UPDATE_CHECK_INTERVAL_MS) return resolve();

    const touch = () => { try { fs.writeFileSync(marker, ''); } catch (_) {} };
    let settled = false;
    const finish = () => { if (settled) return; settled = true; touch(); resolve(); };

    try {
      const child = spawn(ytdlpPath, ['-U'], { windowsHide: true });
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, 20000);
      let out = '';
      child.stdout.on('data', (c) => { out += c.toString('utf8'); });
      child.on('close', () => {
        clearTimeout(timer);
        const updated = /^Updated yt-dlp/m.test(out);
        if (updated) send && send('info', 'yt-dlp actualizado a la ultima version.');
        finish();
      });
      child.on('error', finish);
    } catch (_) {
      finish();
    }
  });
}

async function ensureYtDlp(send) {
  const p = getYtDlpPath();
  if (fs.existsSync(p)) {
    await maybeSelfUpdate(p, send);
    return p;
  }
  send && send('info', 'Primera ejecucion: descargando yt-dlp.exe desde GitHub...');
  let lastPct = -1;
  await downloadToFile(YT_DLP_URL, p, (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      send && send('info', `Descargando yt-dlp: ${pct}% (${(done/1024/1024).toFixed(1)}/${(total/1024/1024).toFixed(1)} MB)`);
      lastPct = pct;
    }
  });
  send && send('info', `yt-dlp guardado en ${p}`);
  try { fs.writeFileSync(getUpdateMarkerPath(), ''); } catch (_) {}
  return p;
}

// yt-dlp needs an external JS runtime to solve YouTube's signature
// challenges; only "deno" is enabled by default and it's not bundled here,
// but Node.js (used to run this app) works too if we point yt-dlp at it.
function findNodeRuntimeArgs() {
  if (cachedNodePath === undefined) {
    cachedNodePath = null;
    try {
      const res = spawnSync('where', ['node'], { windowsHide: true, encoding: 'utf8' });
      const first = (res.stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (res.status === 0 && first) cachedNodePath = first;
    } catch (_) { /* leave null */ }
  }
  return cachedNodePath ? ['--js-runtimes', `node:${cachedNodePath}`] : [];
}

function parseProgressLine(line) {
  // [download]   5.2% of    4.50MiB at  2.30MiB/s ETA 00:03
  // [download] 100% of    4.50MiB in 00:06
  const m = /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\w+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([\d:]+))?/.exec(line);
  if (!m) return null;
  return { percent: parseFloat(m[1]), totalSize: m[2], speed: m[3] || null, eta: m[4] || null };
}

function download(opts, send) {
  return new Promise((resolve, reject) => {
    if (currentJob) {
      reject(new Error('Ya hay una descarga en curso. Cancelala primero.'));
      return;
    }

    const url       = String(opts.url || '').trim();
    const outputDir = String(opts.outputDir || '').trim();
    const bitrate   = Number.isFinite(+opts.bitrateKbps) ? Math.min(320, Math.max(64, +opts.bitrateKbps)) : 192;
    const restrict  = !!opts.restrictFilenames;
    const prefix    = opts.filenamePrefix ? String(opts.filenamePrefix).replace(/[\\/:*?"<>|]/g, '') : '';

    if (!url) return reject(new Error('Falta la URL.'));
    if (!/^https?:\/\//i.test(url)) return reject(new Error('La URL tiene que empezar con http:// o https://'));
    if (!outputDir) return reject(new Error('Falta el directorio de salida.'));
    if (!fs.existsSync(outputDir)) {
      try { fs.mkdirSync(outputDir, { recursive: true }); }
      catch (e) { return reject(new Error('No se pudo crear ' + outputDir + ': ' + e.message)); }
    }

    (async () => {
      try {
        const ytdlp = await ensureYtDlp(send);
        const binDir = ensureFfBinaries();

        const outputTemplate = path.join(outputDir, `${prefix}%(title)s.%(ext)s`);
        const args = [
          '--no-playlist',
          '--newline',
          '--no-mtime',
          ...findNodeRuntimeArgs(),
          '-x',
          '--audio-format', 'mp3',
          '--audio-quality', `${bitrate}K`,
          '--ffmpeg-location', binDir,
          '-o', outputTemplate
        ];
        if (restrict) args.push('--restrict-filenames');
        args.push(url);

        send && send('info', `yt-dlp ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);

        const child = spawn(ytdlp, args, { windowsHide: true });
        currentJob = { child, abortedByUser: false };

        let stdoutBuf = '';
        let stderrTail = '';
        let extractedFile = null;
        const STDERR_TAIL_MAX = 4000;

        const handleLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const prog = parseProgressLine(trimmed);
          if (prog) {
            send && send('progress', prog);
            return;
          }
          // Capture final destination from postprocessor output:
          //   [ExtractAudio] Destination: <path>.mp3
          //   [download] Destination: <path>.<ext>
          const dest = /^\[(?:ExtractAudio|download)\]\s+Destination:\s+(.+)$/.exec(trimmed);
          if (dest) {
            const p = dest[1].trim();
            if (/\.mp3$/i.test(p) || trimmed.startsWith('[ExtractAudio]')) extractedFile = p;
            else if (!extractedFile) extractedFile = p;
          }
          send && send('log', trimmed);
        };

        child.stdout.on('data', (chunk) => {
          stdoutBuf += chunk.toString('utf8');
          let nl;
          while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            handleLine(line);
          }
        });

        child.stderr.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);
          text.split(/\r?\n/).forEach(line => {
            const t = line.trim();
            if (!t) return;
            send && send('warn', t);
          });
        });

        child.on('error', (err) => {
          currentJob = null;
          reject(new Error('No se pudo lanzar yt-dlp: ' + err.message));
        });

        child.on('close', (code, signal) => {
          const wasAborted = currentJob && currentJob.abortedByUser;
          currentJob = null;
          if (wasAborted || signal === 'SIGTERM' || code === null) {
            const err = new Error('Descarga cancelada por el usuario.');
            err.cancelled = true;
            return reject(err);
          }
          if (code === 0) {
            let outPath = extractedFile;
            // Best-effort: if the captured destination has the original ext, try swapping to .mp3
            if (outPath && !/\.mp3$/i.test(outPath)) {
              const swapped = outPath.replace(/\.[^.\\/]+$/, '.mp3');
              if (fs.existsSync(swapped)) outPath = swapped;
            }
            let sizeBytes = null;
            try { if (outPath) sizeBytes = fs.statSync(outPath).size; } catch (_) {}
            return resolve({ outputPath: outPath, sizeBytes });
          }
          const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
          reject(new Error('yt-dlp fallo (exit ' + code + '). ' + tail));
        });
      } catch (e) {
        currentJob = null;
        reject(e);
      }
    })();
  });
}

const FETCH_TITLE_TIMEOUT_MS = 20000;

function fetchTitle(url) {
  return new Promise((resolve, reject) => {
    const u = String(url || '').trim();
    if (!u) return reject(new Error('Falta la URL.'));
    if (!/^https?:\/\//i.test(u)) return reject(new Error('La URL tiene que empezar con http:// o https://'));

    let settled = false;
    let timer = null;
    let child = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    timer = setTimeout(() => {
      if (child) { try { child.kill('SIGTERM'); } catch (_) { /* ignore */ } }
      finish(reject, new Error('Tiempo de espera agotado obteniendo el titulo.'));
    }, FETCH_TITLE_TIMEOUT_MS);

    (async () => {
      try {
        const ytdlp = await ensureYtDlp();
        if (settled) return;
        const args = ['--no-playlist', '--skip-download', '--no-warnings', ...findNodeRuntimeArgs(), '--print', '%(title)s', u];
        child = spawn(ytdlp, args, { windowsHide: true });
        let out = '';
        let errTail = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { errTail = (errTail + chunk.toString('utf8')).slice(-2000); });
        child.on('error', (err) => finish(reject, new Error('No se pudo lanzar yt-dlp: ' + err.message)));
        child.on('close', (code) => {
          if (code === 0) {
            const title = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || null;
            return finish(resolve, { title });
          }
          const tail = errTail.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
          finish(reject, new Error('No se pudo obtener el titulo (exit ' + code + '). ' + tail));
        });
      } catch (e) {
        finish(reject, e);
      }
    })();
  });
}

function cancel() {
  if (!currentJob) return false;
  currentJob.abortedByUser = true;
  try { currentJob.child.kill('SIGTERM'); } catch (_) {}
  return true;
}

function isRunning() { return !!currentJob; }

module.exports = { download, cancel, isRunning, ensureYtDlp, getYtDlpPath, fetchTitle };
