'use strict';

/**
 * Mirrors LeerColumnaDeExcel / LeerUsuariosDeExcel / LeerContenidoArchivo from
 * SendQrRequest\Utilities\FileFunctions.cs.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/**
 * Reads a single column from the first worksheet, skipping the header row.
 * Mirrors LeerColumnaDeExcel: skips the first non-empty cell in the column,
 * and returns the rest as strings (trimmed, non-empty).
 */
function readColumn(filePath, columnLetter) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Archivo no encontrado: ${filePath}`);
  }
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) return [];

  const range = XLSX.utils.decode_range(ws['!ref']);
  const colIdx = XLSX.utils.decode_col(columnLetter);

  const out = [];
  let skippedFirst = false;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cellRef = XLSX.utils.encode_cell({ c: colIdx, r });
    const cell = ws[cellRef];
    if (!cell || cell.v == null) continue;
    const val = String(cell.v).trim();
    if (!val.length) continue;
    if (!skippedFirst) { skippedFirst = true; continue; }
    out.push(val);
  }
  return out;
}

/**
 * Reads users from a worksheet. Tries 'Hoja1' first, falls back to first sheet.
 * Expects columns: Documento, Nombre, Apellido, Mail. Skips rows with empty Mail.
 */
function readUsuarios(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Archivo no encontrado: ${filePath}`);
  }
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Hoja1'] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  return rows
    .map(r => ({
      Documento: String(r.Documento ?? '').trim(),
      Nombre:    String(r.Nombre    ?? '').trim(),
      Apellido:  String(r.Apellido  ?? '').trim(),
      Mail:      String(r.Mail      ?? '').trim()
    }))
    .filter(u => u.Mail.length > 0);
}

/**
 * Reads a .txt file (UTF-8). For .docx the original C# reads docx body text;
 * not implementing here unless needed.
 */
function readTextFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Archivo no encontrado: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.txt') {
    throw new Error(`Tipo de archivo no soportado: ${ext}. Esperado .txt`);
  }
  return fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
}

module.exports = { readColumn, readUsuarios, readTextFile };
