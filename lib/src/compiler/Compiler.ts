import * as p from 'path';
import { AsyncEmbeddedProcess } from '../async-process';
import { ImporterRegistry } from '../importer-registry';
import { SyncEmbeddedProcess } from '../sync-process';
import { CompileResult, Options, StringOptions } from '../vendor/sass';
import * as proto from '../vendor/embedded-protocol/embedded_sass_pb';
import * as supportsColor from 'supports-color';
import * as utils from '../utils'
import { Compilation } from './Compilation';
import { legacyImporterProtocol } from '../legacy/importer';
import { Observable, Subject } from 'rxjs';

export class Compiler<T extends CompilerType> {
  public compiler: IEmbeddedProcess;
  compilerType: CompilerType;

  constructor(compilerType: T) {
    switch (compilerType) {
      case CompilerType.ASYNC:
        this.compilerType = compilerType;
        this.compiler = new AsyncEmbeddedProcess();
        break;
      case CompilerType.SYNC:
        this.compilerType = compilerType;
        this.compiler = new SyncEmbeddedProcess();
        break;
      default:
        throw new Error(`Unknown compiler type: ${compilerType}`);
    }
  }

  compile(path: string, options?: Options<T>): CompileResult {
    const importers = new ImporterRegistry(options);
    const compileRequest = this.newCompileRequest(importers, options);
    compileRequest.setPath(path);

    const compilation = new Compilation(this.compilerType, this.compiler, compileRequest, importers, options);

    return compilation.compileResult!;
  }

  compileString(source: string, options?: Options<T>): CompileResult {
    const importers = new ImporterRegistry(options);
    const compileRequest = this.newCompileStringRequest(source, importers, options);

    const compilation = new Compilation(this.compilerType, this.compiler, compileRequest, importers, options);

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

  // Creates a request for compiling a string.
  newCompileStringRequest(
    source: string,
    importers: ImporterRegistry<CompilerType>,
    options?: StringOptions<CompilerType>
  ): proto.InboundMessage.CompileRequest {
    const input = new proto.InboundMessage.CompileRequest.StringInput();
    input.setSource(source);
    input.setSyntax(utils.protofySyntax(options?.syntax ?? 'scss'));

    const url = options?.url?.toString();
    if (url && url !== legacyImporterProtocol) {
      input.setUrl(url);
    }

    if (options && 'importer' in options && options.importer) {
      input.setImporter(importers.register(options.importer));
    } else if (url === legacyImporterProtocol) {
      const importer = new proto.InboundMessage.CompileRequest.Importer();
      importer.setPath(p.resolve('.'));
      input.setImporter(importer);
    } else {
      // When importer is not set on the host, the compiler will set a
      // FileSystemImporter if `url` is set to a file: url or a NoOpImporter.
    }

    const request = this.newCompileRequest(importers, options);
    request.setString(input);
    return request;
  }

  dispose() {
    this.compiler.close();
  }
}

/**
 * Different types of compilers which can be used to enforce a valid selection for the Compiler factory
 */
export enum CompilerType {
  ASYNC = 'async',
  SYNC = 'sync',
}

export interface ICompiler {
  compile(path: string, options?: Options<CompilerType>): CompileResult;
  compileString(source: string, options?: Options<CompilerType>): CompileResult;
}

/**
 * Base interface for all compiler types.
 */
export interface IEmbeddedProcess {
  readonly stdout$: Subject<Buffer> | Observable<Buffer>;
  readonly stderr$: Subject<Buffer> | Observable<Buffer>;
  writeStdin(buffer: Buffer): void;
  close: () => void;
}