'use strict'

var path = require('path')
var fs = require('fs')
var findup = require('findup-sync')
var RSVP = require('rsvp')
var tmp = require('tmp')
var rimraf = require('rimraf')
var underscoreString = require('underscore.string')
var WatchedDir = require('broccoli-source').WatchedDir


// TODO terminology issues:
// builder node => meta node, builder node, node handler (abstracts user code)
// expected vs unexpected build error => humanized, handled, graceful, stackless, build, actionable (like 400 vs 500 http), user error
//     make subclasses combinable - location, html&ascii representation, link to deprecation page
// plugin interface => Broccoli delegate (delegate is a thing, an object *has* an interface)
// node description => node label
//    make it MergeTrees(more packages) WatchedDir(vendor)
// instantiation stack => "originated at"

// TODO make label MergeTrees(vendor packages)


// TODO: "thrown from"


exports.Builder = Builder
function Builder(node, options) {
  if (options == null) options = {}

  this.node = node
  this.tmpdir = options.tmpdir // can be null

  this.unwatchedPaths = []
  this.watchedPaths = []

  // builderNodes are wrappers around nodes storing additional information.
  // This array contains them sorted in topological (build) order.
  this.builderNodes = []
  // This populates this.builderNodes as a side effect
  this.builderNode = this.makeBuilderNode(this.node)

  this.setupTmpDirs()

  // Now that temporary directories are set up, we need to run the rest of the
  // constructor in a try/catch block to clean them up if necessary.
  try {

    this.setupNodes()
    this.outputPath = this.builderNode.outputPath

  } catch (e) {
    this.cleanup()
    throw e
  }

  this.buildId = 0
}

Builder.prototype.build = function() {
  // This method essentially does
  //     for each builderNode in this.builderNodes
  //       builderNode.build()
  // plus a bunch of bookkeeping.
  var self = this
  this.buildId++
  var promise = RSVP.resolve()
  promise = promise.then(function() { self.trigger('start') })
  this.builderNodes.forEach(function(bn) {
    // We use `.forEach` instead of `for` to close nested functions over `bn`
    var startTime
    // TODO clear ahead of time
    bn.buildState = {
      buildId: self.buildId
    }
    promise = promise.then(function() { self.trigger('nodeStart', bn) })
    if (bn.pluginInterface.nodeType === 'transform') {
      promise = promise.then(function() { startTime = process.hrtime() })
      if (!bn.pluginInterface.persistentOutput) {
        promise = promise.then(function() {
          rimraf.sync(bn.outputPath)
          fs.mkdirSync(bn.outputPath)
        })
      }
      promise = promise.then(function() {
        // We use a nested .then/.catch so that the .catch can only catch errors
        // from this node, but not from previous nodes.
        return RSVP.resolve()
          .then(function() {
            return bn.build()
          })
          .catch(function(err) {
            throw new BuildError(err, bn)
          })
          .finally(function() {
            var now = process.hrtime()
            // Build time in milliseconds
            bn.buildState.selfTime = 1000 * ((now[0] - startTime[0]) + (now[1] - startTime[1]) / 1e9)
            bn.buildState.totalTime = bn.buildState.selfTime
            for (var i = 0; i < bn.inputBuilderNodes.length; i++) {
              bn.buildState.totalTime += bn.inputBuilderNodes[i].buildState.totalTime
            }
          })
          .finally(function() { self.trigger('nodeEnd', bn) })
      })
    } else { // nodeType === 'source'
      promise = promise.then(function() { self.trigger('nodeEnd', bn) })
      bn.buildState.selfTime = 0
      bn.buildState.totalTime = 0
    }
  })
  promise = promise.finally(function() { self.trigger('end') })
  return promise
}

Builder.prototype.cleanup = function() {
  this.builderTmpDirCleanup()
}

Builder.prototype.makeBuilderNode = function(node, _stack) {
  if (_stack == null) _stack = []
  var self = this

  // Dedupe nodes reachable through multiple paths
  for (var i = 0; i < this.builderNodes.length; i++) {
    if (this.builderNodes[i].originalNode === node) {
      return this.builderNodes[i]
    }
  }

  // Turn string nodes into WatchedDir nodes
  var originalNode = node // keep original (possibly string) node around for deduping
  if (typeof node === 'string') {
    node = new WatchedDir(node, { annotation: 'string node' })
  }

  // Check that `node` is in fact a Broccoli node
  if (node == null || !node.__broccoliGetInfo__) {
    var message = ''
    if (node != null && (typeof node.read === 'function' || typeof node.rebuild === 'function')) {
      var legacyNodeDescription = (node && node.description) ||
        (node && node.constructor && node.constructor.name) ||
        ('' + node)
      message = 'The .read/.rebuild API is no longer supported as of Broccoli 1.0. ' +
        'Plugins must now derive from broccoli-plugin. Got .read/.rebuild based node "' + legacyNodeDescription + '"'
    } else {
      message = 'Expected Broccoli node, got ' + node
    }
    if (_stack.length > 0) {
      throw new InvalidNodeError(message + '\nused as input node to "' + _stack[_stack.length-1].description +'"' +
        formatInstantiationStack(_stack[_stack.length-1])
      )
    } else {
      throw new InvalidNodeError(message + ' as output node')
    }
  }

  var pluginInterface = this.getPluginInterface(node)

  // Compute description, like "Funnel: test suite"
  // TODO: use sourceDirectory for 'source' nodes
  var description = pluginInterface.name
  if (pluginInterface.annotation != null) description += ': ' + pluginInterface.annotation

  // We start constructing the builderNode here because we'll need the partial
  // builderNode for the _stack. Later we'll add more properties.
  var builderNode = new BuilderNode
  builderNode.pluginInterface = pluginInterface
  builderNode.originalNode = originalNode
  builderNode.node = node
  builderNode.description = description

  // Detect cycles
  for (i = 0; i < _stack.length; i++) {
    if (_stack[i].node === originalNode) {
      var cycleMessage = 'Cycle in node graph: '
      for (var j = i; j < _stack.length; j++) {
        cycleMessage += _stack[j].description + ' -> '
      }
      cycleMessage += builderNode.description
      throw new BuilderError(cycleMessage)
    }
  }

  // For 'transform' nodes, recurse into the input nodes; for 'source' nodes,
  // record paths.
  var inputBuilderNodes = []
  if (pluginInterface.nodeType === 'transform') {
    var newStack = _stack.concat([builderNode])
    inputBuilderNodes = pluginInterface.inputNodes.map(function(inputNode) {
      return self.makeBuilderNode(inputNode, newStack)
    })
  } else { // nodeType === 'source'
    if (pluginInterface.watched) {
      this.watchedPaths.push(pluginInterface.sourceDirectory)
    } else {
      this.unwatchedPaths.push(pluginInterface.sourceDirectory)
    }
  }

  // All builderNodes get an `inputBuilderNodes` array; for 'source' nodes
  // it's empty.
  builderNode.inputBuilderNodes = inputBuilderNodes

  builderNode.id = this.builderNodes.length

  // this.builderNodes will contain all the builder nodes in topological
  // order, i.e. each node comes after all its input nodes.
  //
  // It's unfortunate that we're mutating this.builderNodes as a side effect,
  // but since we work backwards from the output node to discover all the
  // input nodes, it's harder to do a side-effect-free topological sort.
  this.builderNodes.push(builderNode)

  return builderNode
}

// This list of [feature, augmentationFunction] pairs is used to maintain
// backwards compatibility with older broccoli-plugin versions.
//
// If a plugin doesn't support `feature`, then `augmentationFunction` is
// called on its plugin interface (as returned by node.__broccoliGetInfo__())
// in order to bring the interface up-to-date. If a plugin is missing several
// features, each `augmentationFunction` is applied in succession.
//
// Note that feature flags are not independent; every feature flag requires
// the earlier flags to be set as well.
//
// Add new features to the bottom of the list.
var augmenters = [
  [
    'persistentOutputFlag', function(pluginInterface) {
      pluginInterface.persistentOutput = false
    }
  ], [
    'sourceDirectories', function(pluginInterface) {
      pluginInterface.nodeType = 'transform'
    }
  ]
]

Builder.prototype.features = {}
for (var i = 0; i < augmenters.length; i++) {
  Builder.prototype.features[augmenters[i][0]] = true
}

Builder.prototype.getPluginInterface = function(node) {
  var features = {}

  // Discover features we have in common
  for (var i = 0; i < augmenters.length; i++) {
    var feature = augmenters[i][0]
    if (!node.__broccoliFeatures__[feature]) {
      break
    }
    features[feature] = true
  }

  // Get the plugin interface. Note that we're passing the builder's full
  // feature set (`this.features`) rather than the smaller feature set we're
  // mimicking (`features`). This is a fairly arbitrary choice, but it's
  // easier to implement, and it usually won't make a difference because the
  // Plugin class won't care about features it doesn't know about.
  var pluginInterface = node.__broccoliGetInfo__(this.features)

  // Augment the interface with the new features that the plugin doesn't support
  for (; i < augmenters.length; i++) {
    var fn = augmenters[i][1]
    // Use prototypal inheritance to avoid mutating other people's objects
    pluginInterface = Object.create(pluginInterface)
    fn(pluginInterface)
  }

  // We generally trust the pluginInterface to be valid, but unexpected
  // nodeTypes could break our code paths really badly, and some of those
  // paths call rimraf, so we check that to be safe.
  if (pluginInterface.nodeType !== 'transform' && pluginInterface.nodeType !== 'source') {
    throw new Error('Assertion error: Unexpected nodeType: ' + pluginInterface.nodeType)
  }

  return pluginInterface
}

Builder.prototype.setupTmpDirs = function() {
  // Create temporary directories for each node:
  //
  // out-01-someplugin/
  // out-02-otherplugin/
  // cache-01-someplugin/
  // cache-02-otherplugin/
  //
  // Here's an alternative directory structure we might consider (it's not
  // clear which structure makes debugging easier):
  //
  //   01/
  //     out/
  //     cache/
  //     in-01 -> ... // symlink for convenience
  //     in-02 -> ...
  //   02/
  //     ...
  var tmpobj = tmp.dirSync({ prefix: 'broccoli-', unsafeCleanup: true, dir: this.tmpdir })
  this.builderTmpDir = tmpobj.name
  this.builderTmpDirCleanup = tmpobj.removeCallback
  for (var i = 0; i < this.builderNodes.length; i++) {
    var builderNode = this.builderNodes[i]
    if (builderNode.pluginInterface.nodeType === 'transform') {
      builderNode.inputPaths = builderNode.inputBuilderNodes.map(function(bn) {
        return bn.outputPath
      })
      builderNode.outputPath = this.mkTmpDir(builderNode, 'out')
      builderNode.cachePath = this.mkTmpDir(builderNode, 'cache')
    } else { // nodeType === 'source'
      // We could name this .sourcePath, but with .outputPath the code is simpler.
      builderNode.outputPath = builderNode.pluginInterface.sourceDirectory
    }
  }
}

Builder.prototype.mkTmpDir = function(builderNode, type) {
  // slugify turns fooBar into foobar, so we call underscored first to
  // preserve word boundaries
  var suffix = underscoreString.underscored(builderNode.description.substr(0, 60))
  suffix = underscoreString.slugify(suffix).replace(/-/g, '_')
  var paddedIndex = underscoreString.pad('' + builderNode.id, ('' + this.builderNodes.length).length, '0')
  var dirname = type + '-' + paddedIndex + '-' + suffix
  var tmpDir = path.join(this.builderTmpDir, dirname)
  fs.mkdirSync(tmpDir)
  return tmpDir
}

Builder.prototype.setupNodes = function() {
  for (var i = 0; i < this.builderNodes.length; i++) {
    var bn = this.builderNodes[i]
    if (bn.pluginInterface.nodeType !== 'transform') continue
    try {
      bn.pluginInterface.setup(this.features, {
        inputPaths: bn.inputPaths,
        outputPath: bn.outputPath,
        cachePath: bn.cachePath
      })
      var callbackObject = bn.pluginInterface.getCallbackObject()
      bn.build = callbackObject.build.bind(callbackObject)
    } catch (err) {
      // Rethrow, reporting instantiation stack of offending node
      throw new NodeSetupError(err, bn)
    }
  }
}

RSVP.EventTarget.mixin(Builder.prototype)


exports.loadBrocfile = loadBrocfile
function loadBrocfile () {
  var brocfile = findup('Brocfile.js', {
    nocase: true
  })

  if (brocfile == null) throw new Error('Brocfile.js not found')

  var baseDir = path.dirname(brocfile)

  // The chdir should perhaps live somewhere else and not be a side effect of
  // this function, or go away entirely
  process.chdir(baseDir)

  var tree = require(brocfile)

  return tree
}


// Base class for builder errors
Builder.BuilderError = BuilderError
BuilderError.prototype = Object.create(Error.prototype)
BuilderError.prototype.constructor = BuilderError
function BuilderError(message) {
  // Subclassing Error in ES5 is non-trivial because reasons, so we need this
  // extra constructor logic from http://stackoverflow.com/a/17891099/525872.
  // Once we use ES6 classes we can get rid of this code (maybe except for
  // .name - see https://code.google.com/p/chromium/issues/detail?id=542707).
  // Note that ES5 subclasses of BuilderError don't in turn need any special
  // code.
  var temp = Error.apply(this, arguments)
  // Need to assign temp.name for correct error class in .stack and .message
  temp.name = this.name = this.constructor.name
  this.stack = temp.stack
  this.message = temp.message
}

Builder.InvalidNodeError = InvalidNodeError
InvalidNodeError.prototype = Object.create(BuilderError.prototype)
InvalidNodeError.prototype.constructor = InvalidNodeError
function InvalidNodeError(message) {
  BuilderError.call(this, message)
}

Builder.NodeSetupError = NodeSetupError
NodeSetupError.prototype = Object.create(BuilderError.prototype)
NodeSetupError.prototype.constructor = NodeSetupError
function NodeSetupError(originalError, builderNode) {
  if (builderNode == null) { // Chai calls new NodeSetupError() :(
    BuilderError.call(this)
    return
  }
  originalError = wrapPrimitiveErrors(originalError)
  var message = originalError.message +
    '\nthrown from "' + builderNode.description + '"' +
    formatInstantiationStack(builderNode)
  BuilderError.call(this, message)
  // The stack will have the original exception name, but that's OK
  this.stack = originalError.stack
}

Builder.BuildError = BuildError
BuildError.prototype = Object.create(BuilderError.prototype)
BuildError.prototype.constructor = BuildError
function BuildError(originalError, builderNode) {
  if (builderNode == null) { // for Chai
    BuilderError.call(this)
    return
  }

  originalError = wrapPrimitiveErrors(originalError)

  // Create heavily augmented message for easy printing to the terminal. Web
  // interfaces should refer to broccoliPayload.originalError.message instead.
  var fileSnippet = ''
  if (originalError.file != null) {
    fileSnippet = originalError.file
    if (originalError.line != null) {
      fileSnippet += ':' + originalError.line
      if (originalError.column != null) {
        // .column is zero-indexed
        fileSnippet += ':' + (originalError.column + 1)
      }
    }
    fileSnippet += ': '
  }
  var instantiationStack = ''
  if (originalError.file == null) {
    // We want to report the instantiation stack only for "unexpected" errors
    // (bugs, internal errors), but not for compiler errors and such. For now,
    // the presence of `.file` serves as a heuristic to distinguish between
    // those cases.
    instantiationStack = formatInstantiationStack(builderNode)
  }
  var message = fileSnippet + originalError.message +
    (originalError.treeDir ? '\nin ' + originalError.treeDir : '') +
    '\nthrown from "' + builderNode.description + '"' +
    instantiationStack

  BuilderError.call(this, message)
  this.stack = originalError.stack

  // This error API can change between minor Broccoli version bumps
  this.broccoliPayload = {
    originalError: originalError,
    // node info
    nodeId: builderNode.id,
    nodeName: builderNode.pluginInterface.name,
    nodeAnnotation: builderNode.pluginInterface.annotation,
    instantiationStack: builderNode.pluginInterface.instantiationStack,
    // error location
    file: originalError.file,
    treeDir: originalError.treeDir,
    line: originalError.line,
    column: originalError.column
  }
}

Builder.BuilderNode = BuilderNode
function BuilderNode() {
}

BuilderNode.prototype.toString = function() {
  var hint
  if (this.pluginInterface.nodeType === 'transform') {
    hint = '"' + this.description + '"'
    if (this.inputBuilderNodes) { // a bit defensive to deal with partially-constructed builder nodes
      hint += ' inputBuilderNodes:[' + this.inputBuilderNodes.map(function(bn) { return bn.id }) + ']'
    }
    hint += ' at ' + this.outputPath
    if (this.buildState) {
      hint += ' (' + Math.round(this.buildState.selfTime) + ' ms)'
    }
  } else { // nodeType === 'source'
    hint = this.pluginInterface.sourceDirectory +
      (this.pluginInterface.watched ? '' : ' (unwatched)')
  }
  return '[BuilderNode:' + this.id + ' ' + hint + ']'
}

BuilderNode.prototype.toJSON = function() {
  return undefinedToNull({
    id: this.id,
    pluginInterface: pluginInterfaceToJSON(this.pluginInterface),
    buildState: this.buildState || null,
    description: this.description,
    inputBuilderNodes: this.inputBuilderNodes.map(function(bn) { return bn.id }),
    cachePath: this.cachePath,
    outputPath: this.outputPath
    // leave out node, originalNode, inputPaths (redundant), build
  })
}

function pluginInterfaceToJSON(pluginInterface) {
  if (pluginInterface.nodeType === 'transform') {
    return undefinedToNull({
      nodeType: 'transform',
      name: pluginInterface.name,
      annotation: pluginInterface.annotation,
      persistentOutput: pluginInterface.persistentOutput
      // leave out instantiationStack (too long), inputNodes, and callbacks
    })
  } else { // nodeType === 'source'
    return undefinedToNull({
      nodeType: 'source',
      sourceDirectory: pluginInterface.sourceDirectory,
      watched: pluginInterface.watched,
      name: pluginInterface.name,
      annotation: pluginInterface.annotation,
      // leave out instantiationStack
    })
  }
}

// Replace all `undefined` values with `null`, so that they show up in JSON output
function undefinedToNull(obj) {
  for (var key in obj) {
    if (obj.hasOwnProperty(key) && obj[key] === undefined) {
      obj[key] = null
    }
  }
  return obj
}

function wrapPrimitiveErrors(err) {
  if (err !== null && typeof err === 'object') {
    return err
  } else {
    // We could augment the message with " [string exception]" to indicate
    // that the stack trace is not useful, or even set the .stack to null.
    return new Error(err + '')
  }
}

function formatInstantiationStack(builderNode) {
  return '\n-~- instantiated here: -~-\n' + builderNode.pluginInterface.instantiationStack + '\n-~- (end) -~-'
}
