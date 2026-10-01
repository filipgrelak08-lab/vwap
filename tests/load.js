// Loads the browser scripts into a Node sandbox so tests can use window.BT.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['format.js', 'indicators.js', 'metrics.js', 'engine.js', 'data.js', 'optimizer.js'];

function loadBT() {
  const sandbox = { console, Math, Date, Number, String, Array, Object, Error, JSON, URLSearchParams, setTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) {
    const file = path.join(__dirname, '..', 'web', 'js', f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  return sandbox.BT;
}

function readStrategy(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'strategies', name), 'utf8');
}

function listStrategies() {
  return fs.readdirSync(path.join(__dirname, '..', 'strategies')).filter((f) => f.endsWith('.js')).sort();
}

module.exports = { loadBT, readStrategy, listStrategies };
