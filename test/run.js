var assert = require("assert")
var fs = require('fs-extra');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var webpack = require('webpack');
var webpackVersion = require('webpack/package.json').version;
var regexEscape = require('escape-string-regexp');
var typescript = require('typescript');
var semver = require('semver')

// force colors on for tests since expected output has colors
require('colors').enabled = true;

var saveOutputMode = process.argv.indexOf('--save-output') != -1;

var savedOutputs = {};

console.log('Using webpack version ' + webpackVersion);
console.log('Using typescript version ' + typescript.version);

// set up new empty staging area
var rootPath = path.resolve(__dirname, '..');
var rootPathWithIncorrectWindowsSeparator = rootPath.replace(/\\/g, '/');
var stagingPath = path.resolve(rootPath, '.test');
rimraf.sync(stagingPath);

// loop through each test directory
fs.readdirSync(__dirname).forEach(function(test) {
    var testPath = path.join(__dirname, test);
    if (fs.statSync(testPath).isDirectory()) {
        
        if (test == 'tsconfigInvalid' && semver.gte(typescript.version, '1.8.0-0')) return;
        if (test == 'tsconfigInvalid-1.8' && semver.lt(typescript.version, '1.8.0-0')) return;
        if (test == 'tsconfigNotReadable' && semver.gte(typescript.version, '1.8.0-0')) return;
        if (test == 'tsconfigNotReadable-1.8' && semver.lt(typescript.version, '1.8.0-0')) return;
        if (test == 'jsx' && semver.gte(typescript.version, '1.8.0-0')) return;
        if (test == 'jsx-1.8' && semver.lt(typescript.version, '1.8.0-0')) return;
        if (test == 'issue81' && semver.lt(typescript.version, '1.7.0-0')) return;
        
        describe(test, function() {
            it('should have the correct output', createTest(test, testPath, {}));
            
            if (test == 'declarationOutput') { return; }
            if (test == 'declarationWatch') { return; }
            if (test == 'issue71') { return; }
            it('should work with transpile', createTest(test, testPath, {transpile: true}));
        });
    }
});

function createTest(test, testPath, options) {
    return function(done) {
        this.timeout(60000); // sometimes it just takes awhile
        
        // set up paths
        var testStagingPath = path.join(stagingPath, test+(options.transpile ? '.transpile' : '')),
            actualOutput = path.join(testStagingPath, 'actualOutput'),
            expectedOutput = path.join(testStagingPath, 'expectedOutput'),
            webpackOutput = path.join(testStagingPath, '.output'),
            originalExpectedOutput = path.join(testPath, 'expectedOutput');
        
        if (saveOutputMode) {
            savedOutputs[test] = savedOutputs[test] || {};
            var regularSavedOutput = savedOutputs[test].regular = savedOutputs[test].regular || {};
            var transpiledSavedOutput = savedOutputs[test].transpiled = savedOutputs[test].transpiled || {};
            var currentSavedOutput = options.transpile ? transpiledSavedOutput : regularSavedOutput;
            mkdirp.sync(originalExpectedOutput);
        }
        
        // copy all input to a staging area
        mkdirp.sync(testStagingPath);
        fs.copySync(testPath, testStagingPath);
           
            
        // ensure output directories
        mkdirp.sync(actualOutput);
        mkdirp.sync(webpackOutput);
        
        // execute webpack
        var config = require(path.join(testStagingPath, 'webpack.config'));
        config.output.path = webpackOutput;
        config.context = testStagingPath;
        config.resolveLoader = config.resolveLoader || {};
        config.resolveLoader.alias = config.resolveLoader.alias || {};
        config.resolveLoader.alias.newLine = path.join(__dirname, 'newline.loader.js');
        config.module.loaders.push({ test: /\.js$/, loader: 'newLine' });
        config.ts = config.ts || {};
        config.ts.silent = true;
        config.ts.compilerOptions = {
            newLine: 'LF'
        }
        
        if (options.transpile) config.ts.transpileOnly = true;
        
        var iteration = 0;
        var lastHash;
        var watcher = webpack(config).watch({aggregateTimeout: 1500}, function(err, stats) {
            var patch = '';
            if (iteration > 0) {
                patch = 'patch'+(iteration-1);
                actualOutput = path.join(testStagingPath, 'actualOutput', patch);
                expectedOutput = path.join(testStagingPath, 'expectedOutput', patch);
                originalExpectedOutput = path.join(testPath, 'expectedOutput', patch)
                mkdirp.sync(actualOutput);
                mkdirp.sync(expectedOutput);
                if (saveOutputMode) mkdirp.sync(originalExpectedOutput);
            }
            
            // output results
            if (saveOutputMode) {
                // loop through webpackOutput and rename to .transpiled if needed
                fs.readdirSync(webpackOutput).forEach(function(file) {
                    var patchedFileName = patch+'/'+file;
                    currentSavedOutput[patchedFileName] = fs.readFileSync(path.join(webpackOutput, file), 'utf-8');
                    
                    if (options.transpile) {
                        if (regularSavedOutput[patchedFileName] !== transpiledSavedOutput[patchedFileName]) {
                            var extension = path.extname(file);
                            fs.renameSync(
                                path.join(webpackOutput, file), 
                                path.join(webpackOutput, path.basename(file, extension)+'.transpiled'+extension)
                            );
                        }
                    }
                });
                
                fs.copySync(webpackOutput, originalExpectedOutput, { clobber: true });
            }
            fs.copySync(webpackOutput, actualOutput);
            rimraf.sync(webpackOutput);
            
            if (err) {
                var errFileName = 'err.txt';
                
                var errString = err.toString()
                    .replace(new RegExp(regexEscape(testStagingPath+path.sep), 'g'), '')
                    .replace(new RegExp(regexEscape(rootPath+path.sep), 'g'), '')
                    .replace(new RegExp(regexEscape(rootPath), 'g'), '')
                    .replace(/\.transpile/g, '');
                
                fs.writeFileSync(path.join(actualOutput, errFileName), errString);
                if (saveOutputMode) {
                    var patchedErrFileName = patch+'/'+errFileName;
                    currentSavedOutput[patchedErrFileName] = errString;
                    
                    if (options.transpile) {
                        if (regularSavedOutput[patchedErrFileName] !== transpiledSavedOutput[patchedErrFileName]) {
                            fs.writeFileSync(path.join(originalExpectedOutput, 'err.transpiled.txt'), errString);
                        }
                    }
                    else {
                        fs.writeFileSync(path.join(originalExpectedOutput, errFileName), errString);
                    }
                }
            }
            
            if (stats && stats.hash != lastHash) {
                lastHash = stats.hash;
                
                var statsFileName = 'output.txt';
                
                var statsString = stats.toString({timings: false, version: false, hash: false})
                    .replace(new RegExp(regexEscape(testStagingPath+path.sep), 'g'), '')
                    .replace(new RegExp(regexEscape(rootPath+path.sep), 'g'), '')
                    .replace(new RegExp(regexEscape(rootPath), 'g'), '')
                    .replace(new RegExp(regexEscape(rootPathWithIncorrectWindowsSeparator), 'g'), '')
                    .replace(/\.transpile/g, '');
                
                fs.writeFileSync(path.join(actualOutput, statsFileName), statsString);
                if (saveOutputMode) {
                    var patchedStatsFileName = patch+'/'+statsFileName;
                    currentSavedOutput[patchedStatsFileName] = statsString;
                    
                    if (options.transpile) {
                        if (regularSavedOutput[patchedStatsFileName] !== transpiledSavedOutput[patchedStatsFileName]) {
                            fs.writeFileSync(path.join(originalExpectedOutput, 'output.transpiled.txt'), statsString);
                        }
                    }
                    else {
                        fs.writeFileSync(path.join(originalExpectedOutput, statsFileName), statsString);
                    }
                }
            }
        
            if (!saveOutputMode) {
                // massage any .transpiled. files
                fs.readdirSync(expectedOutput).forEach(function(file) {
                    if (/\.transpiled/.test(file)) {
                        if (options.transpile) { // rename if we're in transpile mode
                            var extension = path.extname(file);
                            fs.renameSync(
                                path.join(expectedOutput, file), 
                                path.join(expectedOutput, path.basename(file, '.transpiled'+extension)+extension)
                            );
                        }
                        else { // otherwise delete
                            fs.unlinkSync(path.join(expectedOutput, file));
                        }

                    }
                });
                
                // compare actual to expected
                var actualFiles = fs.readdirSync(actualOutput),
                    expectedFiles = fs.readdirSync(expectedOutput)
                        .filter(function(file) { return !/^patch/.test(file); }),
                    allFiles = {};
                        
                actualFiles.map(function(file) { allFiles[file] = true });
                expectedFiles.map(function(file) { allFiles[file] = true });
                
                Object.keys(allFiles).forEach(function(file) {
                    try {
                        var actual = fs.readFileSync(path.join(actualOutput, file)).toString().replace(/\r\n/g, '\n');
                    }
                    catch (e) { actual = '!!!actual file doesnt exist!!!' }
                    
                    try {
                        var expected = fs.readFileSync(path.join(expectedOutput, file)).toString().replace(/\r\n/g, '\n');
                    }
                    catch (e) { expected = '!!!expected file doesnt exist!!!' }
                    
                    assert.equal(actual.toString(), expected.toString(), (patch?patch+'/':patch) + file + ' is different between actual and expected');
                });
            }
            
            // check for new files to copy in
            var patchPath = path.join(testStagingPath, 'patch'+iteration);
            if (fs.existsSync(patchPath)) {
                iteration++;
                
                // can get inconsistent results if copying right away
                setTimeout(function() {
                    fs.copySync(patchPath, testStagingPath, {clobber: true});
                }, 1000);
            }
            else {
                watcher.close(function() {
                    done();
                });
            }
        });
    };
}