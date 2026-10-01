'use strict';

/**
 * Plantilla committeada de la config baseline (sendQr / DUCSA Tools / B2B / Graph / Plexo /
 * Outlook / Factura / Reportes).
 *
 * Copia este archivo a `sendQr.config.js` (mismo directorio) y completa con los valores
 * reales. `sendQr.config.js` esta en .gitignore: NUNCA lo commitees.
 * Mientras no exista, la app arranca usando esta plantilla (todo vacio / placeholders).
 *
 * Los valores tambien se pueden editar desde la UI (Configuracion): se guardan en
 * `sendQr.overrides.json` (gitignored) y pisan a los de este archivo.
 *
 * auth.clientSecretEncrypted va cifrado con AES-256-CBC usando aes.keyBase64 / aes.ivBase64.
 * Para cifrar un secret nuevo (con tu sendQr.config.js ya creado):
 *   node -e "console.log(require('./src/utils/aesCbc').encrypt('PLAINTEXT'))"
 */
module.exports = {
  // Operacion 1 (Procesar QR)
  qr: {
    rutaExcel: 'C:\\Users\\YOUR_USER\\Downloads',
    nombreArchivo: 'Qr.xlsx',
    columnaQr: 'F',
    urlBaseServices: 'https://YOUR_SERVICES_HOST/',
    delaySeconds: 2
  },

  // Operacion 2 (Procesar Entidades)
  entidades: {
    rutaWord: 'C:\\Users\\YOUR_USER\\Downloads',
    nombreArchivoTxt: 'entidades.txt',
    urlIntegrador: 'http://YOUR_INTEGRADOR_HOST/',
    endpoint: 'api/EntidadGenerica/agregarEntidades',
    tipoEntidadId: 0,
    eliminado: 1,
    datosFijos: { idDispositivo: 0, idProducto: 1, participaListaBlanca: 'S' },
    delaySeconds: 3
  },

  // Operacion 3 (Procesar Convenios por Cedula)
  convenios: {
    rutaExcelCedula: 'C:\\Users\\YOUR_USER\\Downloads',
    nombreArchivoCedula: 'cedulas.xlsx',
    columnaCedula: 'A',
    urlBaseServicesTransaccional: 'http://YOUR_TRANSACCIONAL_HOST/',
    tokenUrl: 'https://YOUR_B2B_HOST/api/Ping/test-token',
    delaySeconds: 1
  },

  // Operacion 4 (Procesar Usuarios - Azure Concentrador)
  usuarios: {
    rutaExcelUsuarios: 'C:\\Users\\YOUR_USER\\Downloads',
    nombreArchivoUsuarios: 'usuariosTransaccional.xlsx',
    urlBaseConcentrador: 'https://YOUR_B2B_HOST/appConvenios/vX.Y.Z/api/',
    endpoint: 'Usuarios/Create/Azure',
    bearerToken: '',
    apiClientSecret: '',
    defaultPassword: '',
    tenantUsuarioChofer: '',
    delaySeconds: 1
  },

  // Operacion 5 (Validar Credenciales Transaccional - Identity)
  identity: {
    defaultEnv: 'Testing', // 'Testing' | 'Produccion'
    Testing: {
      tokenUrl: 'https://YOUR_IDENTITY_TST_HOST/connect/token',
      clientId: '',
      clientSecret: '',
      scope: '',
      issuer: 'https://YOUR_IDENTITY_TST_HOST',
      apiSecret: ''
    },
    Produccion: {
      tokenUrl: 'https://YOUR_IDENTITY_PRD_HOST/connect/token',
      clientId: '',
      clientSecret: '',
      scope: '',
      issuer: 'https://YOUR_IDENTITY_PRD_HOST',
      apiSecret: ''
    }
  },

  // Operacion 6 (Validar Token Magento - Introspect)
  // scope = usuario del Basic, apiSecret = password del Basic.
  magento: {
    defaultEnv: 'Testing',
    Testing:    { issuer: 'https://YOUR_IDENTITY_TST_HOST', scope: '', apiSecret: '' },
    Produccion: { issuer: 'https://YOUR_IDENTITY_PRD_HOST', scope: '', apiSecret: '' }
  },

  // Credenciales B2B (Azure AD B2C ROPC + Auth/login)
  b2bCredentials: {
    defaultEnv: 'Testing',
    Testing: {
      tokenUrl: 'https://YOUR_TENANT.b2clogin.com/YOUR_TENANT.onmicrosoft.com/YOUR_ROPC_POLICY/oauth2/v2.0/token',
      clientId: '',
      clientSecret: '',
      scope: 'offline_access openid',
      loginUrl: 'https://YOUR_B2B_HOST/appConvenios/vX.Y.Z/api/Auth/login',
      username: '',
      password: ''
    },
    Produccion: {
      tokenUrl: 'https://YOUR_TENANT.b2clogin.com/YOUR_TENANT.onmicrosoft.com/YOUR_ROPC_POLICY/oauth2/v2.0/token',
      clientId: '',
      clientSecret: '',
      scope: 'offline_access openid',
      loginUrl: 'https://YOUR_B2B_HOST/appConvenios/vX.Y.Z/api/Auth/login',
      username: '',
      password: ''
    }
  },

  // Azure AD Graph (Usuarios B2C) - client_credentials -> Microsoft Graph.
  // extensionAppId = AppId (sin guiones) de la app que define las directory extensions.
  graphUsers: {
    defaultEnv: 'Testing',
    Testing: {
      tenantId: '',
      clientId: '',
      clientSecret: '',
      scope: 'https://graph.microsoft.com/.default',
      extensionAppId: ''
    },
    Produccion: {
      tenantId: '',
      clientId: '',
      clientSecret: '',
      scope: 'https://graph.microsoft.com/.default',
      extensionAppId: ''
    }
  },

  // Plexo (pasarela de pagos). La firma se hace con la clave privada del certificado
  // instalado en LocalMachine\My cuyo thumbprint es certificateThumbprint.
  plexo: {
    defaultEnv: 'Testing',
    Testing:    { certificateThumbprint: '', netId: '', baseUrl: '', commerceId: '' },
    Produccion: { certificateThumbprint: '', netId: '', baseUrl: '', commerceId: '' }
  },

  // Outlook (correos -> codigos) - Device Code Flow, public client (sin secreto).
  outlook: {
    clientId: '',            // Application (client) ID de la app registrada en Entra ID
    tenantId: 'common',      // Directory (tenant) ID, o 'common'
    senderTuPase: '',        // remitente a filtrar
    codePattern: '(?:c[oó]digo|code|pin)[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{2,15})',
    scopes: 'Mail.Read offline_access User.Read',
    maxEmails: 200
  },

  // Clave/IV AES-256-CBC (base64) para descifrar auth.clientSecretEncrypted.
  aes: {
    keyBase64: '',  // 32 bytes en base64
    ivBase64: ''    // 16 bytes en base64
  },

  // Auth (password flow) - usado por Operacion 1 cuando el token esta vencido
  auth: {
    clientId: '',
    clientSecretEncrypted: '',
    accessTokenUrl: 'https://YOUR_IDENTITY_PRD_HOST/connect/token',
    authority: 'https://YOUR_IDENTITY_PRD_HOST',
    username: '',
    password: '',
    scopes: 'openid profile'
  },

  // Generacion de Facturas. Connection string SQL Server + prefijo de factura.
  factura: {
    connectionString: 'Server=YOUR_SQL_SERVER;Database=YOUR_DB;User Id=YOUR_USER;Password=YOUR_PWD;TrustServerCertificate=True;',
    prefijoFactura: '211 A ',
    requestTimeoutMs: 30000
  },

  // Reportes recurrentes - connection string por ambiente.
  reportesRecurrentes: {
    identityServer: {
      defaultEnv: 'Testing',
      requestTimeoutMs: 30000,
      Testing:    { connectionString: '' },
      Produccion: { connectionString: '' }
    }
  }
};
