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
// builder node
// root node
// expected vs unexpected build error
// node description


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
}

Builder.prototype.build = function() {
  var promise = RSVP.resolve()
  this.builderNodes.forEach(function(bn) {
    // We use .forEach instead of for to close nested functions over `bn`
    if (bn.pluginInterface.nodeType !== 'transform') return // continue
    if (!bn.pluginInterface.persistentOutput) {
      promise = promise.then(function() {
        rimraf.sync(bn.outputPath)
        fs.mkdirSync(bn.outputPath)
      })
    }
    // TODO timings
    // TODO trigger all sorts of events
    promise = promise.then(function() {
      bn.build()
    }).catch(function(err) {
      throw new BuildError(err, bn)
    })
  })
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
      throw new InvalidNodeError(message + '\nused as input node to "' + formatNode(_stack[_stack.length-1]) +'"' +
        formatInstantiationStack(_stack[_stack.length-1])
      )
    } else {
      throw new InvalidNodeError(message + ' as root node') // TODO "root node" wording
    }
  }

  var pluginInterface = this.getPluginInterface(node)

  // We start constructing the builderNode here because we'll need the partial
  // builderNode for the _stack. Later we'll add more properties.
  var builderNode = {
    pluginInterface: pluginInterface,
    originalNode: originalNode,
    node: node
  }
  builderNode.description = formatNode(builderNode)

  // Detect cycles
  for (i = 0; i < _stack.length; i++) {
    if (_stack[i].node === originalNode) {
      var cycleMessage = 'Cycle in node graph: '
      for (var j = i; j < _stack.length; j++) {
        cycleMessage += formatNode(_stack[j]) + ' -> '
      }
      cycleMessage += formatNode(builderNode)
      throw new BuilderError(cycleMessage)
    }
  }

  // Recurse into the input nodes of 'transform' nodes, and record paths for
  // 'source' nodes
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
  // feature set (`this.features`) rather than the smaller feature-set we're
  // mimicking (`features`). This is a fairly arbitrary choice, but it usually
  // won't make a difference, because the Plugin class won't care about
  // features it doesn't know about.
  var pluginInterface = node.__broccoliGetInfo__(this.features)

  // Augment the interface with the new features that the plugin doesn't support
  for (; i < augmenters.length; i++) {
    var fn = augmenters[i][1]
    // Use prototypal inheritance to avoid mutating other people's objects
    pluginInterface = Object.create(pluginInterface)
    fn(pluginInterface)
  }

  return pluginInterface
}

Builder.prototype.setupTmpDirs = function() {
  // TODO: maybe use the following structure instead:
  //  01/
  //    out/
  //    cache/
  //    in-01 -> ...
  //    in-02 -> ...
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
      builderNode.outputPath = builderNode.pluginInterface.sourceDirectory
    }
  }
}

Builder.prototype.mkTmpDir = function(builderNode, type) {
  var suffix = underscoreString.slugify(builderNode.description.substr(0, 60))
    .replace('-', '_')
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

Builder.prototype.makeError = function(err, errorType, builderNode) {
  // Strip all but allowed properties from error object
  //
  // This method will have to be feature-flag-aware at some point. I haven't
  // yet figured out the nicest way to make this happen. -JL
  var newErr = new Error(err.message)
  newErr.stack = err.stack

  newErr.errorType = errorType // 'setup' or 'build'
  if (errorType === 'build') {
    newErr.file = err.file
    newErr.treeDir = err.treeDir
    newErr.line = err.line
    newErr.column = err.column
  }

  newErr.builderNode = builderNode
  newErr.instantiationStack = builderNode.pluginInterface.instantiationStack
  newErr.nodeDescription = builderNode.description

  return newErr
}




// function wrapStringErrors(reason) {
//   var err

//   if (typeof reason === 'string') {
//     err = new Error(reason + ' [string exception]')
//   } else {
//     err = reason
//   }

//   throw err
// }

// function summarize(node) {
//   return {
//     graph: node,
//     totalTime: node.totalTime
//   }
// }

RSVP.EventTarget.mixin(Builder.prototype)

// Builder.prototype.oldbuild = function() {
//   var builder = this

//   var newTreesRead = []
//   var nodeCache = []

//   return RSVP.Promise.resolve()
//     .then(function () {
//       builder.trigger('start')
//       return readAndReturnNodeFor(builder.tree) // call builder.tree.read()
//     })
//     .then(summarize)
//     .finally(appendNewTreesRead)
//     .finally(function() {
//       builder.trigger('end')
//     })
//     .catch(wrapStringErrors)

//   // Read the `tree` and return its node, which in particular contains the
//   // tree's output directory (node.directory)
//   function readAndReturnNodeFor (tree) {
//     builder.warnIfNecessary(tree)
//     tree = builder.wrapIfNecessary(tree)
//     var index = newTreesRead.indexOf(tree)
//     if (index !== -1) {

//       // Return node from cache to deduplicate `.read`
//       if (nodeCache[index].directory == null) {
//         // node.directory gets set at the very end, so we have found an as-yet
//         // incomplete node. This can happen if there is a cycle.
//         throw new Error('Tree cycle detected')
//       }
//       return RSVP.Promise.resolve(nodeCache[index])
//     }

//     var node = new Node(tree)

//     builder.trigger('nodeStart', node)

//     // we don't actually support duplicate trees, as such we should likely tag them..
//     // and kill the parallel array structure
//     newTreesRead.push(tree)
//     nodeCache.push(node)

//     var treeDirPromise

//     if (typeof tree === 'string') {
//       treeDirPromise = RSVP.Promise.resolve()
//         .then(function () {
//           if (willReadStringTree) willReadStringTree(tree)
//           return tree
//         })
//     } else if (!tree || (typeof tree.read !== 'function' && typeof tree.rebuild !== 'function')) {
//       throw new Error('Invalid tree found. You must supply a path or an object with a `.read` (deprecated) or `.rebuild` function: ' + getDescription(tree))
//     } else {
//       var now = process.hrtime()
//       var totalStartTime = now
//       var selfStartTime = now
//       var readTreeRunning = false
//       treeDirPromise = RSVP.Promise.resolve()
//         .then(function () {
//           return tree.read(function readTree (subtree) {
//             if (readTreeRunning) {
//               throw new Error('Parallel readTree call detected; read trees in sequence, e.g. using https://github.com/joliss/promise-map-series')
//             }
//             readTreeRunning = true

//             // Pause builder timer
//             var now = process.hrtime()
//             node.selfTime += (now[0] - selfStartTime[0]) * 1e9 + (now[1] - selfStartTime[1])
//             selfStartTime = null

//             return RSVP.Promise.resolve()
//               .then(function () {
//                 return readAndReturnNodeFor(subtree) // recurse
//               })
//               .then(function (childNode) {
//                 node.addChild(childNode)
//                 return childNode.directory
//               })
//               .finally(function () {
//                 readTreeRunning = false
//                 // Resume self timer
//                 selfStartTime = process.hrtime()
//               })
//           })
//         })
//         .then(function (dir) {
//           if (readTreeRunning) {
//             throw new Error('.read returned before readTree finished')
//           }

//           var now = process.hrtime()
//           node.selfTime += (now[0] - selfStartTime[0]) * 1e9 + (now[1] - selfStartTime[1])
//           node.totalTime += (now[0] - totalStartTime[0]) * 1e9 + (now[1] - totalStartTime[1])
//           return dir
//         })
//     }

//     return treeDirPromise
//       .then(function (treeDir) {
//         builder.trigger('nodeEnd', node)
//         if (treeDir == null) throw new Error(tree + ': .read must return a directory')
//         node.directory = treeDir
//         return node
//       })
//   }
// }

// function cleanupTree(tree) {
//   if (typeof tree !== 'string') {
//     return tree.cleanup()
//   }
// }

// Builder.prototype.wrapIfNecessary = function (tree) {
//   if (typeof tree.rebuild === 'function') {
//     // Note: We wrap even if the plugin provides a `.read` function, so that
//     // its new `.rebuild` function gets called.
//     if (!tree.wrappedTree) { // memoize
//       tree.wrappedTree = new apiCompat.NewStyleTreeWrapper(tree)
//     }
//     return tree.wrappedTree
//   } else {
//     return tree
//   }
// }

// Builder.prototype.warnIfNecessary = function (tree) {
//   if (process.env.BROCCOLI_WARN_READ_API &&
//       (typeof tree.read === 'function' || typeof tree.rebuild === 'function') &&
//       !tree.__broccoliFeatures__ &&
//       !tree.suppressDeprecationWarning) {
//     if (!this.didPrintWarningIntro) {
//       console.warn('[API] Warning: The .read and .rebuild APIs will stop working in the next Broccoli version')
//       console.warn('[API] Warning: Use broccoli-plugin instead: https://github.com/broccolijs/broccoli-plugin')
//       this.didPrintWarningIntro = true
//     }
//     console.warn('[API] Warning: Plugin uses .read/.rebuild API: ' + getDescription(tree))
//     tree.suppressDeprecationWarning = true
//   }
// }


// var nodeId = 0

// function Node(tree) {
//   this.id = nodeId++
//   this.subtrees = []
//   this.selfTime = 0
//   this.totalTime = 0
//   this.tree = tree
//   this.parents = []
// }

// Node.prototype.addChild = function Node$addChild(child) {
//   this.subtrees.push(child)
// }

// Node.prototype.inspect = function() {
//   return 'Node:' + this.id +
//     ' subtrees: ' + this.subtrees.length +
//     ' selfTime: ' + this.selfTime +
//     ' totalTime: ' + this.totalTime
// }

// Node.prototype.toJSON = function() {
//   var description = getDescription(this.tree)
//   var subtrees = this.subtrees.map(function(node) {
//     return node.id
//   })

//   return {
//     id: this.id,
//     description: description,
//     subtrees: subtrees,
//     selfTime: this.selfTime,
//     totalTime: this.totalTime
//   }
// }


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
  if (originalError == null) { // Chai calls new NodeSetupError() :(
    BuilderError.call(this)
    return
  }
  var message = originalError.message +
    '\nthrown from "' + formatNode(builderNode) + '"' +
    formatInstantiationStack(builderNode)
  BuilderError.call(this, message)
  // The stack will have the original exception name, but that's OK
  this.stack = originalError.stack
}

Builder.BuildError = BuildError
BuildError.prototype = Object.create(BuilderError.prototype)
BuildError.prototype.constructor = BuildError
function BuildError(originalError, builderNode) {
  if (originalError == null) { // for Chai
    BuilderError.call(this)
    return
  }

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
    '\nthrown from "' + formatNode(builderNode) + '"' +
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

// Error that relates to a specific node
// NodeError.prototype = Object.create(BuilderError.prototype)
// NodeError.prototype.constructor = NodeError
// function NodeError(builderNode, message) {
//   BuilderError.call(this, message)
//   this.broccoliNodeInstantiationStack = builderNode.pluginInterface.instantiationStack
//   this.broccoliNodeDescription = builderNode.description
//   this.broccoliMessage = message
// }

// Error while initializing node. This class will include the instantiation
// stack in the message.
// NodeInitError.prototype = Object.create(NodeError.prototype)
// NodeInitError.prototype.constructor = NodeInitError
// function NodeInitError(builderNode, message) {
//   NodeError.call(builderNode, message)
//   this.message = this.broccoliMessage + \
//     '\n-~- instantiated here: -~-\n' + this.broccoliNodeInstantiationStack + '-~---~-'
// }

// InvalidNodeError.prototype = Object.create(BuilderError.prototype)
// InvalidNodeError.prototype.constructor = InvalidNodeError
// function InvalidNodeError(parentBuilderNode, childNode, message) {
//   BuilderError.call(this)
//   this.broccoliNodeInstantiationStack = parentBuilderNode.pluginInterface.instantiationStack
//   this.broccoliNodeDescription = parentBuilderNode.description
//   this.broccoliChildNode = childNode
//   this.broccoliMessage = message
//   this.message = 'The node "..." received an invalid input node: ...'
// }


// Builder.BuilderInitError = BuilderInitError
// BuilderInitError.prototype = Object.create(BuilderError.prototype)
// BuilderInitError.prototype.constructor = BuilderInitError
// function BuilderInitError(message) {
//   BuilderError.call(this, message)
// }

function formatNode(builderNode) {
  // TODO: if nodeType === 'source', extract sourceDirectory
  var pluginInterface = builderNode.pluginInterface
  var s = pluginInterface.name
  if (pluginInterface.annotation != null) s += ': ' + pluginInterface.annotation
  return s
}

function formatInstantiationStack(builderNode) {
  return '\n-~- instantiated here: -~-\n' + builderNode.pluginInterface.instantiationStack + '\n-~- (end) -~-'
}
