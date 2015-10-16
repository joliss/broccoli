'use strict'

var EventEmitter = require('events').EventEmitter

var helpers = require('broccoli-kitchen-sink-helpers')
var printSlowTrees = require('broccoli-slow-trees')


module.exports = Watcher
Watcher.prototype = Object.create(EventEmitter.prototype)
Watcher.prototype.constructor = Watcher
function Watcher(builder, options) {
  this.builder = builder
  this.options = options || {}
  this.treeHashes = []

  this.check()
}

Watcher.prototype.detectChanges = function () {
  var changedPaths = []

  for (var i = 0; i < this.builder.watchedPaths.length; i++) {
    var hash = helpers.hashTree(this.builder.watchedPaths[i])
    if (hash !== this.treeHashes[i]) {
      changedPaths.push(this.builder.watchedPaths[i])
      this.treeHashes[i] = hash
    }
  }

  return changedPaths
}

Watcher.prototype.check = function() {
  var self = this

  try {
    var interval = this.options.interval || 100
    var changedPaths = this.detectChanges()

    if (changedPaths.length > 0) {
      this.current = this.builder.build()
      this.current.then(function() {
        if (this.options.verbose) {
          printSlowTrees(hash.graph)
        }
        this.emit('change', hash)
      }.bind(this), function(err) {
        this.emit('error', err)
        if (Object.keys(self.watchedDirs).length === 0) {
          console.error('An error occured before the first directory could be watched.')
          console.error('Watcher quitting')
          throw new Error('Error too early') // skip scheduling this.check
        }
      }.bind(this))
      .then(this.check.bind(this), function(err) {
        // Errors here are usually due to errors in change/error event handlers
        console.error('An unexpected error occurred. Watcher quitting.')
        console.error(err.stack)
        // Rethrow in case a debugging tool wants to catch it
        throw err
      })
    } else {
      setTimeout(this.check.bind(this), interval)
    }
  } catch (err) {
    console.error('Uncaught error in Broccoli file watcher:')
    console.error(err.stack)
    console.error('Watcher quitting') // do not schedule check with setTimeout
  }
}

Watcher.prototype.then = function(success, fail) {
  return this.current.then(success, fail)
}
