'use strict'

var fs = require('fs')
var os = require('os')
var path = require('path')
var rimraf = require('rimraf')
var RSVP = require('rsvp')
var broccoli = require('..')
var Builder = broccoli.Builder
var Watcher = broccoli.Watcher
var symlinkOrCopySync = require('symlink-or-copy').sync
var fixturify = require('fixturify')
var sinon = require('sinon')
var chai = require('chai'), expect = chai.expect
var chaiAsPromised = require('chai-as-promised'); chai.use(chaiAsPromised)
var sinonChai = require('sinon-chai'); chai.use(sinonChai)
var multidepPackages = require('multidep')('test/multidep.json')

var Plugin = multidepPackages['broccoli-plugin']['1.2.0']()
var broccoliSource = multidepPackages['broccoli-source']['1.1.0']()


NoopPlugin.prototype = Object.create(Plugin.prototype)
NoopPlugin.prototype.constructor = NoopPlugin
function NoopPlugin(inputNodes) {
  Plugin.call(this, inputNodes)
}
NoopPlugin.prototype.build = function() {
}


describe('Watcher', function() {
  var builder

  beforeEach(function() {
    rimraf.sync('test/tmp')
    fs.mkdirSync('test/tmp')
    fs.mkdirSync('test/tmp/1')
    fs.mkdirSync('test/tmp/2')
    builder = new Builder(new NoopPlugin([
      new broccoliSource.WatchedDir('test/tmp/1'),
      new broccoliSource.WatchedDir('test/tmp/2')
    ]))
  })

  afterEach(function() {
    builder.cleanup()
    rimraf.sync('test/tmp')
  })

  it('registers added files', function() {
    var watcher = new Watcher(builder, { interval: 10 })
    var buildSpy = sinon.spy(builder, 'build')
    return watcher.then(function() {
      expect(buildSpy).to.have.been.calledOnce
    })
  })

  it('builds at least once')
})
