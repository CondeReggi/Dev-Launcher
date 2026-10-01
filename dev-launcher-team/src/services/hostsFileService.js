'use strict';

/**
 * Editor linea por linea del archivo hosts de Windows.
 *
 * Cada linea no vacia se parsea como { enabled, ip, rest }: `enabled` es false si la linea
 * arranca con "#", `ip` es el primer token y `rest` es el resto de la linea (otros hostnames
 * y/o comentario inline). Deshabilitar antepone "#"; eliminar saca la linea; agregar hace push.
 * Las lineas en blanco del archivo no se muestran ni se preservan al guardar.
 *
 * Escribir requiere permisos de administrador (el archivo vive en System32\drivers\etc): se
 * asume que quien llama ya valido `elevation.isElevated()` antes de invocar las funciones de
 * mutacion, igual que el resto de operaciones que requieren admin en la app.
 */

const fs = require('fs');
const path = require('path');

const HOSTS_PATH = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');

function parseLine(rawLine, index) {
  const trimmedFull = rawLine.replace(/\r$/, '').trim();
  if (!trimmedFull) return null;

  const enabled = !trimmedFull.startsWith('#');
  const content = enabled ? trimmedFull : trimmedFull.replace(/^#+\s*/, '');

  const m = content.match(/^(\S+)(?:\s+(.*))?$/);
  const ip = m ? m[1] : '';
  const rest = m && m[2] ? m[2].trim() : '';

  return { index, enabled, ip, rest };
}

function readEntries() {
  let content;
  try { content = fs.readFileSync(HOSTS_PATH, 'utf8'); }
  catch (e) { throw new Error(`No se pudo leer el archivo hosts: ${e.message}`); }

  const entries = [];
  content.split('\n').forEach((raw, i) => {
    const entry = parseLine(raw, i);
    if (entry) entries.push(entry);
  });
  return entries;
}

function getState() {
  return { path: HOSTS_PATH, entries: readEntries() };
}

function serializeEntry(e) {
  const body = e.rest ? `${e.ip}  ${e.rest}` : e.ip;
  return e.enabled ? body : `# ${body}`;
}

function writeEntries(entries) {
  const content = entries.map(serializeEntry).join('\r\n') + '\r\n';
  try { fs.writeFileSync(HOSTS_PATH, content, 'utf8'); }
  catch (e) { throw new Error(`No se pudo escribir el archivo hosts: ${e.message}`); }
}

function findOrThrow(entries, index) {
  const found = entries.find((e) => e.index === index);
  if (!found) throw new Error('La linea ya no existe (el archivo cambio, recarga la lista).');
  return found;
}

function addEntry({ ip, rest, enabled }) {
  const cleanIp = String(ip || '').trim();
  if (!cleanIp) throw new Error('Ingresa al menos una IP / host.');

  const entries = readEntries();
  entries.push({ ip: cleanIp, rest: String(rest || '').trim(), enabled: enabled !== false });
  writeEntries(entries);
  return getState();
}

function setEnabled(index, enabled) {
  const entries = readEntries();
  findOrThrow(entries, index).enabled = !!enabled;
  writeEntries(entries);
  return getState();
}

function updateEntry(index, patch) {
  const entries = readEntries();
  const found = findOrThrow(entries, index);
  if (patch.ip !== undefined) {
    const cleanIp = String(patch.ip).trim();
    if (!cleanIp) throw new Error('La IP / host no puede quedar vacia.');
    found.ip = cleanIp;
  }
  if (patch.rest !== undefined) found.rest = String(patch.rest).trim();
  writeEntries(entries);
  return getState();
}

function removeEntry(index) {
  const entries = readEntries().filter((e) => e.index !== index);
  writeEntries(entries);
  return getState();
}

module.exports = { HOSTS_PATH, getState, addEntry, setEnabled, updateEntry, removeEntry };
