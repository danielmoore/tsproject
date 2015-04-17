﻿import { CompilerResult } from "./CompilerResult";
import { CompilerHost }  from "./CompilerHost";
import { CompileStream }  from "./CompileStream";
import { Logger } from "./Logger";
import { TsVinylFile } from "./TsVinylFile";
import { BundleParser, Bundle } from "./BundleParser";
import { DependencyBuilder } from "./DependencyBuilder";
import * as utils from "./Utilities";

import ts = require( 'typescript' );
import path = require( 'path' );

export class Bundler {

    private compilerHost: CompilerHost;
    private program: ts.Program;
    private compilerOptions: ts.CompilerOptions = { charset: "utf-8" };

    private bundleText: string = "";
    private bundleImportedFiles: ts.Map<string> = {};

    constructor( compilerHost: CompilerHost, program: ts.Program ) {
        this.compilerHost = compilerHost
        this.program = program;
    }

    public bundle( outputStream: CompileStream, bundle: Bundle ) {
        var dependencyBuilder = new DependencyBuilder( this.compilerHost, this.program );

        let bundleSourceFileName = this.compilerHost.getCanonicalFileName( utils.normalizeSlashes( bundle.source ) );
        var bundleSourceFile = this.program.getSourceFile( bundleSourceFileName );

        var sourceDependencies = dependencyBuilder.getSourceFileDependencies( bundleSourceFile );

        this.bundleText = "";
        this.bundleImportedFiles = { };

        for ( var key in sourceDependencies ) {
            // Add module dependencies first..
            sourceDependencies[key].forEach( importSymbol => {
                if ( this.isCodeModule( importSymbol ) ) {
                    let declaration = importSymbol.getDeclarations()[0];
                    let importedSource = declaration.getSourceFile();
                    let importedSourceFileName = importedSource.fileName;

                    if ( !utils.hasProperty( this.bundleImportedFiles, importedSourceFileName ) ) {
                        this.addSourceFile( importedSource );
                    }
                }
            });

            // Add the source module as specified by key
            var dependentSourceFile = this.program.getSourceFile( key );
            let outputFileName = dependentSourceFile.fileName;

            if ( !utils.hasProperty( this.bundleImportedFiles, outputFileName ) ) {
                this.addSourceFile( dependentSourceFile );
            }
        }

        // Finally, add bundle source file
        let outputFileName = bundleSourceFile.fileName;
        this.addSourceFile( bundleSourceFile );

        var tsVinylFile = new TsVinylFile( {
            path: bundle.name + ".ts",
            contents: new Buffer( this.bundleText )
        });

        outputStream.push( tsVinylFile );

        // Compile the bundle to generate javascript and declaration file
        let result = this.compileBundle( bundle.name + ".ts", this.bundleText, { module: ts.ModuleKind.AMD, declaration: true });

        var bundleJsVinylFile = new TsVinylFile( {
            path: bundle.name + ".js",
            contents: new Buffer( result[ bundle.name + ".js" ])
        });

        outputStream.push( bundleJsVinylFile );

        var bundleDtsVinylFile = new TsVinylFile( {
            path: bundle.name + ".d.ts",
            contents: new Buffer( result[bundle.name + ".d.ts"] )
        });

        outputStream.push( bundleDtsVinylFile );
    }

    private isCodeModule( importSymbol: ts.Symbol ): boolean {
        let declaration = importSymbol.getDeclarations()[0];

        return ( declaration.kind === ts.SyntaxKind.SourceFile &&
            !( declaration.flags & ts.NodeFlags.DeclarationFile ) );
    }

    private editImportStatements( file: ts.SourceFile ): string {
        Logger.log( "---> editImportStatement()" );
        let editText = file.text;
        ts.forEachChild( file, node => {
            if ( node.kind === ts.SyntaxKind.ImportDeclaration || node.kind === ts.SyntaxKind.ImportEqualsDeclaration || node.kind === ts.SyntaxKind.ExportDeclaration ) {
                let pos = node.pos;
                let end = node.end;

                // White out import statement. 
                // NOTE: Length needs to stay the same as original import statement
                let length = end - pos;
                let middle = "";
                for ( var i = 0; i < length; i++ ) {
                    middle += " ";
                }
                
                var prefix = editText.substring( 0, pos );
                var suffix = editText.substring( end );

                editText = prefix + middle + suffix;
            }
        });

        return editText;
    }

    private addSourceFile( file: ts.SourceFile ) {
        // Before adding the source text, we must white out import statement(s)
        let editText = this.editImportStatements( file );

        this.bundleText += editText + "\n";
        this.bundleImportedFiles[file.fileName] = file.fileName;
    }

    // Replace with Transpile function from typescript 1.5 when available
    private compileBundle( fileName: string, input: string, compilerOptions?: ts.CompilerOptions, diagnostics?: ts.Diagnostic[] ): ts.Map<string> {
        let options = compilerOptions ? utils.clone( compilerOptions ) : ts.getDefaultCompilerOptions();

        //options.separateCompilation = true;

        options.declaration = true;
        options.target = ts.ScriptTarget.ES5;
        options.module = ts.ModuleKind.AMD;
        options.diagnostics = true;

        // Filename can be non-ts file.
        //options.allowNonTsExtensions = true;

        // Parse
        var inputFileName = fileName || "module.ts";
        var sourceFile = ts.createSourceFile( inputFileName, input, options.target, true );

        // Store syntactic diagnostics
        //if ( diagnostics && sourceFile.parseDiagnostics ) {
        //    diagnostics.push( ...sourceFile.parseDiagnostics );
        //}

        // Output
        let outputText: ts.Map<string> = {};

        // Create a compilerHost object to allow the compiler to read and write files
        var bundlerCompilerHost: ts.CompilerHost = {
            getSourceFile: ( fileName, target ) => {
                Logger.log( "getSourceFile(): ", fileName );
                return fileName === inputFileName ? sourceFile : undefined
            },
            writeFile: ( name, text, writeByteOrderMark ) => {
                Logger.log( "writeFile() with: ", name );
                outputText[name] = text;
            },
            getDefaultLibFileName: () => "lib.d.ts",
            useCaseSensitiveFileNames: () => false,
            getCanonicalFileName: fileName => fileName,
            getCurrentDirectory: () => process.cwd(),
            getNewLine: () => "\n"
        };

        var bundlerProgram = ts.createProgram( [inputFileName], options, bundlerCompilerHost );

        if ( diagnostics ) {
            diagnostics.push( ...bundlerProgram.getGlobalDiagnostics() );
        }

        // Emit
        var emitResult = bundlerProgram.emit();

        var allDiagnostics = ts.getPreEmitDiagnostics( bundlerProgram ).concat( emitResult.diagnostics );

        Logger.log( allDiagnostics );

        return outputText;
    }
} 