'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listProjects:    ()      => ipcRenderer.invoke('projects:list'),
  openProject:     (id)    => ipcRenderer.invoke('projects:openAll', id),
  openVisualStudio:(id, index) => ipcRenderer.invoke('projects:openVS', id, index),
  openVSCode:      (id)    => ipcRenderer.invoke('projects:openCode', id),
  openCmd:         (id)    => ipcRenderer.invoke('projects:openCmd', id),
  gitStatus:       (id)    => ipcRenderer.invoke('projects:gitStatus', id),
  openTerminal:    (id)    => ipcRenderer.invoke('projects:openTerminal', id),
  generateQR:      (text)  => ipcRenderer.invoke('qr:generate', text),
  onTrayNavigate:  (cb) => {
    const handler = (_e, view) => cb(view);
    ipcRenderer.on('tray:navigate', handler);
    return () => ipcRenderer.removeListener('tray:navigate', handler);
  },
  onConfirmClose: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:confirmClose', handler);
    return () => ipcRenderer.removeListener('app:confirmClose', handler);
  },
  closeDecision: (decision) => ipcRenderer.invoke('app:closeDecision', decision),

  emulator: {
    start:  (opts) => ipcRenderer.invoke('emulator:start', opts),
    cancel: ()     => ipcRenderer.invoke('emulator:cancel'),
    stop:   ()     => ipcRenderer.invoke('emulator:stop'),
    onLog:  (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('emulator:log', handler);
      return () => ipcRenderer.removeListener('emulator:log', handler);
    }
  },

  apkBuild: {
    start:  (opts) => ipcRenderer.invoke('apkBuild:start', opts),
    cancel: ()     => ipcRenderer.invoke('apkBuild:cancel'),
    onLog:  (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('apkBuild:log', handler);
      return () => ipcRenderer.removeListener('apkBuild:log', handler);
    }
  },

  environment: {
    start:   (opts) => ipcRenderer.invoke('environment:start', opts),
    stop:    ()     => ipcRenderer.invoke('environment:stop'),
    restart: (opts) => ipcRenderer.invoke('environment:restart', opts),
    status:  ()     => ipcRenderer.invoke('environment:status'),
    onLog:  (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('environment:log', handler);
      return () => ipcRenderer.removeListener('environment:log', handler);
    }
  },

  parseQR:         (text)  => ipcRenderer.invoke('qr:parse', text),
  decodeQRImage:   (bytes) => ipcRenderer.invoke('qr:decodeImage', bytes),

  sendQr: {
    defaults: ()             => ipcRenderer.invoke('sendqr:defaults'),
    run:      (op, options)  => ipcRenderer.invoke('sendqr:run', op, options),
    onLog:    (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('sendqr:log', handler);
      return () => ipcRenderer.removeListener('sendqr:log', handler);
    }
  },

  settings: {
    get:  ()          => ipcRenderer.invoke('settings:get'),
    save: (overrides) => ipcRenderer.invoke('settings:save', overrides)
  },

  factura: {
    info:         ()               => ipcRenderer.invoke('factura:info'),
    search:       (term, top)      => ipcRenderer.invoke('factura:search', term, top),
    getPedido:    (pedidoId)       => ipcRenderer.invoke('factura:getPedido', pedidoId),
    build:        (opts)           => ipcRenderer.invoke('factura:build', opts),
    history:      ()               => ipcRenderer.invoke('factura:history'),
    clearHistory: ()               => ipcRenderer.invoke('factura:clearHistory'),
    saveSql:      (content, name)  => ipcRenderer.invoke('factura:saveSql', content, name),
    onLog:     (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('factura:log', handler);
      return () => ipcRenderer.removeListener('factura:log', handler);
    }
  },

  showInFolder:   (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openPath:       (p)        => ipcRenderer.invoke('shell:openPath', p),
  openExternal:   (url)      => ipcRenderer.invoke('shell:openExternal', url),

  youtube: {
    defaults:      ()         => ipcRenderer.invoke('youtube:defaults'),
    pickOutputDir: (def)      => ipcRenderer.invoke('youtube:pickOutputDir', def),
    download:      (opts)     => ipcRenderer.invoke('youtube:download', opts),
    getTitle:      (url)      => ipcRenderer.invoke('youtube:getTitle', url),
    cancel:        ()         => ipcRenderer.invoke('youtube:cancel'),
    onLog:         (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('youtube:log', handler);
      return () => ipcRenderer.removeListener('youtube:log', handler);
    }
  },

  video: {
    pickInput:  ()           => ipcRenderer.invoke('video:pickInput'),
    pickOutput: (defaultPath) => ipcRenderer.invoke('video:pickOutput', defaultPath),
    convert:    (opts)        => ipcRenderer.invoke('video:convert', opts),
    cancel:     ()            => ipcRenderer.invoke('video:cancel'),
    onLog:      (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('video:log', handler);
      return () => ipcRenderer.removeListener('video:log', handler);
    }
  },

  b2b: {
    envs:    ()      => ipcRenderer.invoke('b2b:envs'),
    get:     (opts)  => ipcRenderer.invoke('b2b:get', opts),
    onLog:   (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('b2b:log', handler);
      return () => ipcRenderer.removeListener('b2b:log', handler);
    }
  },

  graphUsers: {
    envs:  ()      => ipcRenderer.invoke('graphUsers:envs'),
    list:  (opts)  => ipcRenderer.invoke('graphUsers:list', opts),
    get:   (opts)  => ipcRenderer.invoke('graphUsers:get', opts),
    patch: (opts)  => ipcRenderer.invoke('graphUsers:patch', opts),
    onLog: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('graphUsers:log', handler);
      return () => ipcRenderer.removeListener('graphUsers:log', handler);
    }
  },

  outlook: {
    status:     ()     => ipcRenderer.invoke('outlook:status'),
    connect:    ()     => ipcRenderer.invoke('outlook:connect'),
    signOut:    ()     => ipcRenderer.invoke('outlook:signOut'),
    fetchCodes: (opts) => ipcRenderer.invoke('outlook:fetchCodes', opts),
    onLog:      (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('outlook:log', handler);
      return () => ipcRenderer.removeListener('outlook:log', handler);
    }
  },

  admin: {
    status:   ()  => ipcRenderer.invoke('admin:status'),
    relaunch: ()  => ipcRenderer.invoke('admin:relaunch')
  },

  hosts: {
    get:        ()               => ipcRenderer.invoke('hosts:get'),
    add:        (entry)          => ipcRenderer.invoke('hosts:add', entry),
    setEnabled: (index, enabled) => ipcRenderer.invoke('hosts:setEnabled', index, enabled),
    update:     (index, patch)   => ipcRenderer.invoke('hosts:update', index, patch),
    remove:     (index)          => ipcRenderer.invoke('hosts:remove', index)
  },

  reportes: {
    list:   ()                          => ipcRenderer.invoke('reportes:list'),
    envs:   ()                          => ipcRenderer.invoke('reportes:envs'),
    params: (reportId, env)             => ipcRenderer.invoke('reportes:params', reportId, env),
    run:    (reportId, env, opts)       => ipcRenderer.invoke('reportes:run', reportId, env, opts),
    export: (reportId, data, name)      => ipcRenderer.invoke('reportes:export', reportId, data, name),
    onLog:  (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('reportes:log', handler);
      return () => ipcRenderer.removeListener('reportes:log', handler);
    }
  },

  plexo: {
    envs:   ()      => ipcRenderer.invoke('plexo:envs'),
    list:   (opts)  => ipcRenderer.invoke('plexo:list', opts),
    delete: (opts)  => ipcRenderer.invoke('plexo:delete', opts),
    refundLookup: (opts) => ipcRenderer.invoke('plexo:refund-lookup', opts),
    refund:       (opts) => ipcRenderer.invoke('plexo:refund', opts),
    onLog:  (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('plexo:log', handler);
      return () => ipcRenderer.removeListener('plexo:log', handler);
    }
  },

  oneSignal: {
    config:      ()        => ipcRenderer.invoke('onesignal:config'),
    listDevices: ()        => ipcRenderer.invoke('onesignal:listDevices'),
    send:        (payload) => ipcRenderer.invoke('onesignal:send', payload),
    onLog:       (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('onesignal:log', handler);
      return () => ipcRenderer.removeListener('onesignal:log', handler);
    }
  },

  oneSignalDirect: {
    config:            ()        => ipcRenderer.invoke('onesignalDirect:config'),
    listSubscriptions: (opts)    => ipcRenderer.invoke('onesignalDirect:listSubscriptions', opts),
    preview:           (options) => ipcRenderer.invoke('onesignalDirect:preview', options),
    send:              (options) => ipcRenderer.invoke('onesignalDirect:send', options),
    previewBulk:       (options) => ipcRenderer.invoke('onesignalDirect:previewBulk', options),
    sendBulk:          (options) => ipcRenderer.invoke('onesignalDirect:sendBulk', options),
    pauseBulk:         ()        => ipcRenderer.invoke('onesignalDirect:pauseBulk'),
    resumeBulk:        ()        => ipcRenderer.invoke('onesignalDirect:resumeBulk'),
    retryFailed:       ()        => ipcRenderer.invoke('onesignalDirect:retryFailed'),
    bulkJob:           ()        => ipcRenderer.invoke('onesignalDirect:bulkJob'),
    clearBulk:         ()        => ipcRenderer.invoke('onesignalDirect:clearBulk'),
    onLog:             (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('onesignalDirect:log', handler);
      return () => ipcRenderer.removeListener('onesignalDirect:log', handler);
    }
  },

  jira: {
    config:      ()                       => ipcRenderer.invoke('jira:config'),
    myIssues:    (opts)                   => ipcRenderer.invoke('jira:myIssues', opts),
    issue:       (key)                    => ipcRenderer.invoke('jira:issue', key),
    transitions: (key)                    => ipcRenderer.invoke('jira:transitions', key),
    transition:  (key, transitionId)      => ipcRenderer.invoke('jira:transition', key, transitionId),
    searchUsers: (query, issueKey)        => ipcRenderer.invoke('jira:searchUsers', query, issueKey),
    assign:      (key, accountId)         => ipcRenderer.invoke('jira:assign', key, accountId),
    deleteIssue: (key)                    => ipcRenderer.invoke('jira:deleteIssue', key),
    addWorklog:  (key, timeSpent, comment) => ipcRenderer.invoke('jira:addWorklog', key, timeSpent, comment),
    addComment:  (key, text, mentions)     => ipcRenderer.invoke('jira:addComment', key, text, mentions),
    editComment:   (key, commentId, text, mentions) => ipcRenderer.invoke('jira:editComment', key, commentId, text, mentions),
    deleteComment: (key, commentId)                 => ipcRenderer.invoke('jira:deleteComment', key, commentId),
    onLog:       (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('jira:log', handler);
      return () => ipcRenderer.removeListener('jira:log', handler);
    }
  },

  deudas: {
    get:          ()                        => ipcRenderer.invoke('deudas:get'),
    addDebtor:    (name, note)              => ipcRenderer.invoke('deudas:addDebtor', name, note),
    updateDebtor: (id, patch)               => ipcRenderer.invoke('deudas:updateDebtor', id, patch),
    removeDebtor: (id)                      => ipcRenderer.invoke('deudas:removeDebtor', id),
    addDebt:      (debtorId, debt)          => ipcRenderer.invoke('deudas:addDebt', debtorId, debt),
    updateDebt:   (debtorId, debtId, patch) => ipcRenderer.invoke('deudas:updateDebt', debtorId, debtId, patch),
    removeDebt:   (debtorId, debtId)        => ipcRenderer.invoke('deudas:removeDebt', debtorId, debtId),
    setPaid:      (debtorId, debtId, paid)  => ipcRenderer.invoke('deudas:setPaid', debtorId, debtId, paid),
    registerPayment: (debtorId, amount, note, date) => ipcRenderer.invoke('deudas:registerPayment', debtorId, amount, note, date),
    addSharedDebt: (opts)                   => ipcRenderer.invoke('deudas:addSharedDebt', opts),
    importXlsx:   ()                        => ipcRenderer.invoke('deudas:import'),
    exportDebtor: (debtorId, debtorName)    => ipcRenderer.invoke('deudas:export', debtorId, debtorName),
    exportMany:   (debtorIds, opts)         => ipcRenderer.invoke('deudas:exportMany', debtorIds, opts),
    backup:       ()                        => ipcRenderer.invoke('deudas:backup'),
    restore:      ()                        => ipcRenderer.invoke('deudas:restore'),
    clearHistory: ()                        => ipcRenderer.invoke('deudas:clearHistory')
  },

  misGastos: {
    get:        ()               => ipcRenderer.invoke('misgastos:get'),
    addItem:    (item)            => ipcRenderer.invoke('misgastos:addItem', item),
    updateItem: (id, patch)       => ipcRenderer.invoke('misgastos:updateItem', id, patch),
    removeItem: (id)              => ipcRenderer.invoke('misgastos:removeItem', id),
    setPaid:    (instanceId, paid) => ipcRenderer.invoke('misgastos:setPaid', instanceId, paid)
  },

  gastosStats: {
    get:                 ()                                  => ipcRenderer.invoke('gastosStats:get'),
    importXlsx:          ()                                  => ipcRenderer.invoke('gastosStats:import'),
    setMovementCategory: (monthKey, movementId, category)    => ipcRenderer.invoke('gastosStats:setMovementCategory', monthKey, movementId, category),
    addCategoryRule:     (rule)                               => ipcRenderer.invoke('gastosStats:addCategoryRule', rule),
    removeCategoryRule:  (id)                                 => ipcRenderer.invoke('gastosStats:removeCategoryRule', id),
    addCategory:         (name)                               => ipcRenderer.invoke('gastosStats:addCategory', name),
    removeMonth:         (monthKey)                           => ipcRenderer.invoke('gastosStats:removeMonth', monthKey)
  },

  calistenia: {
    get:                ()              => ipcRenderer.invoke('cali:get'),
    // ejercicios
    saveExercise:       (ex)            => ipcRenderer.invoke('cali:saveExercise', ex),
    removeExercise:     (id)            => ipcRenderer.invoke('cali:removeExercise', id),
    setExerciseActive:  (id, active)    => ipcRenderer.invoke('cali:setExerciseActive', id, active),
    toggleExerciseFavorite: (id)        => ipcRenderer.invoke('cali:toggleExerciseFavorite', id),
    reorderExercise:    (id, dir)       => ipcRenderer.invoke('cali:reorderExercise', id, dir),
    // rutinas
    saveRoutine:        (routine)       => ipcRenderer.invoke('cali:saveRoutine', routine),
    removeRoutine:      (id)            => ipcRenderer.invoke('cali:removeRoutine', id),
    duplicateRoutine:   (id)            => ipcRenderer.invoke('cali:duplicateRoutine', id),
    toggleRoutineFavorite: (id)         => ipcRenderer.invoke('cali:toggleRoutineFavorite', id),
    createFromTemplate: (key)           => ipcRenderer.invoke('cali:createFromTemplate', key),
    // rutinas en video
    saveVideoRoutine:   (video)         => ipcRenderer.invoke('cali:saveVideoRoutine', video),
    removeVideoRoutine: (id)            => ipcRenderer.invoke('cali:removeVideoRoutine', id),
    markVideoRoutineDone: (id, date)    => ipcRenderer.invoke('cali:markVideoRoutineDone', id, date),
    // sesiones
    recordSession:      (session)       => ipcRenderer.invoke('cali:recordSession', session),
    removeSession:      (id)            => ipcRenderer.invoke('cali:removeSession', id),
    clearSessions:      ()              => ipcRenderer.invoke('cali:clearSessions'),
    // plan semanal
    generateWeeklyPlan: ()              => ipcRenderer.invoke('cali:generateWeeklyPlan'),
    setWeeklyPlanDay:   (dayIndex, rid) => ipcRenderer.invoke('cali:setWeeklyPlanDay', dayIndex, rid),
    removeWeeklyPlan:   ()              => ipcRenderer.invoke('cali:removeWeeklyPlan'),
    setSuggestionDecision: (key, dec)   => ipcRenderer.invoke('cali:setSuggestionDecision', key, dec)
  }
});
