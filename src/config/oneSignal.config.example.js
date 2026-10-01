'use strict';

/**
 * Plantilla committeada de la config de OneSignal.
 *
 * Copia este archivo a `oneSignal.config.js` (mismo directorio) y rellena con
 * los valores reales. `oneSignal.config.js` esta en .gitignore.
 *
 * Estructura analoga a la del `appsettings.json` original del backend .NET:
 *   ConnectionStrings.AppCS  -> sql.connectionString
 *   OneSignal.AppId          -> oneSignal.appId
 *   OneSignal.ApiRestKey     -> oneSignal.apiRestKey
 *
 * IMPORTANTE:
 *  - No hardcodear secretos en codigo.
 *  - apiRestKey nunca se expone al renderer; vive solo en el main process.
 *  - Si preferis variables de entorno, podes setear:
 *      DEVL_APP_CS               -> connection string (gana sobre el archivo)
 *      DEVL_ONESIGNAL_APP_ID     -> idem
 *      DEVL_ONESIGNAL_API_KEY    -> idem
 *    Si una env var esta definida, sobreescribe el valor del archivo.
 *
 * Formatos validos de connection string (driver: mssql / tedious):
 *   "Server=HOST;Database=DB;User Id=u;Password=p;Encrypt=true;TrustServerCertificate=true"
 *   "mssql://u:p@HOST:1433/DB?encrypt=true&trustServerCertificate=true"
 *   "Server=HOST;Database=DB;Integrated Security=true"  (Windows auth)
 */
module.exports = {
  sql: {
    connectionString: 'Server=YOUR_SQL_SERVER;Database=YOUR_DB;User Id=YOUR_USER;Password=YOUR_PWD;Encrypt=true;TrustServerCertificate=true',
    requestTimeoutMs: 30000
  },
  oneSignal: {
    appId: 'YOUR_ONESIGNAL_APP_ID',
    apiRestKey: 'YOUR_ONESIGNAL_REST_API_KEY',
    baseUrl: 'https://onesignal.com/api/v1'
  },
  // Como interpretar el campo PnsHandle frente a la API de OneSignal:
  //   'external_user_id' -> include_external_user_ids (ID propio del backend)
  //   'player_id'        -> include_player_ids        (ID del SDK de OneSignal)
  // Default razonable: external_user_id (es lo mas comun cuando ya tenes una
  // tabla de usuarios mapeada a OneSignal). Cambialo si tu PnsHandle es un
  // playerId / subscription id de OneSignal.
  targeting: {
    pnsHandleAs: 'external_user_id'
  },
  // Config del envio "directo" contra la API de OneSignal (vista
  // "Notificaciones OneSignal (directo)"). Todo es opcional: si falta la
  // seccion, el config service aplica estos mismos defaults.
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
