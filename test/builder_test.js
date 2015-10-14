var fs = require('fs')
var path = require('path')
var os = require('os')
var rimraf = require('rimraf')
var RSVP = require('rsvp')
var broccoli = require('..')
var Builder = broccoli.Builder
var Plugin = require('broccoli-plugin')
var MergeTrees = require('broccoli-merge-trees')
var Fixturify = require('broccoli-fixturify')
var broccoliSource = require('broccoli-source')
var WatchedDir = broccoliSource.WatchedDir
var UnwatchedDir = broccoliSource.UnwatchedDir
var fixturify = require('fixturify')
var sinon = require('sinon')
var chai = require('chai'), expect = chai.expect
var chaiAsPromised = require('chai-as-promised'); chai.use(chaiAsPromised)
var sinonChai = require('sinon-chai'); chai.use(sinonChai)

RSVP.on('error', function(error) {
  throw error
})


CountingPlugin.prototype = Object.create(Plugin.prototype)
CountingPlugin.prototype.constructor = CountingPlugin
function CountingPlugin(inputNodes) {
  Plugin.call(this, inputNodes || [])
  this.buildCount = 0
}

CountingPlugin.prototype.build = function() {
  this.buildCount++
}


TaggingPlugin.prototype = Object.create(Plugin.prototype)
TaggingPlugin.prototype.constructor = TaggingPlugin
function TaggingPlugin(inputNodes, tag) {
  Plugin.call(this, inputNodes)
  this.tag = tag
  this.buildCount = 0
}

TaggingPlugin.prototype.build = function() {
  for (var i = 0; i < this.inputPaths.length; i++) {
    var entries = fs.readdirSync(this.inputPaths[i])
    for (var j = 0; j < entries.length; j++) {
      fs.writeFileSync(path.join(this.outputPath, entries[j]),
        this.tag + '(' + i + '): ' + fs.readFileSync(path.join(this.inputPaths[i])))
    }
  }
  this.buildCount++
}

FailingBuildPlugin.prototype = Object.create(Plugin.prototype)
FailingBuildPlugin.prototype.constructor = FailingBuildPlugin
function FailingBuildPlugin(errorObject, options) {
  Plugin.call(this, [], options)
  this.errorObject = errorObject
}
FailingBuildPlugin.prototype.build = function() {
  throw this.errorObject
}

// Plugin for testing asynchrony. buildFinished is a deferred (RSVP.defer()).
// The build will stall until you call node.finishBuild().
// To wait until the build starts, chain on node.buildStarted.
// Don't build more than once.
AsyncPlugin.prototype = Object.create(Plugin.prototype)
AsyncPlugin.prototype.constructor = AsyncPlugin
function AsyncPlugin(inputNodes) {
  Plugin.call(this, inputNodes || [])
  this.buildFinishedDeferred = RSVP.defer()
  this.buildStartedDeferred = RSVP.defer()
  this.buildStarted = this.buildStartedDeferred.promise
}
AsyncPlugin.prototype.build = function() {
  this.buildStartedDeferred.resolve()
  return this.buildFinishedDeferred.promise
}
AsyncPlugin.prototype.finishBuild = function() {
  this.buildFinishedDeferred.resolve()
}

SleepingPlugin.prototype = Object.create(Plugin.prototype)
SleepingPlugin.prototype.constructor = SleepingPlugin
function SleepingPlugin(inputNodes) {
  Plugin.call(this, inputNodes || [])
}
SleepingPlugin.prototype.build = function() {
  return new RSVP.Promise(function(resolve, reject) {
    setTimeout(resolve, 20)
  })
}


// function countingTree(readFn) {
//   return {
//     read: function(readTree) {
//       this.readCount++
//       return readFn.call(this, readTree)
//     },
//     readCount: 0,
//     cleanup: function() {
//       var self = this;

//       return RSVP.resolve()
//         .then(function() {
//           self.cleanupCount++
//         });
//     },
//     cleanupCount: 0
//   }
// }


// Builder subclass that returns fixturify objects from .build()
FixtureBuilder.prototype = Object.create(Builder.prototype)
FixtureBuilder.prototype.constructor = FixtureBuilder
function FixtureBuilder(/* ... */) {
  Builder.apply(this, arguments)
}

FixtureBuilder.prototype.build = function() {
  var self = this
  return Builder.prototype.build.call(this).then(function() {
    return fixturify.readSync(self.outputPath, { followSymlinks: true })
  })
}

function buildToFixture(node) {
  var fixtureBuilder = new FixtureBuilder(node)
  return fixtureBuilder.build().finally(fixtureBuilder.cleanup.bind(fixtureBuilder))
}

function sleep() {
  return new RSVP.Promise(function(resolve, reject) {
    setTimeout(resolve, 20)
  })
}


describe('Builder', function() {
  var builder

  afterEach(function() {
    if (builder) {
      return RSVP.resolve(builder.cleanup()).then(function() {
        builder = null
      })
    }
  })

  describe('"transform" nodes (.build)', function() {
    it('builds a single node, repeatedly', function() {
      var node = new Fixturify({ 'foo.txt': 'OK' })
      var buildSpy = sinon.spy(node, 'build')
      builder = new FixtureBuilder(node)
      return expect(builder.build()).to.eventually.deep.equal({ 'foo.txt': 'OK' })
        .then(function() {
          return expect(builder.build()).to.eventually.deep.equal({ 'foo.txt': 'OK' })
        })
        .then(function() {
          expect(buildSpy).to.have.been.calledTwice
        })
    })

    it('allows for asynchronous build', function() {
      var asyncNode = new AsyncPlugin()
      var outputNode = new MergeTrees([asyncNode])
      var buildSpy = sinon.spy(outputNode, 'build')
      builder = new Builder(outputNode)
      var buildPromise = builder.build()
      return asyncNode.buildStarted.then(sleep).then(function() {
        expect(buildSpy).not.to.have.been.called
        asyncNode.finishBuild()
      }).then(function() {
        return buildPromise
      }).then(function() {
        expect(buildSpy).to.have.been.called
      })
    })

    it('builds nodes reachable through multiple paths only once', function() {
      var src = new Fixturify({ 'foo.txt': 'OK' })
      var buildSpy = sinon.spy(src, 'build')
      var outputNode = new MergeTrees([src, src], { overwrite: true })
      return expect(buildToFixture(outputNode)).to.eventually.deep.equal({ 'foo.txt': 'OK' })
        .then(function() {
          expect(buildSpy).to.have.been.calledOnce
        })
    })

    it('supplies a cachePath', function() {
      // inputPath and outputPath are tested implicitly by the other tests,
      // but cachePath isn't, so we have this test case

      var cachePath

      TestPlugin.prototype = Object.create(Plugin.prototype)
      TestPlugin.prototype.constructor = TestPlugin
      function TestPlugin() {
        Plugin.call(this, [])
      }
      TestPlugin.prototype.build = function() {
        cachePath = this.cachePath
      }

      builder = new Builder(new TestPlugin)
      return builder.build()
        .then(function() {
          expect(cachePath).to.be.ok
          fs.accessSync(cachePath) // throws if it doesn't exist
        })
    })
  })

  describe('"source" nodes and strings', function() {
    it('records unwatched source directories', function() {
      builder = new FixtureBuilder(new UnwatchedDir('test/fixtures/basic'))
      expect(builder.watchedPaths).to.deep.equal([])
      expect(builder.unwatchedPaths).to.deep.equal(['test/fixtures/basic'])
      return expect(builder.build())
        .to.eventually.deep.equal({ 'foo.txt': 'OK' })
    })

    it('records watched source directories', function() {
      builder = new FixtureBuilder(new WatchedDir('test/fixtures/basic'))
      expect(builder.watchedPaths).to.deep.equal(['test/fixtures/basic'])
      expect(builder.unwatchedPaths).to.deep.equal([])
      return expect(builder.build())
        .to.eventually.deep.equal({ 'foo.txt': 'OK' })
    })

    it('records string (watched) source directories', function() {
      builder = new FixtureBuilder('test/fixtures/basic')
      expect(builder.watchedPaths).to.deep.equal(['test/fixtures/basic'])
      expect(builder.unwatchedPaths).to.deep.equal([])
      return expect(builder.build())
        .to.eventually.deep.equal({ 'foo.txt': 'OK' })
    })

    it('records source directories only once', function() {
      var src = 'test/fixtures/basic'
      builder = new FixtureBuilder(new MergeTrees([src, src]))
      expect(builder.watchedPaths).to.deep.equal(['test/fixtures/basic'])
    })
  })

  describe('error handling', function() {
    it('detects cycles', function() {
      // Cycles are quite hard to construct, so we make a special plugin
      CyclicalPlugin.prototype = Object.create(Plugin.prototype)
      CyclicalPlugin.prototype.constructor = CyclicalPlugin
      function CyclicalPlugin() {
        Plugin.call(this, [this]) // use `this` as input node
      }
      CyclicalPlugin.prototype.build = function() { }

      expect(function() {
        new Builder(new CyclicalPlugin)
      }).to.throw(Builder.BuilderError, 'Cycle in node graph: CyclicalPlugin -> CyclicalPlugin')
    })

    it('handles string exceptions in all sorts of places')

    describe('invalid nodes', function() {
      var invalidNode = { 'not a node': true }
      var readBasedNode = { read: function() { }, cleanup: function() { }, description: 'an old node' }

      it('catches invalid root nodes', function() {
        expect(function() {
          new Builder(invalidNode)
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got \[object Object\] as root node$/)
      })

      it('catches invalid input nodes', function() {
        expect(function() {
          new Builder(new MergeTrees([invalidNode], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got \[object Object\]\nused as input node to "BroccoliMergeTrees: some annotation"\n-~- instantiated here: -~-/)
      })

      it('catches undefined input nodes', function() {
        // Very common subcase of invalid input nodes
        expect(function() {
          new Builder(new MergeTrees([undefined], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got undefined\nused as input node to "BroccoliMergeTrees: some annotation"\n-~- instantiated here: -~-/)
      })

      it('catches .read/.rebuild-based root nodes', function() {
        expect(function() {
          new Builder(readBasedNode)
        }).to.throw(Builder.InvalidNodeError, /\.read\/\.rebuild API[^\n]*"an old node" as root node/)
      })

      it('catches .read/.rebuild-based input nodes', function() {
        expect(function() {
          new Builder(new MergeTrees([readBasedNode], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /\.read\/\.rebuild API[^\n]*"an old node"\nused as input node to "BroccoliMergeTrees: some annotation"\n-~- instantiated here: -~-/)
      })
    })
  })

  describe('temporary directories', function() {
    beforeEach(function() {
      rimraf.sync('test/tmp')
      fs.mkdirSync('test/tmp')
    })

    after(function() {
      rimraf.sync('test/tmp')
    })

    function hasBroccoliTmpDir(baseDir) {
      var entries = fs.readdirSync(baseDir)
      for (var i = 0; i < entries.length; i++) {
        if (/^broccoli-/.test(entries[i])) {
          return true
        }
      }
      return false
    }

    it('creates temporary directory in os.tmpdir() by default', function() {
      builder = new Builder(new Fixturify({}))
      // This can have false positives from other Broccoli instances, but it's
      // better than nothing, and better than trying to be sophisticated
      expect(hasBroccoliTmpDir(os.tmpdir())).to.be.true
    })

    it('creates temporary directory in directory given by tmpdir options', function() {
      builder = new Builder(new Fixturify({}), { tmpdir: 'test/tmp' })
      expect(hasBroccoliTmpDir('test/tmp')).to.be.true
    })

    it('removes temporary directory when .cleanup() is called', function() {
      builder = new Builder(new Fixturify({}), { tmpdir: 'test/tmp' })
      expect(hasBroccoliTmpDir('test/tmp')).to.be.true
      builder.cleanup()
      builder = null
      expect(hasBroccoliTmpDir('test/tmp')).to.be.false
    })

    describe('failing node setup', function() {
      FailingSetupPlugin.prototype = Object.create(Plugin.prototype)
      FailingSetupPlugin.prototype.constructor = FailingSetupPlugin
      function FailingSetupPlugin() {
        Plugin.call(this, [])
      }
      FailingSetupPlugin.prototype.getCallbackObject = function() {
        // This can happen if we tried to instantiate some compiler here
        throw new Error('foo error')
      }

      it('reports failing node and instantiation stack, and cleans up temporary directory', function() {
        var node = new FailingSetupPlugin
        expect(function() {
          new Builder(node, { tmpdir: 'test/tmp' })
        }).to.throw(Builder.NodeSetupError, /foo error\nthrown from "FailingSetupPlugin"\n-~- instantiated here: -~-/)
        expect(hasBroccoliTmpDir('test/tmp')).to.be.false
      })
    })

    describe('failing node build', function() {
      // function MyError(message) {
      //   this.message = message
      // }

      it('rethrows as rich BuildError', function() {
        var originalError = new Error('whoops')
        originalError.file = 'somefile.js'
        originalError.treeDir = '/some/dir'
        originalError.line = 42
        originalError.column = 3
        originalError.randomProperty = 'is ignored'

        var node = new FailingBuildPlugin(originalError, { annotation: 'annotated' })
        // Wrapping in MergeTrees shouldn't make a difference. This way we
        // test that we don't have multiple catch clauses applying, wrapping
        // the error repeatedly
        node = new MergeTrees([node])
        builder = new Builder(node)

        return builder.build()
          .then(function() {
            throw new Error('Expected an error')
          }, function(err) {
            expect(err).to.be.an.instanceof(Builder.BuildError)
            expect(err.stack).to.equal(originalError.stack, 'preserves original stack')

            expect(err.message).to.match(/somefile.js:42:4: whoops\nin \/some\/dir\nthrown from "FailingBuildPlugin: annotated"/)
            expect(err.message).not.to.match(/instantiated here/, 'suppresses instantiation stack when .file is supplied')

            expect(err.broccoliPayload.originalError).to.equal(originalError)

            // Reports offending node
            expect(err.broccoliPayload.nodeId).to.equal(0)
            expect(err.broccoliPayload.nodeName).to.equal('FailingBuildPlugin')
            expect(err.broccoliPayload.nodeAnnotation).to.equal('annotated')
            expect(err.broccoliPayload.instantiationStack).to.be.a('string')

            // Passes on special properties
            expect(err.broccoliPayload.file).to.equal('somefile.js')
            expect(err.broccoliPayload.treeDir).to.equal('/some/dir')
            expect(err.broccoliPayload.line).to.equal(42)
            expect(err.broccoliPayload.column).to.equal(3)
            expect(err.broccoliPayload).not.to.have.property('randomProperty')
          })
      })

      it('reports the instantiationStack when no err.file is given', function() {
        var originalError = new Error('whoops')

        builder = new Builder(new FailingBuildPlugin(originalError))
        return expect(builder.build()).to.be.rejectedWith(Builder.BuildError,
          /whoops\nthrown from "FailingBuildPlugin"\n-~- instantiated here: -~-/)
      })
    })
  })

  it('reports node timings', function() {
    var node1 = new SleepingPlugin(['test/fixtures/basic'])
    var node2 = new SleepingPlugin
    var outputNode = new SleepingPlugin([node1, node2])
    builder = new Builder(outputNode)
    return builder.build().then(function() {
      var sourceBn = builder.builderNodes[0]
      var bn1 = builder.builderNodes[1]
      var bn2 = builder.builderNodes[2]
      var outputBn = builder.builderNodes[3]

      expect(sourceBn.lastBuild.buildId).to.equal(0)
      expect(sourceBn.lastBuild.selfTime).to.equal(0)
      expect(sourceBn.lastBuild.totalTime).to.equal(0)

      expect(bn1.lastBuild.selfTime).to.be.greaterThan(0)
      expect(bn1.lastBuild.totalTime).to.equal(bn1.lastBuild.selfTime)
      expect(bn2.lastBuild.selfTime).to.be.greaterThan(0)
      expect(bn2.lastBuild.totalTime).to.equal(bn2.lastBuild.selfTime)

      expect(outputBn.lastBuild.selfTime).to.be.greaterThan(0)
      expect(outputBn.lastBuild.totalTime).to.equal(
        // addition order matters or rounding error will occur
        outputBn.lastBuild.selfTime + bn1.lastBuild.selfTime + bn2.lastBuild.selfTime
      )
    })
  })

  describe('event handling', function() {
    var events

    function setupEventHandlers() {
      events = []
      builder.on('start', function() { events.push('start') })
      builder.on('end', function() { events.push('end') })
      builder.on('nodeStart', function(bn) { events.push('nodeStart:' + bn.id) })
      builder.on('nodeEnd', function(bn) { events.push('nodeEnd:' + bn.id) })
    }

    it('triggers RSVP events', function() {
      builder = new Builder(new MergeTrees([new Fixturify({}), 'test/fixtures/basic']))
      setupEventHandlers()
      return builder.build()
        .then(function() {
          expect(events).to.deep.equal([
            'start',
            'nodeStart:0',
            'nodeEnd:0',
            'nodeStart:1',
            'nodeEnd:1',
            'nodeStart:2',
            'nodeEnd:2',
            'end'
          ])
        })
    })

    it('triggers matching nodeEnd event when a node fails to build', function() {
      builder = new Builder(new MergeTrees([new FailingBuildPlugin(new Error('whoops'))]))
      setupEventHandlers()
      return expect(builder.build()).to.be.rejected
        .then(function() {
          expect(events).to.deep.equal([
            'start',
            'nodeStart:0',
            'nodeEnd:0',
            'end'
          ])
        })
    })
  })

  // it('tree graph', function() {
  //   var parent = countingTree(function(readTree) {
  //     return readTree(child).then(function(dir) {
  //       return new RSVP.Promise(function(resolve, reject) {
  //         setTimeout(function() { resolve('parentTreeDir') }, 30)
  //       })
  //     })
  //   })

  //   var child = countingTree(function(readTree) {
  //     return readTree('srcDir').then(function(dir) {
  //       return new RSVP.Promise(function(resolve, reject) {
  //         setTimeout(function() { resolve('childTreeDir') }, 20)
  //       })
  //     })
  //   })

  //   var timeEqual = function(a, b) {
  //     expect(a).to.be.a('number')

  //     // do not run timing assertions in Travis builds
  //     // the actual results of process.hrtime() are not
  //     // reliable
  //     if (process.env.CI !== 'true') {
  //       expect(a).to.be.within(b - 5e6, b + 5e6)
  //     }
  //   }

  //   var builder = new Builder(parent)
  //   return builder.build().then(function(hash) {
  //     expect(hash.directory).to.equal('parentTreeDir')
  //     var parentNode = hash.graph
  //     expect(parentNode.directory).to.equal('parentTreeDir')
  //     expect(parentNode.tree).to.equal(parent)
  //     timeEqual(parentNode.totalTime, 50e6)
  //     timeEqual(parentNode.selfTime, 30e6)
  //     expect(parentNode.subtrees.length).to.equal(1)
  //     var childNode = parentNode.subtrees[0]
  //     expect(childNode.directory).to.equal('childTreeDir')
  //     expect(childNode.tree).to.equal(child)
  //     timeEqual(childNode.totalTime, 20e6)
  //     timeEqual(childNode.selfTime, 20e6)
  //     expect(childNode.subtrees.length).to.equal(1)
  //     var leafNode = childNode.subtrees[0]
  //     expect(leafNode.directory).to.equal('srcDir')
  //     expect(leafNode.tree).to.equal('srcDir')
  //     expect(leafNode.totalTime).to.equal(0)
  //     expect(leafNode.selfTime).to.equal(0)
  //     expect(leafNode.subtrees.length).to.equal(0)
  //   })
  // })
})
