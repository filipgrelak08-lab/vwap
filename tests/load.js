/* Loads the browser modules into the node test context. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['web/js/format.js', 'web/js/metrics.js', 'web/js/strategy.js', 'web/js/pine.js'];

let loaded = false;
function load() {
  if (!loaded) {
    for (const file of FILES) {
      vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
    }
    loaded = true;
  }
  return globalThis.BT;
}

/** Every strategy shipped in strategies/, as { id, code }. */
function strategyFiles() {
  const dir = path.join(ROOT, 'strategies');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => ({ id: f.replace(/\.js$/, ''), code: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

module.exports = { load, strategyFiles, ROOT };
