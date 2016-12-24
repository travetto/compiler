let sourcemap = require('source-map-support');
let fs = require('fs');
let path = require('path');
let ts = require('typescript');
let cwd = process.cwd();
let tsOptions = getOptions(path.join(cwd, 'tsconfig.json'));

let dataUriRe = /data:application\/json[^,]+base64,/;
let sourceMaps = {};

sourcemap.install({ retrieveSourceMap: (path) => sourceMaps[path] });

function getOptions(tsconfigFile) {
  let o = require(tsconfigFile).compilerOptions;
  o.target = ts.ScriptTarget[o.target.toUpperCase()];
  o.module = ts.ModuleKind[o.module == 'commonjs' ? 'CommonJS' : o.module.toUpperCase()];
  o.inlineSourceMap = o.sourceMap;
  return o;
}

// Wrap sourcemap tool
let prep = Error.prepareStackTrace;
Error.prepareStackTrace = function (a, stack) {
  let res = prep(a, stack);
  let parts = res.split('\n');
  return [parts[0], ...parts.slice(1)
    .filter(l =>
      l.indexOf('require-ts.js') < 0 &&
      l.indexOf('source-map-support.js') < 0 &&
      (l.indexOf('node_modules') > 0 ||
        (l.indexOf('(native)') < 0 && (l.indexOf(cwd) < 0 || l.indexOf('.js') < 0))))
  ].join('\n');
}

require.extensions['.ts'] = function load(m, tsf) {
  let jsf = tsf.replace(/\.ts$/, '.js');
  let parts = tsf.split('/');
  let name = parts.pop();
  let folder = parts.pop();
  let content = ts.transpile(fs.readFileSync(tsf, 'utf-8'), tsOptions, `${folder}/${name}`);
  let map = new Buffer(content.split(dataUriRe)[1], 'base64').toString()
  sourceMaps[jsf] = { content, url: tsf, map };
  return m._compile(content, jsf);
};