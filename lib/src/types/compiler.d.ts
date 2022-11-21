import {Observable, Subject} from 'rxjs';
import {CompileResult, Options} from '../vendor/sass';

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
