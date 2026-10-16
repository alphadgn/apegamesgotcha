// Compiles Solidity in the browser, off the main thread (Admin → Treasury → Deploy).
// The compiler is the official solc-js build v0.8.24+commit.e11b9ed9 (soljson from the `solc` npm package,
// served from this site so the exact version is always the one used). Message in: { id, input } (standard JSON
// input); message out: { id, version, output } or { id, error }.
/* eslint-disable */
var compile = null;
var version = null;
function load() {
  if (compile) return;
  importScripts("./soljson-v0.8.24+commit.e11b9ed9.js");
  version = Module.cwrap("solidity_version", "string", [])();
  compile = Module.cwrap("solidity_compile", "string", ["string", "number", "number"]);
}
self.onmessage = function (e) {
  var id = e.data && e.data.id;
  try {
    load();
    var out = compile(JSON.stringify(e.data.input), 0, 0);
    self.postMessage({ id: id, version: version, output: JSON.parse(out) });
  } catch (err) {
    self.postMessage({ id: id, error: String((err && err.message) || err) });
  }
};
