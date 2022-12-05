// Copyright 2020 Google Inc. Use of this source code is governed by an
// MIT-style license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import * as p from 'path';
import { Observable } from 'rxjs';
import * as supportsColor from 'supports-color';

import * as proto from './vendor/embedded-protocol/embedded_sass_pb';
import * as utils from './utils';
import { CompileResult, Options, SourceSpan, StringOptions } from './vendor/sass';
import { Dispatcher, DispatcherHandlers } from './dispatcher';
import { Exception } from './exception';
import { FunctionRegistry } from './function-registry';
import { ImporterRegistry } from './importer-registry';
import { MessageTransformer } from './message-transformer';
import { PacketTransformer } from './packet-transformer';
import { deprotofySourceSpan } from './deprotofy-span';
import { legacyImporterProtocol } from './legacy/importer';
import { Compiler, CompilerType } from './compiler/Compiler';
import { AsyncEmbeddedProcess } from './async-process';
import { SyncEmbeddedProcess } from './sync-process';

export function compile(
  path: string,
  options?: Options<CompilerType.SYNC>
): CompileResult {
  const importers = new ImporterRegistry(options);
  return compileRequestSync(
    newCompilePathRequest(path, importers, options),
    importers,
    options
  );
}

export function compileString(
  source: string,
  options?: StringOptions<CompilerType.SYNC>
): CompileResult {
  const importers = new ImporterRegistry(options);
  return compileRequestSync(
    newCompileStringRequest(source, importers, options),
    importers,
    options
  );
}

export function compileAsync(
  path: string,
  options?: Options<CompilerType.ASYNC>
): Promise<CompileResult> {
  const importers = new ImporterRegistry(options);
  return compileRequestAsync(
    newCompilePathRequest(path, importers, options),
    importers,
    options
  );
}

export function compileStringAsync(
  source: string,
  options?: StringOptions<CompilerType.ASYNC>
): Promise<CompileResult> {
  const importers = new ImporterRegistry(options);
  return compileRequestAsync(
    newCompileStringRequest(source, importers, options),
    importers,
    options
  );
}

// Creates a request for compiling a file.
function newCompilePathRequest(
  path: string,
  importers: ImporterRegistry<CompilerType>,
  options?: Options<CompilerType>
): proto.InboundMessage.CompileRequest {
  const request = newCompileRequest(importers, options);
  request.setPath(path);
  return request;
}

// Creates a request for compiling a string.
function newCompileStringRequest(
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

  const request = newCompileRequest(importers, options);
  request.setString(input);
  return request;
}

// Creates a compilation request for the given `options` without adding any
// input-specific options.
function newCompileRequest(
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

// Spins up a compiler, then sends it a compile request. Returns a promise that
// resolves with the CompileResult. Throws if there were any protocol or
// compilation errors. Shuts down the compiler after compilation.
async function compileRequestAsync(
  request: proto.InboundMessage.CompileRequest,
  importers: ImporterRegistry<CompilerType.ASYNC>,
  options?: Options<CompilerType.ASYNC>
): Promise<CompileResult> {
  const functions = new FunctionRegistry(options?.functions);
  const embeddedCompiler = new Compiler(CompilerType.ASYNC)
    .compiler as AsyncEmbeddedProcess;

  const dispatcher = createDispatcher<CompilerType.ASYNC>(
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

  return handleCompileResponse(
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

// Spins up a compiler, then sends it a compile request. Returns a promise that
// resolves with the CompileResult. Throws if there were any protocol or
// compilation errors. Shuts down the compiler after compilation.
function compileRequestSync(
  request: proto.InboundMessage.CompileRequest,
  importers: ImporterRegistry<CompilerType.SYNC>,
  options?: Options<CompilerType.SYNC>
): CompileResult {
  const functions = new FunctionRegistry(options?.functions);
  const embeddedCompiler = new Compiler(CompilerType.SYNC)
    .compiler as SyncEmbeddedProcess;

  const dispatcher = createDispatcher<CompilerType.SYNC>(
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
    if (response) return handleCompileResponse(response);
  }

  throw utils.compilerError('Embedded compiler exited unexpectedly.');
}

/**
 * Creates a dispatcher that dispatches messages from the given `stdout` stream.
 */
function createDispatcher<T extends CompilerType>(
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

/** Handles a log event according to `options`. */
function handleLogEvent(
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

/**
 * Converts a `CompileResponse` into a `CompileResult`.
 *
 * Throws a `SassException` if the compilation failed.
 */
function handleCompileResponse(
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
