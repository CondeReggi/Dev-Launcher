'use strict';

const fs = require('fs');

function pathExists(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { pathExists };
