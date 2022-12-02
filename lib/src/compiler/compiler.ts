import { AsyncEmbeddedProcess } from '../async-process';
import { ImporterRegistry } from '../importer-registry';
import { SyncEmbeddedProcess } from '../sync-process';
import { CompilerType, IEmbeddedProcess } from '../types/compiler';
import { CompileResult, Options } from '../vendor/sass';
import * as proto from '../vendor/embedded-protocol/embedded_sass_pb';
import * as supportsColor from 'supports-color';
import { Compilation } from './Compilation';

export class Compiler<T extends CompilerType> {
  public process: IEmbeddedProcess;
  compilerType: CompilerType;

  constructor(compilerType: T) {
    switch (compilerType) {
      case CompilerType.ASYNC:
        this.compilerType = compilerType;
        this.process = new AsyncEmbeddedProcess();
        break;
      case CompilerType.SYNC:
        this.compilerType = compilerType;
        this.process = new SyncEmbeddedProcess();
        break;
      default:
        throw new Error(`Unknown compiler type: ${compilerType}`);
    }
  }

  compile(path: string, options?: Options<T>): CompileResult {
    const importers = new ImporterRegistry(options);
    const compileRequest = this.newCompileRequest(importers, options);
    compileRequest.setPath(path);

    const compilation = new Compilation(this.compilerType, compileRequest, importers, options);

    return compilation.compileResult!;
  }

  newCompileRequest(
    importers: ImporterRegistry<CompilerType>,
    options?: Options<CompilerType>
  ): proto.InboundMessage.CompileRequest {
    const request = new proto.InboundMessage.CompileRequest();
    request.setImportersList(importers.importers);
    request.setGlobalFunctionsList(Object.keys(options?.functions ?? {}));
    request.setSourceMap(!!options?.sourceMap);
    request.setSourceMapIncludeSources(!!options?.sourceMapIncludeSources);
    request.setAlertColor(options?.alertColor ?? !!supportsColor.stdout);
    request.setAlertAscii(!!options?.alertAscii);
    request.setQuietDeps(!!options?.quietDeps);
    request.setVerbose(!!options?.verbose);

    switch (options?.style ?? 'expanded') {
      case 'expanded':
        request.setStyle(proto.OutputStyle.EXPANDED);
        break;

      case 'compressed':
        request.setStyle(proto.OutputStyle.COMPRESSED);
        break;

      default:
        throw new Error(`Unknown options.style: "${options?.style}"`);
    }

    return request;
  }

  dispose() {
    this.process.close();
  }
}
