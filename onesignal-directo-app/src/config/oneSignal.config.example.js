'use strict';

/**
 * Plantilla committeada de la config de OneSignal para esta app standalone.
 *
 * Copia este archivo a `oneSignal.config.js` (mismo directorio) y completa
 * con los valores reales. `oneSignal.config.js` esta en .gitignore: NUNCA se
 * commitea, pero SI queda embebido dentro del .exe cuando se corre
 * `npm run dist` (todo el equipo comparte las mismas credenciales).
 *
 * apiRestKey nunca se expone al renderer: solo se usa desde el proceso
 * principal (Node) de Electron; getPublicEffective() la enmascara.
 */
module.exports = {
  oneSignal: {
    appId: 'YOUR_ONESIGNAL_APP_ID',
    apiRestKey: 'YOUR_ONESIGNAL_REST_API_KEY',
    baseUrl: 'https://onesignal.com/api/v1'
  },
  // Config del envio "directo" contra la API de OneSignal. Todo es opcional:
  // si el archivo real no declara `direct` o algun campo, se usan estos
  // defaults.
  direct: {
    listLimitPerPage: 300,            // filas por pagina al listar subscriptions (max 300)
    maxPages: 20,                     // tope de paginas a barrer (300 * 20 = 6000 subs)
    defaultThrottleRatePerMinute: 0,  // throttling default del envio masivo (0 = sin throttling)
    defaultSegment: 'Subscribed Users',
    // Fallback CSV export (OneSignal deshabilita /players en apps con +80k users):
    csvMaxRows: 0,                    // tope de filas a parsear del CSV (0 = sin tope)
    csvPollMs: 4000,                  // intervalo de polling del archivo CSV
    csvMaxPollAttempts: 45            // intentos antes de timeout (~3 min con 4s)
  }
};
