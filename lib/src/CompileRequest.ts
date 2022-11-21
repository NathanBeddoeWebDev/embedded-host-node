import { ImporterRegistry } from './importer-registry';
import { CompilerType } from './types/compiler';
import { CompileResult, Options } from './vendor/sass';
import * as proto from './vendor/embedded-protocol/embedded_sass_pb';
import * as utils from './utils';
import { SyncEmbeddedProcess } from './sync-process';
import Compiler from './compiler';
import { FunctionRegistry } from './function-registry';
import { Observable } from 'rxjs';
import { DispatcherHandlers, Dispatcher } from './dispatcher';
import { MessageTransformer } from './message-transformer';
import { PacketTransformer } from './packet-transformer';
import { Exception } from './exception';

export default class CompileRequest<T extends CompilerType> {
  compileResult?: CompileResult;
  constructor(
    compilerType: CompilerType,
    request: proto.InboundMessage.CompileRequest,
    importers: ImporterRegistry<T>,
    options?: Options<T>
  ) {
    switch (compilerType) {
      case CompilerType.ASYNC:
        this.async(request, importers, options);
        break;
      case CompilerType.SYNC:
        this.sync(request, importers, options);
        break;
      default:
        throw new Error(`Unknown compiler type: ${compilerType}`);
    }
  }

  private sync(
    request: proto.InboundMessage.CompileRequest,
    importers: ImporterRegistry<T>,
    options?: Options<T>
  ) {
    const functions = new FunctionRegistry(options?.functions);
    const embeddedCompiler = new Compiler(CompilerType.SYNC)
      .process as SyncEmbeddedProcess;

    const dispatcher = this.createDispatcher<CompilerType.SYNC>(
      embeddedCompiler.stdout$,
      buffer => {
        embeddedCompiler.writeStdin(buffer);
      },
      {
        handleImportRequest: request => importers.import(request),
        handleFileImportRequest: request => importers.fileImport(request),
        handleCanonicalizeRequest: request => importers.canonicalize(request),
        handleFunctionCallRequest: request => functions.call(request),
      }
    );

    dispatcher.logEvents$.subscribe(event => handleLogEvent(options, event));

    let error: unknown;
    let response: proto.OutboundMessage.CompileResponse | undefined;
    dispatcher.sendCompileRequest(request, (error_, response_) => {
      if (error_) {
        error = error_;
      } else {
        response = response_;
      }
    });

    while (embeddedCompiler.yield()) {
      if (error) throw error;
      if (response) return this.handleCompileResponse(response);
    }

    throw utils.compilerError('Embedded compiler exited unexpectedly.');
  }

  private async(
    request: proto.InboundMessage.CompileRequest,
    importers: ImporterRegistry<T>,
    options?: Options<T>
  ) { }

  private createDispatcher<T extends CompilerType>(
    stdout: Observable<Buffer>,
    writeStdin: (buffer: Buffer) => void,
    handlers: DispatcherHandlers<T>
  ): Dispatcher<T> {
    const packetTransformer = new PacketTransformer(stdout, writeStdin);

    const messageTransformer = new MessageTransformer(
      packetTransformer.outboundProtobufs$,
      packet => packetTransformer.writeInboundProtobuf(packet)
    );

    return new Dispatcher<T>(
      messageTransformer.outboundMessages$,
      message => messageTransformer.writeInboundMessage(message),
      handlers
    );
  }

  private handleCompileResponse(
    response: proto.OutboundMessage.CompileResponse
  ): CompileResult {
    if (response.getSuccess()) {
      const success = response.getSuccess()!;
      const result: CompileResult = {
        css: success.getCss(),
        loadedUrls: success.getLoadedUrlsList().map(url => new URL(url)),
      };

      const sourceMap = success.getSourceMap();
      if (sourceMap) result.sourceMap = JSON.parse(sourceMap);
      return result;
    } else if (response.getFailure()) {
      throw new Exception(response.getFailure()!);
    } else {
      throw utils.compilerError('Compiler sent empty CompileResponse.');
    }
  }
}
