import { ImporterRegistry } from '../importer-registry';
import { CompilerType, IEmbeddedProcess } from './Compiler';
import { CompileResult, Options, SourceSpan } from '../vendor/sass';
import * as proto from '../vendor/embedded-protocol/embedded_sass_pb';
import * as utils from '../utils';
import { SyncEmbeddedProcess } from '../sync-process';
import { FunctionRegistry } from '../function-registry';
import { Observable } from 'rxjs';
import { DispatcherHandlers, Dispatcher } from '../dispatcher';
import { MessageTransformer } from '../message-transformer';
import { PacketTransformer } from '../packet-transformer';
import { Exception } from '../exception';
import { deprotofySourceSpan } from '../deprotofy-span';
import { AsyncEmbeddedProcess } from '../async-process';

export class Compilation<T extends CompilerType> {
  compileResult?: CompileResult;
  process: IEmbeddedProcess;
  constructor(
    compilerType: CompilerType,
    process: IEmbeddedProcess,
    request: proto.InboundMessage.CompileRequest,
    importers: ImporterRegistry<T>,
    options?: Options<T>
  ) {
    switch (compilerType) {
      case CompilerType.ASYNC:
        this.process = process as AsyncEmbeddedProcess;
        this.async(request, importers, options);
        break;
      case CompilerType.SYNC:
        this.process = process as SyncEmbeddedProcess;
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
    const dispatcher = this.createDispatcher<CompilerType.SYNC>(
      this.process.stdout$,
      buffer => {
        this.process.writeStdin(buffer);
      },
      {
        handleImportRequest: request => importers.import(request) as proto.InboundMessage.ImportResponse,
        handleFileImportRequest: request => importers.fileImport(request) as proto.InboundMessage.FileImportResponse,
        handleCanonicalizeRequest: request => importers.canonicalize(request) as proto.InboundMessage.CanonicalizeResponse,
        handleFunctionCallRequest: request => functions.call(request) as proto.InboundMessage.FunctionCallResponse,
      }
    );

    dispatcher.logEvents$.subscribe(event => this.handleLogEvent(options, event));

    let error: unknown;
    let response: proto.OutboundMessage.CompileResponse | undefined;
    dispatcher.sendCompileRequest(request, (error_, response_) => {
      if (error_) {
        error = error_;
      } else {
        response = response_;
      }
    });

    while ((this.process as SyncEmbeddedProcess).yield()) {
      if (error) throw error;
      if (response) return this.handleCompileResponse(response);
    }

    throw utils.compilerError('Embedded compiler exited unexpectedly.');
  }

  private async async(
    request: proto.InboundMessage.CompileRequest,
    importers: ImporterRegistry<T>,
    options?: Options<T>
  ): Promise<CompileResult> {
    const functions = new FunctionRegistry(options?.functions);

    const dispatcher = this.createDispatcher<CompilerType.ASYNC>(
      this.process.stdout$,
      buffer => {
        this.process.writeStdin(buffer);
      },
      {
        handleImportRequest: request => importers.import(request),
        handleFileImportRequest: request => importers.fileImport(request),
        handleCanonicalizeRequest: request => importers.canonicalize(request),
        handleFunctionCallRequest: request => functions.call(request),
      }
    );

    dispatcher.logEvents$.subscribe(event => this.handleLogEvent(options, event));

    return this.handleCompileResponse(
      await new Promise<proto.OutboundMessage.CompileResponse>(
        (resolve, reject) =>
          dispatcher.sendCompileRequest(request, (err, response) => {
            if (err) {
              reject(err);
            } else {
              resolve(response!);
            }
          })
      )
    );
  }

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

  private handleLogEvent(
    options: Options<CompilerType> | undefined,
    event: proto.OutboundMessage.LogEvent
  ): void {
    if (event.getType() === proto.LogEventType.DEBUG) {
      if (options?.logger?.debug) {
        options.logger.debug(event.getMessage(), {
          span: deprotofySourceSpan(event.getSpan()!),
        });
      } else {
        console.error(event.getFormatted());
      }
    } else {
      if (options?.logger?.warn) {
        const params: { deprecation: boolean; span?: SourceSpan; stack?: string } =
        {
          deprecation:
            event.getType() === proto.LogEventType.DEPRECATION_WARNING,
        };

        const spanProto = event.getSpan();
        if (spanProto) params.span = deprotofySourceSpan(spanProto);

        const stack = event.getStackTrace();
        if (stack) params.stack = stack;

        options.logger.warn(event.getMessage(), params);
      } else {
        console.error(event.getFormatted());
      }
    }
  }
}
