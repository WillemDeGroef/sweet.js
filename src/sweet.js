/*
  Copyright (C) 2012 Tim Disney <tim@disnet.me>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/


(function (root, factory) {
    if (typeof exports === 'object') {
        var path = require('path');
        var fs   = require('fs');
        var lib  = path.join(path.dirname(fs.realpathSync(__filename)), "../macros");

        var stxcaseModule = fs.readFileSync(lib + "/stxcase.js", 'utf8');

        factory(exports,
                require("underscore"),
                require("./parser"),
                require("./expander"),
                require("./syntax"),
                stxcaseModule,
                require("escodegen"),
                require("escope"),
                fs);

        // Alow require('./example') for an example.sjs file.
        require.extensions['.sjs'] = function(module, filename) {
            var content = require('fs').readFileSync(filename, 'utf8');
            module._compile(codegen.generate(exports.parse(content)), filename);
        };
    } else if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['exports',
                'underscore',
                './parser',
                './expander',
                './syntax',
                'text!./stxcase.js'], factory);
    }
}(this, function (exports, _, parser, expander, syn, stxcaseModule, gen, scope, fs) {
    var codegen = gen || escodegen;
    var escope = scope || escope;
    var expand = makeExpand(expander.expand);
    var expandModule = makeExpand(expander.expandModule);
    var stxcaseCtx;

    function makeExpand(expandFn) {
        // fun (Str) -> [...CSyntax]
        return function expand(code, modules, maxExpands) {
            var program, toString;
            modules = modules || [];

            if (!stxcaseCtx) {
                stxcaseCtx = expander.expandModule(parser.read(stxcaseModule));
            }

            toString = String;
            if (typeof code !== 'string' && !(code instanceof String)) {
                code = toString(code);
            }
            
            var source = code;

            if (source.length > 0) {
                if (typeof source[0] === 'undefined') {
                    // Try first to convert to a string. This is good as fast path
                    // for old IE which understands string indexing for string
                    // literals only and not for string object.
                    if (code instanceof String) {
                        source = code.valueOf();
                    }

                    // Force accessing the characters via an array.
                    if (typeof source[0] === 'undefined') {
                        source = stringToArray(code);
                    }
                }
            }

            var readTree = parser.read(source);
            try {
                return expandFn(readTree, [stxcaseCtx].concat(modules), maxExpands);
            } catch(err) {
                if (err instanceof syn.MacroSyntaxError) {
                    throw new SyntaxError(syn.printSyntaxError(source, err));
                } else {
                    throw err;
                }
            }
        }
    }

    // fun (Str, {}) -> AST
    function parse(code, modules, maxExpands) {
        if (code === "") {
            // old version of esprima doesn't play nice with the empty string
            // and loc/range info so until we can upgrade hack in a single space
            code = " ";
        }

        return parser.parse(expand(code, modules, maxExpands));
    }

    // (Str, {sourceMap: ?Bool, filename: ?Str})
    //    -> { code: Str, sourceMap: ?Str }
    function compile(code, options) {
        var output;
        options = options || {};

        var ast = parse(code, 
                        options.modules || [],
                        options.maxExpands);

        if (options.readableNames) {
            ast = optimizeHygiene(ast);
        }

        if (options.ast) {
            return ast;
        }

        if (options.sourceMap) {
            output = codegen.generate(ast, _.extend({
                comment: true,
                sourceMap: options.filename,
                sourceMapWithCode: true
            }, options.escodegen));

            return {
                code: output.code,
                sourceMap: output.map.toString()
            };
        } 
        return {
            code: codegen.generate(ast, _.extend({
                comment: true
            }, options.escodegen))
        };
    }

    function loadNodeModule(root, moduleName) {
        var Module = module.constructor;
        var mock = {
            id: root + "/$sweet-loader.js",
            filename: "$sweet-loader.js",
            paths: /^\.\/|\.\./.test(root) ? [root] : Module._nodeModulePaths(root)
        };
        var path = Module._resolveFilename(moduleName, mock);
        return expandModule(fs.readFileSync(path, "utf8"));
    }

    function optimizeHygiene(ast) {
        // escope hack: sweet doesn't rename global vars. We wrap in a closure
        // to create a 'static` scope for all of the vars sweet renamed.
        var wrapper = parse('(function(){})()');
        wrapper.body[0].expression.callee.body.body = ast.body;

        function sansUnique(name) {
            var match = name.match(/^(.+)\$[\d]+$/);
            return match ? match[1] : null;
        }

        function wouldShadow(name, scope) {
            while (scope) {
                if (scope.scrubbed && scope.scrubbed.has(name)) {
                    return scope.scrubbed.get(name);
                }
                scope = scope.upper;
            }
            return 0;
        }

        escope.analyze(wrapper).scopes.forEach(function(scope) {
            if (!scope.isStatic()) {
                return;
            }
            scope.scrubbed = new expander.StringMap();
            scope.variables.forEach(function(variable) {
                var name = sansUnique(variable.name);
                if (!name) {
                    return;
                }

                var level = wouldShadow(name, scope);
                if (level) {
                    scope.scrubbed.set(name, level + 1);
                    name = name + '$' + (level + 1);
                } else {
                    scope.scrubbed.set(name, 1);
                }
                variable.identifiers.forEach(function(i) {
                    i.name = name;
                });
                variable.references.forEach(function(r) {
                    r.identifier.name = name;
                });
            });
        });

        return ast;
    }

    exports.expand = expand;
    exports.parse = parse;
    exports.compile = compile;
    exports.loadModule = expandModule;
    exports.loadNodeModule = loadNodeModule;
}));


