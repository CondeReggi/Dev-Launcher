'use strict';

const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const launcher = require('../services/projectLauncherService');
const emulator = require('../services/emulatorService');
const apkBuild = require('../services/apkBuildService');
const environment = require('../services/environmentService');
const qrParser = require('../services/qrParserService');
const qrImageDecoder = require('../services/qrImageDecoderService');
const sendQr = require('../services/sendQrService');
const b2bCreds = require('../services/b2bCredentialsService');
const graphUsers = require('../services/graphUsersService');
const plexoCards = require('../services/plexoCardsService');
const plexoRefund = require('../services/plexoRefundService');
const jira = require('../services/jiraService');
const outlook = require('../services/outlookMailService');
const factura = require('../services/facturaService');
const elevation = require('../utils/elevation');
const configService = require('../services/configService');
const videoConverter = require('../services/videoConverterService');
const youtubeAudio = require('../services/youtubeAudioService');
const oneSignalDevices = require('../services/oneSignalDevicesService');
const oneSignalNotifications = require('../services/oneSignalNotificationService');
const oneSignalDirect = require('../services/oneSignalDirectService');
const oneSignalConfig = require('../services/oneSignalConfigService');
const deudas = require('../services/deudasService');
const misGastos = require('../services/misGastosService');
const gastosStats = require('../services/gastosStatsService');
const reportes = require('../services/reportesRecurrentesService');
const calistenia = require('../services/calisteniaService');
const hostsFile = require('../services/hostsFileService');
const logger = require('../utils/logger');

const ok   = (data) => ({ ok: true, data });
const fail = (err) => {
  logger.error(err);
  return { ok: false, error: err && err.message ? err.message : String(err) };
};

function register() {
  ipcMain.handle('projects:list', async () => {
    try { return ok(launcher.getProjects()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('projects:openAll', async (_evt, id) => {
    try { await launcher.openProject(id); return ok(); }
    catch (e) { return fail(e); }
  });

  // `index` selecciona cual .sln abrir en proyectos con varias (default: la primera).
  ipcMain.handle('projects:openVS', async (_evt, id, index) => {
    try {
      const p = launcher.getProject(id);
      if (!p) throw new Error(`Proyecto no encontrado: ${id}`);
      const sols = launcher.resolveSolutions(p);
      const i = Number.isInteger(index) ? index : 0;
      if (!sols[i]) throw new Error(`Este proyecto no tiene la solucion #${i} configurada.`);
      await launcher.openVisualStudio(sols[i].path);
      return ok();
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('projects:openCode', async (_evt, id) => {
    try {
      const p = launcher.getProject(id);
      if (!p) throw new Error(`Proyecto no encontrado: ${id}`);
      await launcher.openVSCode(p.folderPath);
      return ok();
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('projects:openCmd', async (_evt, id) => {
    try { await launcher.openCmd(id); return ok(); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('projects:gitStatus', async (_evt, id) => {
    try { return ok(await launcher.getGitStatus(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('projects:openTerminal', async (_evt, id) => {
    try { await launcher.openTerminal(id); return ok(); }
    catch (e) { return fail(e); }
  });

  /* ============= Emulador (mobile / React Native) ============= */

  ipcMain.handle('emulator:start', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('emulator:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await emulator.start(opts || {}, send);
      return ok(result);
    } catch (e) {
      if (e && e.cancelled) { send('cancelled', e.message); return fail(e); }
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('emulator:cancel', async () => {
    try { return ok({ cancelled: emulator.cancel() }); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('emulator:stop', async (evt) => {
    const send = (kind, message) => {
      try { evt.sender.send('emulator:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try { return ok(await emulator.stop(send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  /* ============= Generar APK (mobile) ============= */

  ipcMain.handle('apkBuild:start', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('apkBuild:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await apkBuild.start(opts || {}, send);
      return ok(result);
    } catch (e) {
      if (e && e.cancelled) { send('cancelled', e.message); return fail(e); }
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('apkBuild:cancel', async () => {
    try { return ok({ cancelled: apkBuild.cancel() }); }
    catch (e) { return fail(e); }
  });

  /* ============= Levantar ambiente (dev servers en N terminales) ============= */

  ipcMain.handle('environment:start', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('environment:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await environment.start(opts || {}, send);
      return ok(result);
    } catch (e) {
      if (e && e.cancelled) { send('cancelled', e.message); return fail(e); }
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('environment:stop', async () => {
    try { return ok(await environment.stop()); }
    catch (e) { return fail(e); }
  });

  // Reinicia UN servicio puntual del ambiente (sin tocar los otros).
  ipcMain.handle('environment:restart', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('environment:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      return ok(await environment.restartOne(opts || {}, send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('environment:status', async () => {
    try { return ok(await environment.status()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('qr:decodeImage', async (_evt, payload) => {
    try {
      if (!payload) throw new Error('Adjunta una imagen primero.');
      const buf = Buffer.isBuffer(payload)
        ? payload
        : payload instanceof Uint8Array
          ? Buffer.from(payload)
          : (payload.buffer ? Buffer.from(payload.buffer) : Buffer.from(payload));
      return ok(await qrImageDecoder.decodeFromBuffer(buf));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('qr:parse', async (_evt, text) => {
    try {
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('El texto no puede estar vacio.');
      }
      return ok(qrParser.parseQr(text));
    } catch (e) { return fail(e); }
  });

  /* ============= B2B Credentials ============= */

  ipcMain.handle('b2b:envs', async () => {
    try { return ok(b2bCreds.listEnvs()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('b2b:get', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('b2b:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const data = await b2bCreds.getCredentials(opts || {}, send);
      return ok(data);
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  /* ============= Graph Users (Azure AD B2C via Microsoft Graph) ============= */

  ipcMain.handle('graphUsers:envs', async () => {
    try { return ok(graphUsers.listEnvs()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('graphUsers:list', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('graphUsers:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      return ok(await graphUsers.listUsers(opts || {}, send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('graphUsers:get', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('graphUsers:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      return ok(await graphUsers.getUser(opts || {}, send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('graphUsers:patch', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('graphUsers:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      return ok(await graphUsers.patchUser(opts || {}, send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  /* ============= Admin / elevacion (UAC) ============= */

  ipcMain.handle('admin:status', async () => {
    try { return ok({ isAdmin: await elevation.isElevated() }); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('admin:relaunch', async () => {
    try { await elevation.relaunchAsAdmin(); return ok(); }
    catch (e) { return fail(e); }
  });

  /* ============= Plexo (listar / eliminar tarjetas) ============= */

  // La firma con el certificado (LocalMachine\My) requiere que la app corra elevada.
  const requireAdmin = async (send) => {
    if (await elevation.isElevated()) return true;
    const msg = 'Esta operacion requiere ejecutar la app como administrador.';
    send && send('error', msg);
    return false;
  };

  ipcMain.handle('plexo:envs', async () => {
    try { return ok(plexoCards.listEnvs()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('plexo:list', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('plexo:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      if (!(await requireAdmin(send))) {
        return fail(new Error('Esta operacion requiere ejecutar la app como administrador.'));
      }
      return ok(await plexoCards.listCards(opts || {}, send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('plexo:delete', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('plexo:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      if (!(await requireAdmin(send))) {
        return fail(new Error('Esta operacion requiere ejecutar la app como administrador.'));
      }
      return ok(await plexoCards.deleteCard(opts || {}, send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  /* ===== Plexo: devolucion (refund) de un pago por OrderId ===== */

  // Busca monto + MetaReference (CodigoAutorizacionPasarela) de la orden en la base APP.
  // Solo lee la BD: no firma ni pega contra Plexo, pero se mantiene el gate de admin por
  // consistencia con el resto de la seccion Plexo.
  ipcMain.handle('plexo:refund-lookup', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('plexo:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      if (!(await requireAdmin(send))) {
        return fail(new Error('Esta operacion requiere ejecutar la app como administrador.'));
      }
      return ok(await plexoRefund.getOrderData((opts && opts.ordenId), send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('plexo:refund', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('plexo:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      if (!(await requireAdmin(send))) {
        return fail(new Error('Esta operacion requiere ejecutar la app como administrador.'));
      }
      return ok(await plexoRefund.refund(opts || {}, send));
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  /* ============= Generacion de Facturas (port DistMayoristaGlp) ============= */

  const facturaLog = (evt) => (kind, message) => {
    try { evt.sender.send('factura:log', { kind, message, ts: Date.now() }); }
    catch (_) { /* ignore */ }
  };

  ipcMain.handle('factura:info', async () => {
    try { return ok(factura.getInfo()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('factura:search', async (evt, term, top) => {
    const send = facturaLog(evt);
    try { return ok(await factura.searchPedidos(term, top, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('factura:getPedido', async (evt, pedidoId) => {
    const send = facturaLog(evt);
    try { return ok(await factura.getPedido(pedidoId, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('factura:build', async (evt, opts) => {
    const send = facturaLog(evt);
    try {
      const result = await factura.buildFactura(opts || {}, send);
      // El historial es solo trazabilidad local de scripts YA generados (nunca se
      // ejecuta nada contra la base): si falla no debe romper la respuesta principal.
      try {
        factura.recordHistory({
          pedidoId: result.pedido.id,
          direccionEntrega: (opts && opts.direccionEntrega) || '',
          clienteNombre: result.pedido.clienteNombre,
          numeroCompleto: result.numeroCompleto,
          redondeoOption: result.redondeoOption,
          redondeoAplicado: result.redondeoAplicado,
          totalFinal: result.totals.totalFinal,
          itemCount: result.items.length,
          hasEstadoUpdate: !!result.updateEstadoPedido,
          sql: factura.formatFullSql(result)
        });
      } catch (_) { /* ignore */ }
      return ok(result);
    } catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('factura:history', async () => {
    try { return ok(factura.getHistory()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('factura:clearHistory', async () => {
    try { return ok(factura.clearHistory()); }
    catch (e) { return fail(e); }
  });

  // Guarda el SQL ya generado a un archivo .sql (alternativa a solo copiarlo).
  // Nunca ejecuta el script: solo escribe el texto tal cual a disco.
  ipcMain.handle('factura:saveSql', async (evt, content, suggestedName) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const name = String(suggestedName || 'factura.sql').replace(/[\\/:*?"<>|]/g, '_');
      const r = await dialog.showSaveDialog(win, {
        title: 'Guardar script SQL',
        defaultPath: name,
        filters: [{ name: 'SQL', extensions: ['sql'] }]
      });
      if (r.canceled || !r.filePath) return ok(null);
      fs.writeFileSync(r.filePath, String(content || ''), 'utf8');
      return ok({ filePath: r.filePath });
    } catch (e) { return fail(e); }
  });

  /* ============= Reportes recurrentes ============= */

  ipcMain.handle('reportes:list', async () => {
    try { return ok(reportes.listReports()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('reportes:envs', async () => {
    try { return ok(reportes.listEnvs()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('reportes:params', async (evt, reportId, env) => {
    try { return ok(await reportes.getReportParams(reportId, env)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('reportes:run', async (evt, reportId, env, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('reportes:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      return ok(await reportes.runReport(reportId, env, opts, send));
    } catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('reportes:export', async (evt, reportId, data, suggestedName) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const name = String(suggestedName || `${reportId}.xlsx`).replace(/[\\/:*?"<>|]/g, '_');
      let defDir; try { defDir = app.getPath('desktop'); } catch (_) { /* ignore */ }
      const r = await dialog.showSaveDialog(win, {
        title: 'Exportar reporte',
        defaultPath: defDir ? path.join(defDir, name) : name,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (r.canceled || !r.filePath) return ok(null);
      return ok(reportes.exportReport(reportId, data || {}, r.filePath));
    } catch (e) { return fail(e); }
  });

  /* ============= Settings (sendQr config) ============= */

  ipcMain.handle('settings:get', async () => {
    try {
      return ok({
        defaults:  configService.loadDefaults(),
        overrides: configService.loadOverrides(),
        effective: configService.getEffective()
      });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('settings:save', async (_evt, overrides) => {
    try {
      configService.saveOverrides(overrides || {});
      return ok({ effective: configService.getEffective() });
    } catch (e) { return fail(e); }
  });

  /* ============= DUCSA Tools (sendQr port) ============= */

  ipcMain.handle('sendqr:defaults', async () => {
    try { return ok(sendQr.getDefaults()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('sendqr:run', async (evt, op, options) => {
    const send = (kind, message) => {
      try { evt.sender.send('sendqr:log', { op, kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      send('info', `Iniciando "${op}"...`);
      switch (op) {
        case 'qr':         await sendQr.processQr(options || {}, send); break;
        case 'entidades':  await sendQr.processEntidades(options || {}, send); break;
        case 'convenios':  await sendQr.processConvenios(options || {}, send); break;
        case 'usuarios':   await sendQr.processUsuarios(options || {}, send); break;
        case 'identity':   await sendQr.validateIdentity(options || {}, send); break;
        case 'magento':    await sendQr.validateMagento(options || {}, send); break;
        default: throw new Error(`Operacion desconocida: ${op}`);
      }
      return ok();
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('shell:showItemInFolder', async (_evt, filePath) => {
    try {
      if (!filePath) throw new Error('Sin ruta.');
      shell.showItemInFolder(filePath);
      return ok();
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('shell:openPath', async (_evt, p) => {
    try {
      if (!p) throw new Error('Sin ruta.');
      const target = path.extname(p) ? path.dirname(p) : p;
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
      return ok();
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('shell:openExternal', async (_evt, url) => {
    try {
      const u = String(url || '').trim();
      // Solo http/https para no abrir esquemas peligrosos desde la UI.
      if (!/^https?:\/\//i.test(u)) throw new Error('URL invalida (solo http/https).');
      await shell.openExternal(u);
      return ok();
    } catch (e) { return fail(e); }
  });

  /* ============= Jira (solapa Tareas) ============= */

  ipcMain.handle('jira:config', async () => {
    try { return ok(jira.getPublicConfig()); }
    catch (e) { return fail(e); }
  });

  const jiraLog = (evt) => (kind, message) => {
    try { evt.sender.send('jira:log', { kind, message, ts: Date.now() }); }
    catch (_) { /* ignore */ }
  };

  ipcMain.handle('jira:myIssues', async (evt, opts) => {
    const send = jiraLog(evt);
    try { return ok(await jira.getMyIssues(opts || {}, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:issue', async (evt, issueKey) => {
    const send = jiraLog(evt);
    try { return ok(await jira.getIssueDetail(issueKey, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:transitions', async (evt, issueKey) => {
    const send = jiraLog(evt);
    try { return ok(await jira.getIssueTransitions(issueKey, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:transition', async (evt, issueKey, transitionId) => {
    const send = jiraLog(evt);
    try { return ok(await jira.transitionIssue(issueKey, transitionId, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:searchUsers', async (evt, query, issueKey) => {
    const send = jiraLog(evt);
    try { return ok(await jira.searchUsers(query, issueKey, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:assign', async (evt, issueKey, accountId) => {
    const send = jiraLog(evt);
    try { return ok(await jira.assignIssue(issueKey, accountId, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:deleteIssue', async (evt, issueKey) => {
    const send = jiraLog(evt);
    try { return ok(await jira.deleteIssue(issueKey, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:addWorklog', async (evt, issueKey, timeSpent, comment) => {
    const send = jiraLog(evt);
    try { return ok(await jira.addWorklog(issueKey, timeSpent, comment, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:addComment', async (evt, issueKey, text, mentions) => {
    const send = jiraLog(evt);
    try { return ok(await jira.addComment(issueKey, text, mentions, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:editComment', async (evt, issueKey, commentId, text, mentions) => {
    const send = jiraLog(evt);
    try { return ok(await jira.editComment(issueKey, commentId, text, mentions, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('jira:deleteComment', async (evt, issueKey, commentId) => {
    const send = jiraLog(evt);
    try { return ok(await jira.deleteComment(issueKey, commentId, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  /* ============= Outlook (correos de TuPase -> codigos) ============= */

  const outlookLog = (evt) => (kind, message) => {
    try { evt.sender.send('outlook:log', { kind, message, ts: Date.now() }); }
    catch (_) { /* ignore */ }
  };

  ipcMain.handle('outlook:status', async () => {
    try { return ok(outlook.getStatus()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('outlook:connect', async (evt) => {
    const send = outlookLog(evt);
    try { return ok(await outlook.startAuth({}, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  ipcMain.handle('outlook:signOut', async () => {
    try { return ok(outlook.signOut()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('outlook:fetchCodes', async (evt, opts) => {
    const send = outlookLog(evt);
    try { return ok(await outlook.fetchCodes(opts || {}, send)); }
    catch (e) { send('error', e.message || String(e)); return fail(e); }
  });

  /* ============= Video converter (mp4 -> webm) ============= */

  ipcMain.handle('video:pickInput', async (evt) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const r = await dialog.showOpenDialog(win, {
        title: 'Elegi un video de entrada',
        properties: ['openFile'],
        filters: [
          { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv'] },
          { name: 'Todos', extensions: ['*'] }
        ]
      });
      if (r.canceled || !r.filePaths.length) return ok(null);
      const inputPath = r.filePaths[0];
      const parsed = path.parse(inputPath);
      const suggestedOutput = path.join(parsed.dir, `${parsed.name}.webm`);
      return ok({ inputPath, suggestedOutput });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('video:pickOutput', async (evt, defaultPath) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const r = await dialog.showSaveDialog(win, {
        title: 'Guardar WebM como',
        defaultPath: defaultPath || 'output.webm',
        filters: [{ name: 'WebM', extensions: ['webm'] }]
      });
      if (r.canceled || !r.filePath) return ok(null);
      return ok({ outputPath: r.filePath });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('video:convert', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('video:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await videoConverter.convert(opts || {}, send);
      send('done', result);
      return ok(result);
    } catch (e) {
      if (e && e.cancelled) {
        send('cancelled', e.message);
        return fail(e);
      }
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('video:cancel', async () => {
    try { return ok({ cancelled: videoConverter.cancel() }); }
    catch (e) { return fail(e); }
  });

  /* ============= YouTube -> MP3 ============= */

  ipcMain.handle('youtube:defaults', async () => {
    try {
      let dir = '';
      try { dir = app.getPath('music'); }
      catch (_) { try { dir = app.getPath('downloads'); } catch (_) { dir = app.getPath('home'); } }
      return ok({ outputDir: dir });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('youtube:pickOutputDir', async (evt, defaultPath) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const r = await dialog.showOpenDialog(win, {
        title: 'Carpeta destino',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: defaultPath || undefined
      });
      if (r.canceled || !r.filePaths.length) return ok(null);
      return ok({ outputDir: r.filePaths[0] });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('youtube:download', async (evt, opts) => {
    const send = (kind, message) => {
      try { evt.sender.send('youtube:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const result = await youtubeAudio.download(opts || {}, send);
      send('done', result);
      return ok(result);
    } catch (e) {
      if (e && e.cancelled) {
        send('cancelled', e.message);
        return fail(e);
      }
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('youtube:getTitle', async (evt, url) => {
    try { return ok(await youtubeAudio.fetchTitle(url)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('youtube:cancel', async () => {
    try { return ok({ cancelled: youtubeAudio.cancel() }); }
    catch (e) { return fail(e); }
  });

  /* ============= OneSignal ============= */

  ipcMain.handle('onesignal:config', async () => {
    try { return ok(oneSignalConfig.getPublicEffective()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('onesignal:listDevices', async (evt) => {
    const send = (kind, message) => {
      try { evt.sender.send('onesignal:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      const devices = await oneSignalDevices.listDevices(send);
      return ok({ devices, count: devices.length });
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  ipcMain.handle('onesignal:send', async (evt, payload) => {
    const send = (kind, message) => {
      try { evt.sender.send('onesignal:log', { kind, message, ts: Date.now() }); }
      catch (_) { /* ignore */ }
    };
    try {
      if (!payload || typeof payload !== 'object') throw new Error('Payload requerido.');
      const result = await oneSignalNotifications.sendToDevice({
        pnsHandle: payload.pnsHandle,
        title:     payload.title,
        message:   payload.message
      }, send);
      return ok(result);
    } catch (e) {
      send('error', e.message || String(e));
      return fail(e);
    }
  });

  /* ============= OneSignal (directo a la API) ============= */

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

  /* ============= Deudas (control de deudores / pagos) ============= */

  ipcMain.handle('deudas:get', async () => {
    try { return ok(deudas.getState()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:addDebtor', async (_evt, name, note) => {
    try { return ok(deudas.addDebtor(name, note)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:updateDebtor', async (_evt, id, patch) => {
    try { return ok(deudas.updateDebtor(id, patch)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:removeDebtor', async (_evt, id) => {
    try { return ok(deudas.removeDebtor(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:addDebt', async (_evt, debtorId, debt) => {
    try { return ok(deudas.addDebt(debtorId, debt)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:updateDebt', async (_evt, debtorId, debtId, patch) => {
    try { return ok(deudas.updateDebt(debtorId, debtId, patch)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:removeDebt', async (_evt, debtorId, debtId) => {
    try { return ok(deudas.removeDebt(debtorId, debtId)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:setPaid', async (_evt, debtorId, debtId, paid) => {
    try { return ok(deudas.setPaid(debtorId, debtId, paid)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:registerPayment', async (_evt, debtorId, amount, note, date) => {
    try { return ok(deudas.registerPayment(debtorId, amount, note, date)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:addSharedDebt', async (_evt, opts) => {
    try { return ok(deudas.addSharedDebt(opts || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:clearHistory', async () => {
    try { return ok(deudas.clearHistory()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:import', async (evt) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      let defPath;
      try { defPath = path.join(app.getPath('desktop'), 'Deudas_new.xlsx'); } catch (_) { /* ignore */ }
      const r = await dialog.showOpenDialog(win, {
        title: 'Importar deudas desde Excel',
        properties: ['openFile'],
        defaultPath: defPath,
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (r.canceled || !r.filePaths.length) return ok(null);
      return ok(deudas.importFromXlsx(r.filePaths[0]));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:export', async (evt, debtorId, debtorName) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const safe = String(debtorName || 'deudor').replace(/[\\/:*?"<>|]/g, '_').trim();
      let defDir; try { defDir = app.getPath('desktop'); } catch (_) { /* ignore */ }
      const fileName = `Estado de cuenta - ${safe}.xlsx`;
      const r = await dialog.showSaveDialog(win, {
        title: 'Exportar estado de cuenta',
        defaultPath: defDir ? path.join(defDir, fileName) : fileName,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (r.canceled || !r.filePath) return ok(null);
      return ok(deudas.exportDebtor(debtorId, r.filePath));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:exportMany', async (evt, debtorIds, opts) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      let defDir; try { defDir = app.getPath('desktop'); } catch (_) { /* ignore */ }
      const stamp = new Date().toISOString().slice(0, 10);
      const fileName = `Deudas - ${stamp}.xlsx`;
      const r = await dialog.showSaveDialog(win, {
        title: 'Exportar deudas seleccionadas',
        defaultPath: defDir ? path.join(defDir, fileName) : fileName,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (r.canceled || !r.filePath) return ok(null);
      return ok(deudas.exportDebtors(debtorIds || [], r.filePath, opts || {}));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:backup', async (evt) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      let defDir; try { defDir = app.getPath('desktop'); } catch (_) { /* ignore */ }
      const stamp = new Date().toISOString().slice(0, 10);
      const fileName = `deudas-respaldo-${stamp}.json`;
      const r = await dialog.showSaveDialog(win, {
        title: 'Respaldar deudas',
        defaultPath: defDir ? path.join(defDir, fileName) : fileName,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (r.canceled || !r.filePath) return ok(null);
      return ok(deudas.exportBackup(r.filePath));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('deudas:restore', async (evt) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      let defDir; try { defDir = app.getPath('desktop'); } catch (_) { /* ignore */ }
      const r = await dialog.showOpenDialog(win, {
        title: 'Restaurar deudas desde respaldo',
        properties: ['openFile'],
        defaultPath: defDir,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (r.canceled || !r.filePaths.length) return ok(null);
      return ok(deudas.importBackup(r.filePaths[0]));
    } catch (e) { return fail(e); }
  });

  /* ============= Estadisticas de Gastos (import mensual de extracto bancario) ============= */

  ipcMain.handle('gastosStats:get', async () => {
    try { return ok(gastosStats.getState()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('gastosStats:import', async (evt) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      let defDir; try { defDir = app.getPath('downloads'); } catch (_) { /* ignore */ }
      const r = await dialog.showOpenDialog(win, {
        title: 'Importar movimientos del mes (Excel)',
        properties: ['openFile'],
        defaultPath: defDir,
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (r.canceled || !r.filePaths.length) return ok(null);
      return ok(gastosStats.importFromXlsx(r.filePaths[0]));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('gastosStats:setMovementCategory', async (_evt, monthKey, movementId, category) => {
    try { return ok(gastosStats.setMovementCategory(monthKey, movementId, category)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('gastosStats:addCategoryRule', async (_evt, rule) => {
    try { return ok(gastosStats.addCategoryRule(rule || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('gastosStats:removeCategoryRule', async (_evt, id) => {
    try { return ok(gastosStats.removeCategoryRule(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('gastosStats:addCategory', async (_evt, name) => {
    try { return ok(gastosStats.addCategory(name)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('gastosStats:removeMonth', async (_evt, monthKey) => {
    try { return ok(gastosStats.removeMonth(monthKey)); }
    catch (e) { return fail(e); }
  });

  /* ============= Mis Gastos (gastos fijos mensuales, "Deudas mias") ============= */

  ipcMain.handle('misgastos:get', async () => {
    try { return ok(misGastos.getState()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('misgastos:addItem', async (_evt, item) => {
    try { return ok(misGastos.addItem(item)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('misgastos:updateItem', async (_evt, id, patch) => {
    try { return ok(misGastos.updateItem(id, patch)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('misgastos:removeItem', async (_evt, id) => {
    try { return ok(misGastos.removeItem(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('misgastos:setPaid', async (_evt, instanceId, paid) => {
    try { return ok(misGastos.setPaid(instanceId, paid)); }
    catch (e) { return fail(e); }
  });

  /* ---------- Entrenamiento (calistenia) ---------- */

  ipcMain.handle('cali:get', async () => {
    try { return ok(calistenia.getState()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:saveExercise', async (_evt, ex) => {
    try { return ok(calistenia.saveExercise(ex || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:removeExercise', async (_evt, id) => {
    try { return ok(calistenia.removeExercise(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:setExerciseActive', async (_evt, id, active) => {
    try { return ok(calistenia.setExerciseActive(id, active)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:toggleExerciseFavorite', async (_evt, id) => {
    try { return ok(calistenia.toggleExerciseFavorite(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:reorderExercise', async (_evt, id, dir) => {
    try { return ok(calistenia.reorderExerciseDifficulty(id, dir)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:toggleRoutineFavorite', async (_evt, id) => {
    try { return ok(calistenia.toggleRoutineFavorite(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:createFromTemplate', async (_evt, key) => {
    try { return ok(calistenia.createFromTemplate(key)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:saveRoutine', async (_evt, routine) => {
    try { return ok(calistenia.saveRoutine(routine || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:removeRoutine', async (_evt, id) => {
    try { return ok(calistenia.removeRoutine(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:duplicateRoutine', async (_evt, id) => {
    try { return ok(calistenia.duplicateRoutine(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:saveVideoRoutine', async (_evt, video) => {
    try { return ok(calistenia.saveVideoRoutine(video || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:removeVideoRoutine', async (_evt, id) => {
    try { return ok(calistenia.removeVideoRoutine(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:markVideoRoutineDone', async (_evt, id, date) => {
    try { return ok(calistenia.markVideoRoutineDone(id, date)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:recordSession', async (_evt, session) => {
    try { return ok(calistenia.recordSession(session || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:removeSession', async (_evt, id) => {
    try { return ok(calistenia.removeSession(id)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:clearSessions', async () => {
    try { return ok(calistenia.clearSessions()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:generateWeeklyPlan', async () => {
    try { return ok(calistenia.generateWeeklyPlan()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:setWeeklyPlanDay', async (_evt, dayIndex, routineId) => {
    try { return ok(calistenia.setWeeklyPlanDay(dayIndex, routineId)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:removeWeeklyPlan', async () => {
    try { return ok(calistenia.removeWeeklyPlan()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('cali:setSuggestionDecision', async (_evt, key, decision) => {
    try { return ok(calistenia.setSuggestionDecision(key, decision)); }
    catch (e) { return fail(e); }
  });

  /* ============= Hosts (C:\Windows\System32\drivers\etc\hosts) ============= */

  // Leer no requiere admin (el archivo es de lectura publica); escribir si.
  const requireAdminForHosts = async () => {
    if (await elevation.isElevated()) return;
    throw new Error('Esta operacion requiere ejecutar la app como administrador.');
  };

  ipcMain.handle('hosts:get', async () => {
    try { return ok(hostsFile.getState()); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('hosts:add', async (_evt, entry) => {
    try { await requireAdminForHosts(); return ok(hostsFile.addEntry(entry || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('hosts:setEnabled', async (_evt, index, enabled) => {
    try { await requireAdminForHosts(); return ok(hostsFile.setEnabled(index, enabled)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('hosts:update', async (_evt, index, patch) => {
    try { await requireAdminForHosts(); return ok(hostsFile.updateEntry(index, patch || {})); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('hosts:remove', async (_evt, index) => {
    try { await requireAdminForHosts(); return ok(hostsFile.removeEntry(index)); }
    catch (e) { return fail(e); }
  });

  ipcMain.handle('qr:generate', async (_evt, text) => {
    try {
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('El texto no puede estar vacio.');
      }
      const dataUrl = await QRCode.toDataURL(text, {
        errorCorrectionLevel: 'M',
        margin: 2,
        scale: 8,
        color: { dark: '#0f172a', light: '#ffffff' }
      });
      return ok({ dataUrl });
    } catch (e) { return fail(e); }
  });
}

module.exports = { register };
