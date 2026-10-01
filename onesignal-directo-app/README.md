# OneSignal Directo

App de escritorio standalone (Electron) que replica **exactamente** la
seccion "OneSignal (directo)" de Dev Launcher, para poder compartirla con el
equipo como un `.exe` suelto sin necesidad de instalar/correr todo el
Dev Launcher completo.

Habla directo contra la API REST de OneSignal (no depende de SQL Server ni de
ningun otro sistema de DUCSA): lista subscriptions (`GET /players`, con
fallback a CSV export para apps grandes), y permite enviar notificaciones en
tres modos (masivo por segmento, lista seleccionada por bloques con throttle
propio, o puntual por id), siempre mostrando un preview con el `curl` y el
body exacto antes de confirmar.

## Credenciales: embebidas

A diferencia de Dev Launcher (donde cada dev configura su propio
`sendQr.config.js` local), esta app esta pensada para que **todo el equipo
use las mismas credenciales de OneSignal**. Por eso `src/config/oneSignal.config.js`
(gitignored, NUNCA se commitea) se empaqueta directo dentro del `.exe` cuando
se corre `npm run dist` — nadie tiene que configurar nada al abrir la app.

Si todavia no existe ese archivo en tu copia del repo, copia el template y
completalo con las credenciales reales antes de buildear:

```bash
cp src/config/oneSignal.config.example.js src/config/oneSignal.config.js
# editar src/config/oneSignal.config.js con el appId / apiRestKey reales
```

⚠️ **Importante sobre este modelo**: el `.exe` generado contiene la REST API
Key de OneSignal en texto plano (se puede extraer del `app.asar` sin mucho
esfuerzo). Es la key de **produccion**, con permisos para listar y mandar
push a los ~158k dispositivos registrados. Compartila solo dentro del equipo
de confianza, por un canal privado (no un repositorio publico, no un share
abierto). Si en algun momento se filtra, hay que rotarla desde el dashboard
de OneSignal y regenerar el `.exe`.

## Desarrollo

```bash
npm install
npm start        # correr la app
npm run dev      # correr con DevTools
```

## Generar el .exe para compartir

```bash
npm install
npm run dist
```

Genera un `.exe` portable (sin instalador) en `dist/OneSignalDirecto-<version>.exe`,
con las credenciales ya embebidas. Se puede copiar y correr directo en
cualquier PC Windows del equipo, sin instalar Node, Electron, ni configurar
nada.
