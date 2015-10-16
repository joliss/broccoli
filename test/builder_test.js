var fs = require('fs')
var os = require('os')
var path = require('path')
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
  function AsyncPlugin(inputNodes, options) {
    Plugin.call(this, inputNodes || [], options)
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

  describe('broccoli-plugin nodes (nodeType: "transform")', function() {
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

          CacheTestPlugin.prototype = Object.create(Plugin.prototype)
          CacheTestPlugin.prototype.constructor = CacheTestPlugin
          function CacheTestPlugin() {
            Plugin.call(this, [])
          }
          CacheTestPlugin.prototype.build = function() {
            expect(fs.existsSync(this.cachePath)).to.be.true
          }

          builder = new Builder(new CacheTestPlugin)
          return builder.build()
        })
      })
    })

    describe('persistentOutput flag', function() {
      multidepPackages['broccoli-plugin'].forEachVersion(function(version, Plugin) {
        if (version === '1.0.0') return // continue

        BuildOncePlugin.prototype = Object.create(Plugin.prototype)
        BuildOncePlugin.prototype.constructor = BuildOncePlugin
        function BuildOncePlugin(options) {
          Plugin.call(this, [], options)
        }

        BuildOncePlugin.prototype.build = function() {
          if (!this.builtOnce) {
            this.builtOnce = true
            fs.writeFileSync(path.join(this.outputPath, 'foo.txt'), 'test')
          }
        }

        function isPersistent(options) {
          var builder = new FixtureBuilder(new BuildOncePlugin(options))
          return builder.build()
            .then(function() {
              return builder.build()
            }).then(function(obj) {
              return obj['foo.txt'] === 'test'
            }).finally(function() {
              return builder.cleanup()
            })
        }

        describe('broccoli-plugin ' + version, function() {
          it('is not persistent by default', function() {
            return expect(isPersistent({})).to.be.eventually.false
          })

          it('is persistent with persistentOutput: true', function() {
            return expect(isPersistent({ persistentOutput: true })).to.be.eventually.true
          })
        })
      })
    })
  })

  describe('broccoli-source nodes (nodeType: "source") and strings', function() {
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

  describe('error handling in constructor', function() {
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
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got \[object Object\] as output node$/)
      })

      it('catches invalid input nodes', function() {
        expect(function() {
          new Builder(new plugins.MergePlugin([invalidNode], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got \[object Object\]\nused as input node to "MergePlugin: some annotation"\n-~- created here: -~-/)
      })

      it('catches undefined input nodes', function() {
        // Very common subcase of invalid input nodes
        expect(function() {
          new Builder(new plugins.MergePlugin([undefined], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /Expected Broccoli node, got undefined\nused as input node to "MergePlugin: some annotation"\n-~- created here: -~-/)
      })

      it('catches .read/.rebuild-based root nodes', function() {
        expect(function() {
          new Builder(readBasedNode)
        }).to.throw(Builder.InvalidNodeError, /\.read\/\.rebuild API[^\n]*"an old node" as output node/)
      })

      it('catches .read/.rebuild-based input nodes', function() {
        expect(function() {
          new Builder(new plugins.MergePlugin([readBasedNode], { annotation: 'some annotation' }))
        }).to.throw(Builder.InvalidNodeError, /\.read\/\.rebuild API[^\n]*"an old node"\nused as input node to "MergePlugin: some annotation"\n-~- created here: -~-/)
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
        }).to.throw(Builder.NodeSetupError, /foo error\nat "FailingSetupPlugin"\n-~- created here: -~-/)
        expect(hasBroccoliTmpDir('test/tmp')).to.be.false
      })

      it('supports string errors, and cleans up temporary directory', function() {
        var node = new FailingSetupPlugin('bar error')
        expect(function() {
          new Builder(node, { tmpdir: 'test/tmp' })
        }).to.throw(Builder.NodeSetupError, /bar error\nat "FailingSetupPlugin"\n-~- created here: -~-/)
        expect(hasBroccoliTmpDir('test/tmp')).to.be.false
      })
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

              expect(err.message).to.match(/somefile.js:42:4: whoops\nin \/some\/dir\nat "FailingBuildPlugin: annotated"/)
              expect(err.message).not.to.match(/created here/, 'suppresses instantiation stack when .file is supplied')

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
            /whoops\nat "FailingBuildPlugin"\n-~- created here: -~-/)
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

  describe('event handling', function() {
    var events

    function setupEventHandlers() {
      events = []
      builder.on('start', function() { events.push('start') })
      builder.on('end', function() { events.push('end') })
      builder.on('nodeStart', function(nh) { events.push('nodeStart:' + nh.id) })
      builder.on('nodeEnd', function(nh) { events.push('nodeEnd:' + nh.id) })
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

  describe('node handlers', function() {
    var watchedSourceNh, unwatchedSourceNh, transformNh

    beforeEach(function() {
      var watchedSourceNode = new broccoliSource.WatchedDir('test/fixtures/basic')
      var unwatchedSourceNode = new broccoliSource.UnwatchedDir('test/fixtures/basic')
      var transformNode = new plugins.MergePlugin([watchedSourceNode, unwatchedSourceNode], { overwrite: true })
      builder = new Builder(transformNode)
      watchedSourceNh = builder.nodeHandlers[0]
      unwatchedSourceNh = builder.nodeHandlers[1]
      transformNh = builder.nodeHandlers[2]
    })

    it('has .toString value useful for debugging', function() {
      expect(watchedSourceNh + '').to.equal('[NodeHandler:0 test/fixtures/basic]')
      expect(unwatchedSourceNh + '').to.equal('[NodeHandler:1 test/fixtures/basic (unwatched)]')
      expect(transformNh + '').to.match(/\[NodeHandler:2 "MergePlugin" inputNodeHandlers:\[0,1\] at .+\]/)

      // Reports timing after first build
      expect(transformNh + '').not.to.match(/\([0-9]+ ms\)/)
      return builder.build().then(function() {
        expect(transformNh + '').to.match(/\([0-9]+ ms\)/)
      })
    })

    it('has .toJSON representation useful for exporting for visualization', function() {
      expect(watchedSourceNh.toJSON()).to.deep.equal({
        id: 0,
        pluginInterface: {
          nodeType: 'source',
          sourceDirectory: 'test/fixtures/basic',
          watched: true,
          name: 'WatchedDir',
          annotation: null
        },
        label: 'WatchedDir',
        inputNodeHandlers: [],
        cachePath: null,
        outputPath: 'test/fixtures/basic',
        buildState: null
      })

      expect(transformNh.toJSON().buildState).to.be.null
      return builder.build().then(function() {
        var transformNhJSON = transformNh.toJSON()

        // Fuzzy matches first
        expect(transformNhJSON.cachePath).to.be.a('string')
        expect(transformNhJSON.outputPath).to.be.a('string')
        transformNhJSON.cachePath = '/some/path'
        transformNhJSON.outputPath = '/some/path'
        expect(transformNhJSON.buildState.selfTime).to.be.a('number')
        expect(transformNhJSON.buildState.totalTime).to.be.a('number')
        transformNhJSON.buildState.selfTime = 1
        transformNhJSON.buildState.totalTime = 1

        expect(transformNhJSON).to.deep.equal({
          id: 2,
          pluginInterface: {
            nodeType: 'transform',
            name: 'MergePlugin',
            annotation: null,
            persistentOutput: false
          },
          buildState: {
            selfTime: 1,
            totalTime: 1
          },
          label: 'MergePlugin',
          inputNodeHandlers: [ 0, 1 ],
          cachePath: '/some/path',
          outputPath: '/some/path'
        })
      })
    })

    describe('buildState', function() {
      it('reports node timings', function() {
        var node1 = new plugins.SleepingPlugin(['test/fixtures/basic'])
        var node2 = new plugins.SleepingPlugin
        var outputNode = new plugins.SleepingPlugin([node1, node2])
        builder = new Builder(outputNode)
        return builder.build().then(function() {
          var sourceNh = builder.nodeHandlers[0]
          var nh1 = builder.nodeHandlers[1]
          var nh2 = builder.nodeHandlers[2]
          var outputNh = builder.nodeHandlers[3]

          expect(sourceNh.buildState.selfTime).to.equal(0)
          expect(sourceNh.buildState.totalTime).to.equal(0)

          expect(nh1.buildState.selfTime).to.be.greaterThan(0)
          expect(nh1.buildState.totalTime).to.equal(nh1.buildState.selfTime)
          expect(nh2.buildState.selfTime).to.be.greaterThan(0)
          expect(nh2.buildState.totalTime).to.equal(nh2.buildState.selfTime)

          expect(outputNh.buildState.selfTime).to.be.greaterThan(0)
          expect(outputNh.buildState.totalTime).to.equal(
            // addition order matters here, or rounding errors will occur
            outputNh.buildState.selfTime + nh1.buildState.selfTime + nh2.buildState.selfTime
          )
        })
      })
    })
  })
})
