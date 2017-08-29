const fs = require('fs');
const ts = require('typescript');

require.extensions['.ts'] = function load(m, tsf) {
  const jsf = tsf.replace(/\.ts$/, '.js');
  const output = ts.transpileModule(fs.readFileSync(tsf, 'utf-8'), { fileName: jsf, reportDiagnostics: true });
  ts.addRange(undefined, output.diagnostics);
  return m._compile(output.outputText, jsf);
};

require('./compiler.ts')