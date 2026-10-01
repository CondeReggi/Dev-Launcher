'use strict';

const { Jimp } = require('jimp');
const jsQR = require('jsqr');

async function decodeFromBuffer(buffer) {
  if (!buffer || !buffer.length) throw new Error('No se recibio ninguna imagen.');

  let image;
  try {
    image = await Jimp.fromBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  } catch (e) {
    throw new Error('No se pudo abrir la imagen: ' + e.message);
  }

  const { width, height, data } = image.bitmap;
  const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);

  let result = jsQR(clamped, width, height, { inversionAttempts: 'attemptBoth' });
  if (!result) {
    throw new Error('No se detecto ningun QR en la imagen. Probá con una imagen más nítida o sin recortes.');
  }

  return {
    text: result.data,
    width,
    height,
    location: result.location || null
  };
}

module.exports = { decodeFromBuffer };
