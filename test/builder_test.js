var fs = require('fs')
var os = require('os')
var rimraf = require('rimraf')
var RSVP = require('rsvp')
var broccoli = require('..')
var Builder = broccoli.Builder
var symlinkOrCopySync = require('symlink-or-copy').sync
var fixturify = require('fixturify')
var sinon = require('sinon')
var chai = require('chai'), expect = chai.expect
var chaiAsPromised = require('chai-as-promised'); chai.use(chaiAsPromised)
var sinonChai = require('sinon-chai'); chai.use(sinonChai)
var multidepPackages = require('multidep')('test/multidep.json')

var Plugin = multidepPackages['broccoli-plugin']['1.2.0']()
var broccoliSource = multidepPackages['broccoli-source']['1.1.0']()


// TODO:
// integration test against multiple plugin versions
// test persistent output



RSVP.on('error', function(error) {
  throw error
})

// Create various test plugins subclassing from Plugin. Used for testing
// against different Plugin versions.
function makePlugins(Plugin) {
  var plugins = {}

  // This plugin writes foo.js into its outputPath
  plugins.VeggiesPlugin = VeggiesPlugin
  VeggiesPlugin.prototype = Object.create(Plugin.prototype)
  VeggiesPlugin.prototype.constructor = VeggiesPlugin
  function VeggiesPlugin(inputNodes, options) {
    Plugin.call(this, [], options)
  }
  VeggiesPlugin.prototype.build = function() {
    fs.writeFileSync(this.outputPath + '/veggies.txt', 'tasty')
  }

  plugins.MergePlugin = MergePlugin
  MergePlugin.prototype = Object.create(Plugin.prototype)
  MergePlugin.prototype.constructor = MergePlugin
  function MergePlugin(inputNodes, options) {
    Plugin.call(this, inputNodes, options)
  }
  MergePlugin.prototype.build = function() {
    for (var i = 0; i < this.inputPaths.length; i++) {
      symlinkOrCopySync(this.inputPaths[i], this.outputPath + '/' + i)
    }
  }

  plugins.FailingBuildPlugin = FailingBuildPlugin
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
  plugins.AsyncPlugin = AsyncPlugin
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

  plugins.SleepingPlugin = SleepingPlugin
  SleepingPlugin.prototype = Object.create(Plugin.prototype)
  SleepingPlugin.prototype.constructor = SleepingPlugin
  function SleepingPlugin(inputNodes) {
    Plugin.call(this, inputNodes || [])
  }
  SleepingPlugin.prototype.build = function() {
    return new RSVP.Promise(function(resolve, reject) {
      setTimeout(resolve, 10)
    })
  }

  return plugins
}

// Make a default set of plugins with the latest Plugin version. In some tests
// we'll shadow this `plugins` variable with one created with different versions.
var plugins = makePlugins(Plugin)

function sleep() {
  return new RSVP.Promise(function(resolve, reject) {
    setTimeout(resolve, 10)
  })
}


// Builder subclass that returns fixturify objects from .build()
FixtureBuilder.prototype = Object.create(Builder.prototype)
FixtureBuilder.prototype.constructor = FixtureBuilder
function FixtureBuilder(/* ... */) {
  Builder.apply(this, arguments)
}

FixtureBuilder.prototype.build = function() {
  var self = this
  return Builder.prototype.build.call(this).then(function() {
    return fixturify.readSync(self.outputPath)
  })
}

function buildToFixture(node) {
  var fixtureBuilder = new FixtureBuilder(node)
  return fixtureBuilder.build().finally(fixtureBuilder.cleanup.bind(fixtureBuilder))
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
    multidepPackages['broccoli-plugin'].forEachVersion(function(version, Plugin) {
      var plugins = makePlugins(Plugin)

      describe('broccoli-plugin ' + version, function() {
        it('builds a single node, repeatedly', function() {
          var node = new plugins.VeggiesPlugin
          var buildSpy = sinon.spy(node, 'build')
          builder = new FixtureBuilder(node)
          return expect(builder.build()).to.eventually.deep.equal({ 'veggies.txt': 'tasty' })
            .then(function() {
              return expect(builder.build()).to.eventually.deep.equal({ 'veggies.txt': 'tasty' })
            })
            .then(function() {
              expect(buildSpy).to.have.been.calledTwice
            })
        })

        it('allows for asynchronous build', function() {
          var asyncNode = new plugins.AsyncPlugin()
          var outputNode = new plugins.MergePlugin([asyncNode])
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
          var src = new plugins.VeggiesPlugin
          var buildSpy = sinon.spy(src, 'build')
          var outputNode = new plugins.MergePlugin([src, src], { overwrite: true })
          return expect(buildToFixture(outputNode)).to.eventually.deep.equal({
            '0': { 'veggies.txt': 'tasty' },
            '1': { 'veggies.txt': 'tasty' }
          }).then(function() {
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
    })
  })

  describe('"source" nodes and strings', function() {
    multidepPackages['broccoli-source'].forEachVersion(function(version, broccoliSource) {
      describe('broccoli-source ' + version, function() {
        it('records unwatched source directories', function() {
          builder = new FixtureBuilder(new broccoliSource.UnwatchedDir('test/fixtures/basic'))
          expect(builder.watchedPaths).to.deep.equal([])
          expect(builder.unwatchedPaths).to.deep.equal(['test/fixtures/basic'])
          return expect(builder.build())
            .to.eventually.deep.equal({ 'foo.txt': 'OK' })
        })

        it('records watched source directories', function() {
          builder = new FixtureBuilder(new broccoliSource.WatchedDir('test/fixtures/basic'))
          expect(builder.watchedPaths).to.deep.equal(['test/fixtures/basic'])
          expect(builder.unwatchedPaths).to.deep.equal([])
          return expect(builder.build())
            .to.eventually.deep.equal({ 'foo.txt': 'OK' })
        })
      })
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
      builder = new FixtureBuilder(new plugins.MergePlugin([src, src]))
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
          new Builder(new plugins.MergePlugin([invalidNode], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got \[object Object\]\nused as input node to "MergePlugin: some annotation"\n-~- instantiated here: -~-/)
      })

      it('catches undefined input nodes', function() {
        // Very common subcase of invalid input nodes
        expect(function() {
          new Builder(new plugins.MergePlugin([undefined], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got undefined\nused as input node to "MergePlugin: some annotation"\n-~- instantiated here: -~-/)
      })

      it('catches .read/.rebuild-based root nodes', function() {
        expect(function() {
          new Builder(readBasedNode)
        }).to.throw(Builder.InvalidNodeError, /\.read\/\.rebuild API[^\n]*"an old node" as root node/)
      })

      it('catches .read/.rebuild-based input nodes', function() {
        expect(function() {
          new Builder(new plugins.MergePlugin([readBasedNode], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /\.read\/\.rebuild API[^\n]*"an old node"\nused as input node to "MergePlugin: some annotation"\n-~- instantiated here: -~-/)
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
      builder = new Builder(new plugins.VeggiesPlugin)
      // This can have false positives from other Broccoli instances, but it's
      // better than nothing, and better than trying to be sophisticated
      expect(hasBroccoliTmpDir(os.tmpdir())).to.be.true
    })

    it('creates temporary directory in directory given by tmpdir options', function() {
      builder = new Builder(new plugins.VeggiesPlugin, { tmpdir: 'test/tmp' })
      expect(hasBroccoliTmpDir('test/tmp')).to.be.true
    })

    it('removes temporary directory when .cleanup() is called', function() {
      builder = new Builder(new plugins.VeggiesPlugin, { tmpdir: 'test/tmp' })
      expect(hasBroccoliTmpDir('test/tmp')).to.be.true
      builder.cleanup()
      builder = null
      expect(hasBroccoliTmpDir('test/tmp')).to.be.false
    })

    describe('failing node setup', function() {
      // Failing node setup is rare, but it could happen if a plugin fails to
      // create some compiler instance
      FailingSetupPlugin.prototype = Object.create(Plugin.prototype)
      FailingSetupPlugin.prototype.constructor = FailingSetupPlugin
      function FailingSetupPlugin(errorObject) {
        Plugin.call(this, [])
        this.errorObject = errorObject
      }
      FailingSetupPlugin.prototype.getCallbackObject = function() {
        throw this.errorObject
      }

      it('reports failing node and instantiation stack, and cleans up temporary directory', function() {
        var node = new FailingSetupPlugin(new Error('foo error'))
        expect(function() {
          new Builder(node, { tmpdir: 'test/tmp' })
        }).to.throw(Builder.NodeSetupError, /foo error\nthrown from "FailingSetupPlugin"\n-~- instantiated here: -~-/)
        expect(hasBroccoliTmpDir('test/tmp')).to.be.false
      })

      it('supports string errors', function() {
        var node = new FailingSetupPlugin('bar error')
        expect(function() {
          new Builder(node, { tmpdir: 'test/tmp' })
        }).to.throw(Builder.NodeSetupError, /bar error\nthrown from "FailingSetupPlugin"\n-~- instantiated here: -~-/)
        expect(hasBroccoliTmpDir('test/tmp')).to.be.false
      })
    })

    describe('failing node build', function() {
      multidepPackages['broccoli-plugin'].forEachVersion(function(version, Plugin) {
        var plugins = makePlugins(Plugin)

        describe('broccoli-plugin ' + version, function() {
          it('rethrows as rich BuildError', function() {
            var originalError = new Error('whoops')
            originalError.file = 'somefile.js'
            originalError.treeDir = '/some/dir'
            originalError.line = 42
            originalError.column = 3
            originalError.randomProperty = 'is ignored'

            var node = new plugins.FailingBuildPlugin(originalError, { annotation: 'annotated' })
            // Wrapping in MergePlugin shouldn't make a difference. This way we
            // test that we don't have multiple catch clauses applying, wrapping
            // the error repeatedly
            node = new plugins.MergePlugin([node])
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

            builder = new Builder(new plugins.FailingBuildPlugin(originalError))
            return expect(builder.build()).to.be.rejectedWith(Builder.BuildError,
              /whoops\nthrown from "FailingBuildPlugin"\n-~- instantiated here: -~-/)
          })

          it('handles string errors', function() {
            builder = new Builder(new plugins.FailingBuildPlugin('string exception'))
            return expect(builder.build()).to.be.rejectedWith(Builder.BuildError, /string exception/)
          })

          it('handles undefined errors', function() {
            // Apparently this is a thing.
            builder = new Builder(new plugins.FailingBuildPlugin(undefined))
            return expect(builder.build()).to.be.rejectedWith(Builder.BuildError, /undefined/)
          })
        })
      })
    })
  })

  it('reports node timings', function() {
    var node1 = new plugins.SleepingPlugin(['test/fixtures/basic'])
    var node2 = new plugins.SleepingPlugin
    var outputNode = new plugins.SleepingPlugin([node1, node2])
    builder = new Builder(outputNode)
    return builder.build().then(function() {
      var sourceBn = builder.builderNodes[0]
      var bn1 = builder.builderNodes[1]
      var bn2 = builder.builderNodes[2]
      var outputBn = builder.builderNodes[3]

      expect(sourceBn.lastBuild.buildId).to.equal(1)
      expect(sourceBn.lastBuild.selfTime).to.equal(0)
      expect(sourceBn.lastBuild.totalTime).to.equal(0)

      expect(bn1.lastBuild.selfTime).to.be.greaterThan(0)
      expect(bn1.lastBuild.totalTime).to.equal(bn1.lastBuild.selfTime)
      expect(bn2.lastBuild.selfTime).to.be.greaterThan(0)
      expect(bn2.lastBuild.totalTime).to.equal(bn2.lastBuild.selfTime)

      expect(outputBn.lastBuild.selfTime).to.be.greaterThan(0)
      expect(outputBn.lastBuild.totalTime).to.equal(
        // addition order matters here, or rounding errors will occur
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
      builder = new Builder(new plugins.MergePlugin([new plugins.VeggiesPlugin, 'test/fixtures/basic']))
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
      builder = new Builder(new plugins.MergePlugin([new plugins.FailingBuildPlugin(new Error('whoops'))]))
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

  describe('builder nodes', function() {
    var watchedSourceBn, unwatchedSourceBn, transformBn

    beforeEach(function() {
      var watchedSourceNode = new broccoliSource.WatchedDir('test/fixtures/basic')
      var unwatchedSourceNode = new broccoliSource.UnwatchedDir('test/fixtures/basic')
      var transformNode = new plugins.MergePlugin([watchedSourceNode, unwatchedSourceNode], { overwrite: true })
      builder = new Builder(transformNode)
      watchedSourceBn = builder.builderNodes[0]
      unwatchedSourceBn = builder.builderNodes[1]
      transformBn = builder.builderNodes[2]
    })

    it('has .toString value useful for debugging', function() {
      expect(watchedSourceBn + '').to.equal('[BuilderNode:0 test/fixtures/basic]')
      expect(unwatchedSourceBn + '').to.equal('[BuilderNode:1 test/fixtures/basic (unwatched)]')
      expect(transformBn + '').to.match(/\[BuilderNode:2 "MergePlugin" inputBuilderNodes:\[0,1\] at .+\]/)

      // Reports timing after first build
      expect(transformBn + '').not.to.match(/\([0-9]+ ms\)/)
      return builder.build().then(function() {
        expect(transformBn + '').to.match(/\([0-9]+ ms\)/)
      })
    })

    it('has .toJSON representation useful for exporting for visualization', function() {
      expect(watchedSourceBn.toJSON()).to.deep.equal({
        id: 0,
        pluginInterface: {
          nodeType: 'source',
          sourceDirectory: 'test/fixtures/basic',
          watched: true,
          name: 'WatchedDir',
          annotation: null
        },
        description: 'WatchedDir',
        inputBuilderNodes: [],
        cachePath: null,
        outputPath: 'test/fixtures/basic',
        lastBuild: null
      })

      expect(transformBn.toJSON().lastBuild).to.be.null
      return builder.build().then(function() {
        var transformBnJSON = transformBn.toJSON()

        // Fuzzy matches first
        expect(transformBnJSON.cachePath).to.be.a('string')
        expect(transformBnJSON.outputPath).to.be.a('string')
        transformBnJSON.cachePath = '/some/path'
        transformBnJSON.outputPath = '/some/path'
        expect(transformBnJSON.lastBuild.buildId).to.be.a('number')
        expect(transformBnJSON.lastBuild.selfTime).to.be.a('number')
        expect(transformBnJSON.lastBuild.totalTime).to.be.a('number')
        transformBnJSON.lastBuild.buildId = 1
        transformBnJSON.lastBuild.selfTime = 1
        transformBnJSON.lastBuild.totalTime = 1

        expect(transformBnJSON).to.deep.equal({
          id: 2,
          pluginInterface: {
            nodeType: 'transform',
            name: 'MergePlugin',
            annotation: null,
            persistentOutput: false
          },
          lastBuild: {
            buildId: 1,
            selfTime: 1,
            totalTime: 1
          },
          description: 'MergePlugin',
          inputBuilderNodes: [ 0, 1 ],
          cachePath: '/some/path',
          outputPath: '/some/path'
        })
      })
    })
  })
})
