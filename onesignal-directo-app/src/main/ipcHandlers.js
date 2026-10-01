'use strict';

const { ipcMain, shell } = require('electron');
const oneSignalConfig = require('../services/oneSignalConfigService');
const oneSignalDirect = require('../services/oneSignalDirectService');
const logger = require('../utils/logger');

const ok = (data) => ({ ok: true, data });
const fail = (err) => {
  logger.error(err);
  return { ok: false, error: err && err.message ? err.message : String(err) };
};

function register() {
  ipcMain.handle('onesignalDirect:config', async () => {
    try { return ok(oneSignalConfig.getPublicEffective()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('onesignalDirect:listSubscriptions', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('onesignalDirect:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await oneSignalDirect.listSubscriptions(opts || {}, send);
      return ok(result);
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  // Preview: arma el curl + body sin enviar nada. La REST key va enmascarada.
  ipcMain.handle('onesignalDirect:preview', async (_evt, options) => {
    try {
      if (!options || typeof options !== 'object') throw new Error('Opciones requeridas.');
      return ok(oneSignalDirect.preview(options));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('onesignalDirect:send', async (evt, options) => {
    const send = (kind, message) => {
      try { evt.sender.send('onesignalDirect:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      if (!options || typeof options !== 'object') throw new Error('Opciones requeridas.');
      const result = await oneSignalDirect.send(options, send);
      return ok(result);
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  // Envio por bloques con throttle propio (cuando el plan no tiene throttling)
  ipcMain.handle('onesignalDirect:previewBulk', async (_evt, options) => {
    try {
      if (!options || typeof options !== 'object') throw new Error('Opciones requeridas.');
      return ok(oneSignalDirect.previewBulk(options));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('onesignalDirect:sendBulk', async (evt, options) => {
    const send = (kind, message) => {
      try { evt.sender.send('onesignalDirect:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      if (!options || typeof options !== 'object') throw new Error('Opciones requeridas.');
      const result = await oneSignalDirect.sendBulk(options, send);
      return ok(result);
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('onesignalDirect:pauseBulk', async () => {
    try { oneSignalDirect.pauseBulk(); return ok(); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('onesignalDirect:resumeBulk', async (evt) => {
    const send = (kind, message) => {
      try { evt.sender.send('onesignalDirect:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await oneSignalDirect.resumeBulk(send);
      return ok(result);
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('onesignalDirect:retryFailed', async (evt) => {
    const send = (kind, message) => {
      try { evt.sender.send('onesignalDirect:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await oneSignalDirect.retryFailed(send);
      return ok(result);
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('onesignalDirect:bulkJob', async () => {
    try { return ok(oneSignalDirect.getBulkJob()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('onesignalDirect:clearBulk', async () => {
    try { return ok(oneSignalDirect.clearBulkJob()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('shell:openExternal', async (_evt, url) => {
    try {
      const u = String(url || '').trim();
      if (!/^https?:\/\//i.test(u)) throw new Error('URL invalida (solo http/https).');
      await shell.openExternal(u);
      return ok();
    } catch (e) { return fail(e); }
  });
}

module.exports = { register };
