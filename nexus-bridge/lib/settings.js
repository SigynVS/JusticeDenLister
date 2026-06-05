'use strict';

const fs           = require('fs');
const EventEmitter = require('events');

const emitter  = new EventEmitter();
const DEFAULTS = { password: '', fileExpiry: 0, autoStart: false };
let _path = '';
let data  = { ...DEFAULTS };

function init(settingsPath) {
  _path = settingsPath;
  try {
    if (fs.existsSync(_path))
      data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(_path, 'utf8')) };
  } catch { data = { ...DEFAULTS }; }
}

function get() { return { ...data }; }

function set(updates) {
  Object.assign(data, updates);
  if (_path) {
    try { fs.writeFileSync(_path, JSON.stringify(data, null, 2)); } catch {}
  }
  emitter.emit('change', { ...data });
}

function onChange(cb) { emitter.on('change', cb); }

module.exports = { init, get, set, onChange };
