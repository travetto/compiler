import * as fs from 'fs';
import * as ts from 'typescript';
import * as sourcemap from 'source-map-support';
import * as path from 'path';
import { EventEmitter } from 'events';

import { bulkRequire, bulkFindSync, AppEnv, AppInfo, Watcher, Entry } from '@travetto/base';
import { RetargettingHandler } from './proxy';

const Module = require('module');
const stringHash = require('string-hash');

const originalLoader = Module._load.bind(Module);

function toJsName(name: string) {
  return name.replace(/\.ts$/, '.js');
}

type WatchEvent = 'required-after' | 'added' | 'changed' | 'removed';

export class Compiler {

  static configFile = 'tsconfig.json';
  static sourceMaps = new Map<string, { url: string, map: string, content: string }>();
  static files = new Map<string, { version: number }>();
  static contents = new Map<string, string>();
  static cwd: string;
  static options: ts.CompilerOptions;
  static transformers: ts.CustomTransformers;
  static registry: ts.DocumentRegistry;
  static modules = new Map<string, { module?: any, proxy?: any, handler?: RetargettingHandler<any> }>();
  static rootFiles: string[];
  static fileWatchers: { [key: string]: Watcher } = {};
  static events = new EventEmitter();
  static snaphost = new Map<string, ts.IScriptSnapshot | undefined>()
  static hashes = new Map<string, number>();

  static emptyRequire = 'module.exports = {}';

  static libraryPath = 'node_modules';
  static transformerPattern = /^.*\/transformer.*[.]ts$/;

  static devDependencyFiles = AppInfo.DEV_PACKAGES && AppInfo.DEV_PACKAGES.length ?
    [new RegExp(`${Compiler.libraryPath}/(${AppInfo.DEV_PACKAGES.join('|')})/`)] : [];

  static invalidWorkingSetFiles = [
    /\.d\.ts$/g, // Definition files
    Compiler.transformerPattern,
    ...Compiler.devDependencyFiles
  ];

  static invalidWorkingSetFile(name: string) {
    for (const re of this.invalidWorkingSetFiles) {
      if (re.test(name)) {
        return true;
      }
    }
    return false;
  }

  static handleLoadError(p: string, e?: any): boolean {
    if (!AppEnv.prod) { // If attempting to load an optional require
      console.error(`Unable to import ${p}, stubbing out`, e);
      return true;
    } else {
      if (e) {
        throw e;
      } else {
        return false;
      }
    }
  }

  static resolveOptions(name = this.configFile) {
    const out = ts.parseJsonSourceFileConfigFileContent(
      ts.readJsonConfigFile(`${this.cwd}/${this.configFile}`, ts.sys.readFile), ts.sys, this.cwd, {
        rootDir: `${this.cwd}`,
        sourceMap: false,
        inlineSourceMap: true,
        outDir: `${this.cwd}`
      }, `${this.cwd}/${this.configFile}`
    );
    out.options.importHelpers = true;
    out.options.noEmitOnError = AppEnv.prod;
    out.options.moduleResolution = ts.ModuleResolutionKind.NodeJs;

    return out;
  }

  static resolveTransformers() {
    const transformers: { [key: string]: any } = {};
    let i = 2;

    for (const trns of bulkRequire([this.transformerPattern], this.cwd)) {
      for (const key of Object.keys(trns)) {
        const item = trns[key];
        if (!transformers[item.phase]) {
          transformers[item.phase] = [];
        }
        item.priority = item.priority === undefined ? ++i : item.priority;
        item.name = item.name || key;
        transformers[item.phase].push(item);
      }
    }
    for (const key of Object.keys(transformers)) {
      transformers[key] = (transformers[key] as any[]).sort((a, b) => a.priority - b.priority).map(x => x.transformer);
    }
    return transformers;
  }

  static moduleLoadHandler(request: string, parent: string) {

    let mod;
    try {
      mod = originalLoader.apply(null, arguments);
    } catch (e) {
      const p = Module._resolveFilename(request, parent);
      this.handleLoadError(p, e);
      mod = {};
    }

    let out = mod;

    // Proxy modules, if in watch mode for non node_modules paths
    if (AppEnv.watch) {
      const p = Module._resolveFilename(request, parent);
      if (p.includes(this.cwd) && !p.includes(this.libraryPath)) {
        if (!this.modules.has(p)) {
          const handler = new RetargettingHandler(mod);
          out = new Proxy({}, handler);
          this.modules.set(p, { module: out, handler });
        } else {
          const conf = this.modules.get(p)!;
          conf.handler!.target = mod;
          out = conf.module!;
        }
      }
    }

    return out;
  }

  static time = 0;

  static requireHandler(m: NodeModule, tsf: string) {

    const jsf = toJsName(tsf);

    let content: string;

    const isNew = !this.contents.has(jsf);

    if (isNew) {
      if (AppEnv.watch) {
        const topLevel = tsf.split(`${this.cwd}/`)[1].split('/')[0];
        if (this.fileWatchers[topLevel]) {
          this.fileWatchers[topLevel].add([tsf]);
        }
      }
      // Picking up missed files
      this.rootFiles.push(tsf);
      this.files.set(tsf, { version: 0 });
      this.emitFile(tsf);
    }

    content = this.contents.get(jsf)!;

    if (/\/test\//.test(tsf) && !tsf.includes('node_modules')) {
      console.debug(content);
    }

    try {
      const ret = (m as any)._compile(content, jsf);
      if (isNew) {
        this.events.emit('required-after', tsf);
      }
      return ret;
    } catch (e) {
      this.handleLoadError(tsf, e);
      this.contents.set(jsf, content = this.emptyRequire);
      (m as any)._compile(content, jsf);
    }
  }

  static prepareSourceMaps() {
    sourcemap.install({
      emptyCacheBetweenOperations: AppEnv.test || AppEnv.debug,
      retrieveFile: (p: string) => this.contents.get(p)!,
      retrieveSourceMap: (source: string) => this.sourceMaps.get(source)!
    });
  }

  static markForReload(files: string[] | string) {
    if (!Array.isArray(files)) {
      files = [files];
    }
    for (const fileName of files) {
      this.unload(fileName);
      // Do not automatically reload
    }
  }

  static unload(fileName: string) {
    console.debug('Unloading', fileName);
    if (this.snaphost.has(fileName)) {
      this.snaphost.delete(fileName);
    }
    if (fileName in require.cache) {
      delete require.cache[fileName];
    }
    if (this.hashes.has(fileName)) {
      this.hashes.delete(fileName);
    }
    if (this.modules.has(fileName)) {
      this.modules.get(fileName)!.handler!.target = null;
    }
  }

  static emitFile(fileName: string) {
    console.debug('Emitting', fileName);
    const content = ts.sys.readFile(fileName)!;

    if (AppEnv.watch && this.hashes.has(fileName)) {
      // Let's see if they are really different
      const hash = stringHash(content);
      if (hash === this.hashes.get(fileName)) {
        console.debug(`Contents Unchanged: ${fileName}`);
        return false;
      }
    }

    const res = this.transpile(content, fileName);
    let output = res.outputText;

    const outFileName = toJsName(fileName);

    if (this.logErrors(fileName, res.diagnostics)) {
      console.debug(`Compiling ${fileName} failed`);
      if (this.handleLoadError(fileName)) {
        output = this.emptyRequire;
      }
    }
    this.contents.set(outFileName, output);

    if (AppEnv.watch) {
      this.hashes.set(fileName, stringHash(content));
      // If file is already loaded, mark for reload
      if (this.files.get(fileName)!.version > 0) {
        this.markForReload(fileName);
      }
    }

    return true;
  }

  private static watcherListener({ event, entry }: { event: string, entry: Entry }) {
    if (this.invalidWorkingSetFile(entry.file)) {
      return;
    }

    console.log('Watch', event, entry.file);

    if (event === 'added') {
      this.rootFiles.push(entry.file);
      this.files.set(entry.file, { version: 1 });
      if (this.emitFile(entry.file)) {
        this.events.emit(event, entry.file);
      }
    } else if (event === 'changed') {
      const changed = this.files.has(entry.file);
      if (changed) {
        this.snaphost.delete(entry.file);
        this.files.get(entry.file)!.version++;
      } else {
        this.files.set(entry.file, { version: 1 });
        this.rootFiles.push(entry.file);
      }
      if (this.emitFile(entry.file)) {
        this.events.emit(changed ? 'changed' : 'added', entry.file);
      }
    } else if (event === 'removed') {
      this.unload(entry.file);
      this.events.emit(event, entry.file);
    }
  }

  static buildWatcher(tld: string) {
    const watcher = new Watcher({
      interval: 250,
      cwd: `${this.cwd}/${tld}`
    });

    watcher.on('all', this.watcherListener.bind(this))

    watcher.add([/.*[.]ts$/]); // Watch ts files
    watcher.run(false);
    return watcher;
  }

  static watchFiles() {
    const ret = { src: this.buildWatcher('src') };
    return ret;
  }

  static logErrors(fileName: string, diagnostics?: ts.Diagnostic[]) {
    if (!diagnostics || !diagnostics.length) {
      return false;
    }

    for (const diagnostic of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (diagnostic.file) {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start as number);
        console.error(`  Error ${diagnostic.file.fileName}(${line + 1}, ${character + 1}): ${message}`);
      } else {
        console.error(`  Error: ${message}`);
      }
    }

    return diagnostics.length !== 0;
  }

  static transpile(input: string, fileName: string) {
    // console.debug('Transpiling', fileName);
    const output = ts.transpileModule(input, {
      compilerOptions: this.options,
      fileName,
      reportDiagnostics: true,
      transformers: this.transformers
    });
    return output;
  }

  static getSnapshot(fileName: string) {
    if (!this.snaphost.has(fileName)) {
      const snap = fs.existsSync(fileName) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName)!) : undefined
      this.snaphost.set(fileName, snap);
    }
    return this.snaphost.get(fileName);
  }

  static init(cwd: string) {
    if (!this.options) {
      this.cwd = cwd;
      this.prepareSourceMaps();
      const out = this.resolveOptions();
      this.options = out.options;

      this.transformers = this.resolveTransformers();
      require.extensions['.ts'] = this.requireHandler.bind(this);
      Module._load = this.moduleLoadHandler.bind(this);
    }

    this.initFiles();
  }

  static initFiles() {
    if (this.rootFiles) {
      return;
    }
    const start = Date.now();

    this.rootFiles = bulkFindSync([/[^\/]+\/src\/.*[.]ts$/], `${this.cwd}/${Compiler.libraryPath}/@travetto`)
      .concat(bulkFindSync([/.ts/], `${this.cwd}/src`))
      .filter(x => !x.stats.isDirectory() && !this.invalidWorkingSetFile(x.file))
      .map(x => x.file);

    console.debug('Files', this.rootFiles.length);

    // Prime for type checker
    for (const fileName of this.rootFiles) {
      this.files.set(fileName, { version: 0 });
      this.emitFile(fileName);
    }

    // Now let's watch the files
    if (AppEnv.watch) {
      this.fileWatchers = this.watchFiles();
    }

    console.debug('Initialized', (Date.now() - start) / 1000);
  }

  static resetFiles() {
    if (AppEnv.watch) {
      Object.values(this.fileWatchers).map(x => x.close());
      this.fileWatchers = {};
    }
    this.contents.clear();
    this.modules.clear();
    this.files.clear();
    this.hashes.clear();
    this.sourceMaps.clear();
    this.snaphost.clear();
    delete this.rootFiles;

    this.initFiles();
  }

  static on(event: WatchEvent, callback: (filename: string) => any) {
    this.events.addListener(event, callback);
  }

  static off(event: WatchEvent, callback: (filename: string) => any) {
    this.events.removeListener(event, callback);
  }
}

// Handle passing of method
Compiler.invalidWorkingSetFile = Compiler.invalidWorkingSetFile.bind(Compiler);