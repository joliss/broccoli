var fs = require('fs')
var path = require('path')
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
var RSVP = require('rsvp')

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





describe('Builder', function() {
  // var builder

  // afterEach(function() {
  //   if (builder) {
  //     return RSVP.resolve(builder.cleanup()).then(function() {
  //       builder = null
  //     })
  //   }
  // })

  describe('"transform" nodes (.build)', function() {
    it('builds a single node', function() {
      var node = new Fixturify({ 'foo.txt': 'OK' })
      return expect(buildToFixture(node)).to.eventually.deep.equal({ 'foo.txt': 'OK' })
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
  })

  describe('"source" nodes and strings', function() {
    it('records unwatched source directories', function() {
      var builder = new FixtureBuilder(new UnwatchedDir('test/fixtures/basic'))
      expect(builder.watchedPaths).to.deep.equal([])
      expect(builder.unwatchedPaths).to.deep.equal(['test/fixtures/basic'])
      return expect(builder.build().finally(builder.cleanup.bind(builder)))
        .to.eventually.deep.equal({ 'foo.txt': 'OK' })
    })

    it('records watched source directories', function() {
      var builder = new FixtureBuilder(new WatchedDir('test/fixtures/basic'))
      expect(builder.watchedPaths).to.deep.equal(['test/fixtures/basic'])
      expect(builder.unwatchedPaths).to.deep.equal([])
      return expect(builder.build().finally(builder.cleanup.bind(builder)))
        .to.eventually.deep.equal({ 'foo.txt': 'OK' })
    })

    it('records string (watched) source directories', function() {
      var builder = new FixtureBuilder('test/fixtures/basic')
      expect(builder.watchedPaths).to.deep.equal(['test/fixtures/basic'])
      expect(builder.unwatchedPaths).to.deep.equal([])
      return expect(builder.build().finally(builder.cleanup.bind(builder)))
        .to.eventually.deep.equal({ 'foo.txt': 'OK' })
    })

    it('records source directories only once', function() {
      var src = 'test/fixtures/basic'
      var builder = new FixtureBuilder(new MergeTrees([src, src]))
      expect(builder.watchedPaths).to.deep.equal(['test/fixtures/basic'])
      return builder.cleanup()
    })
  })

  describe('error handling', function() {
    it('augments setup errors', function() {
      var node = new MergeTrees([{ 'not a node': true }])
      try {
        new Builder(node)
        throw new Error('expected error')
      } catch (err) {
        expect(err).to.have.property('errorType', 'init')
      }
    })
  })

  describe('timings', function() {
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
