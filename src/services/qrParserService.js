'use strict';

/**
 * Parses a DGI/SUCIVE-style QR string used by the B2B BO ValidarQr flow.
 *
 * Format observed:
 *   <header_fields_separated_by_;>|<line1_fields_separated_by_;>|<line2_...>
 *
 * Header order is inferred from the order in which `ValidarQr` reads `qrDatos.*`.
 * Line order is inferred from the example string the user supplied. The C# class
 * `QrDatos` is the source of truth — if a real card disagrees, edit HEADER_FIELDS
 * / LINE_FIELDS arrays below.
 */

const HEADER_FIELDS = [
  { key: 'Serie',                 validated: 'Serie',                                          type: 'string',                  note: '' },
  { key: 'Numero',                validated: 'Numero',                                         type: 'string',                  note: '' },
  { key: 'Version',               validated: 'Version',                                        type: 'integer',                 note: 'ConvertAndValidateInteger' },
  { key: 'NroUnicoSg',            validated: 'NumeroUnicoSG',                                  type: 'string',                  note: 'Clave para deduplicar OrdenPago' },
  { key: 'Hash',                  validated: '(usado por _ordersService.ValidarHash)',         type: 'string',                  note: 'Solo se valida si IsHashEnabled()' },
  { key: 'RutEmisor',             validated: 'RutEmisor',                                      type: 'string',                  note: 'ValidateRut() salvo si esFacturado' },
  { key: 'SucursalDgi',           validated: 'SucursalDgi',                                    type: 'integer',                 note: 'ConvertAndValidateInteger' },
  { key: 'TipoCfe',               validated: 'TipoCfe',                                        type: 'string',                  note: 'p.ej. 101 (e-Ticket)' },
  { key: 'FechaEmision',          validated: 'FechaHoraEmision (combinado)',                   type: 'date yyyyMMdd',           note: 'Combinada con HoraEmision via ValidateFechaEmision' },
  { key: 'HoraEmision',           validated: 'FechaHoraEmision (combinado)',                   type: 'time HHmm',               note: 'Combinada con FechaEmision' },
  { key: 'TipoDocumentoReceptor', validated: 'TipoDocumentoReceptor',                          type: 'string',                  note: '' },
  { key: 'DocumentoReceptor',     validated: 'DocumentoReceptor',                              type: 'string',                  note: 'Puede venir vacío' },
  { key: 'TipoMoneda',            validated: 'TipoMoneda',                                     type: 'string',                  note: 'Lookup en _context.Moneda' },
  { key: 'MontoNoGravado',        validated: 'MontoNoGravado',                                 type: 'decimal',                 note: 'ConvertAndValidateDecimal' },
  { key: 'MontoNetoIvaTasaBasica',validated: 'MontoNetoIvaTasaBasica',                         type: 'decimal',                 note: '' },
  { key: 'MontoNetoIvaTasaMinima',validated: 'MontoNetoIvaTasaMinima',                         type: 'decimal',                 note: '' },
  { key: 'IvaTasaBasica',         validated: 'IvaTasaBasica',                                  type: 'decimal (tasa %)',        note: 'p.ej. 22' },
  { key: 'IvaTasaMinima',         validated: 'IvaTasaMinima',                                  type: 'decimal (tasa %)',        note: 'p.ej. 10' },
  { key: 'MontoIvaTasaBasica',    validated: 'MontoIvaTasaBasica',                             type: 'decimal',                 note: '' },
  { key: 'MontoIvaTasaMinima',    validated: 'MontoIvaTasaMinima',                             type: 'decimal',                 note: '' },
  { key: 'MontoTotal',            validated: 'MontoTotal',                                     type: 'decimal',                 note: 'ImporteSinDescuento = MontoTotal' },
  { key: 'NumeroPistero',         validated: 'Pistero.NroFuncionario',                         type: 'string',                  note: 'Resuelto contra Pistero (crea/actualiza)' },
  { key: 'NombrePistero',         validated: 'Pistero.NombreCompleto',                         type: 'string',                  note: '' },
  { key: 'Pista',                 validated: 'Pista / TipoArancel',                            type: 'string (TRUE|SI|FALSE)',  note: 'TRUE/SI -> COMB; otro -> TIEN' }
];

const LINE_FIELDS = [
  { key: 'FechaHoraDespacho',        validated: 'FechaHoraDespacho',                              type: 'datetime yyyyMMddHHmm',   note: 'ValidateFechaDespacho' },
  { key: 'CodigoProducto',           validated: 'CodigoSistemaGestion + lookup en ProductoMap',   type: 'string',                  note: 'Si no matchea, se usa Producto con ProductoId=0' },
  { key: 'Cantidad',                 validated: 'Cantidad',                                       type: 'decimal',                 note: 'p.ej. litros' },
  { key: 'TotalConImpuestos',        validated: 'TotalConImpuestos',                              type: 'decimal',                 note: 'Suma se compara con MontoTotal' },
  { key: 'DespachoIdSistemaGestion', validated: 'DespachoIdSistemaGestion (y fallback DespachoId)',type: 'integer',                note: '' },
  { key: 'IndFact',                  validated: 'IndFact',                                        type: 'integer',                 note: 'Indicador de Facturacion' },
  { key: 'Manguera',                 validated: 'Manguera',                                       type: 'integer',                 note: '' },
  { key: 'Precio',                   validated: 'Precio',                                         type: 'decimal',                 note: 'Precio unitario' }
];

function trimQrText(raw) {
  if (typeof raw !== 'string') throw new Error('Se esperaba un string.');
  return raw.replace(/^\s+|\s+$/g, '');
}

function splitHeaderAndLines(raw) {
  const text = trimQrText(raw);
  if (!text) throw new Error('El QR esta vacio.');
  const segments = text.split('|');
  const header = segments[0].split(';');
  const rawLines = segments.slice(1).filter(s => s.length > 0).map(s => s.split(';'));
  return { header, rawLines };
}

function mapToObject(values, schema, label) {
  const obj = {};
  const annotated = [];

  schema.forEach((field, idx) => {
    const value = idx < values.length ? values[idx] : null;
    obj[field.key] = value;
    annotated.push({
      pos: idx,
      qrDatosKey: field.key,
      validatedKey: field.validated,
      type: field.type,
      rawValue: value,
      note: field.note
    });
  });

  // Extra values beyond the known schema
  for (let i = schema.length; i < values.length; i++) {
    const k = `Unknown_${i}`;
    obj[k] = values[i];
    annotated.push({
      pos: i,
      qrDatosKey: k,
      validatedKey: '(?)',
      type: '(?)',
      rawValue: values[i],
      note: `${label}: posicion fuera del esquema conocido`
    });
  }

  return { obj, annotated };
}

function parseQr(raw) {
  const { header, rawLines } = splitHeaderAndLines(raw);

  const headerMap = mapToObject(header, HEADER_FIELDS, 'Header');
  const lineas = rawLines.map((vals, i) => {
    const m = mapToObject(vals, LINE_FIELDS, `Linea ${i}`);
    return { obj: m.obj, annotated: m.annotated };
  });

  // Compute derived TipoArancel just to mirror ValidarQr
  const pistaUpper = (headerMap.obj.Pista || '').toUpperCase();
  const tipoArancel = (pistaUpper === 'TRUE' || pistaUpper === 'SI') ? 'COMB' : 'TIEN';

  return {
    qrDatos: {
      ...headerMap.obj,
      Lineas: lineas.map(l => l.obj)
    },
    derived: {
      TipoArancel: tipoArancel,
      FechaHoraEmisionCombinada: `${headerMap.obj.FechaEmision || ''} ${headerMap.obj.HoraEmision || ''}`.trim()
    },
    annotated: {
      header: headerMap.annotated,
      lineas: lineas.map(l => l.annotated)
    },
    raw: {
      headerCount: header.length,
      lineCount: rawLines.length,
      headerSchemaCount: HEADER_FIELDS.length,
      lineSchemaCount: LINE_FIELDS.length
    }
  };
}

module.exports = { parseQr, HEADER_FIELDS, LINE_FIELDS };
