import {AsyncEmbeddedProcess} from './async-process';
import {CompilePathRequest} from './CompilePathRequest';
import {ImporterRegistry} from './importer-registry';
import {SyncEmbeddedProcess} from './sync-process';
import {CompilerType, IEmbeddedProcess} from './types/compiler';
import {CompileResult, Options} from './vendor/sass';
import * as proto from './vendor/embedded-protocol/embedded_sass_pb';
import * as supportsColor from 'supports-color';

export default class Compiler<T extends CompilerType> {
  public process: IEmbeddedProcess;

  constructor(compilerType: T) {
    switch (compilerType) {
      case CompilerType.ASYNC:
        this.process = new AsyncEmbeddedProcess();
        break;
      case CompilerType.SYNC:
        this.process = new SyncEmbeddedProcess();
        break;
      default:
        throw new Error(`Unknown compiler type: ${compilerType}`);
    }
  }

  compile(path: string, options?: Options<CompilerType.SYNC>): CompileResult {
    const importers = new ImporterRegistry(options);
    return compileRequestSync(
      new CompilePathRequest(path, importers, options),
      importers,
      options
    );
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
