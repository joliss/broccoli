'use strict'

var RSVP = require('rsvp')

var helpers = require('broccoli-kitchen-sink-helpers')


module.exports = Watcher
function Watcher(builder, options) {
  this.builder = builder
  this.options = options || {}
  this.treeHashes = []
  this.quitting = false
  this.initialBuildStarted = false

  this.check()
}

RSVP.EventTarget.mixin(Watcher.prototype)

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

  this.timeoutID = null
  // .check can be scheduled via setTimeout or via .then, so we cannot just
  // rely on clearTimeout
  if (this.quitting) return

  try {
    var interval = this.options.interval || 100
    var changedPaths = this.detectChanges()

    if (changedPaths.length > 0 || !this.initialBuildStarted) {
      this.initialBuildStarted = true
      this.currentBuild = this.builder.build()
        .then(function() {
          self.trigger('change')
        }, function(err) {
          self.trigger('error', err)
          throw err
        })
      this.currentBuild
        .catch(function(err) {
          // Ignore errors. If no promise is chained on this.currentBuild,
          // RSVP.on('error') might trigger; this .catch clause prevents that.
        })
        .then(function() {
          // Resume watching
          self.check()
        })
    } else {
      this.timeoutID = setTimeout(this.check.bind(this), interval)
    }
  } catch (err) {
    console.error('Uncaught error in Broccoli file watcher:')
    console.error(err.stack)
    console.error('Watcher quitting') // do not schedule check with setTimeout
  }
}

// You typically want to call watcher.quit().then()
Watcher.prototype.quit = function() {
  this.quitting = true
  if (this.timeoutID) {
    clearTimeout(this.timeoutID)
    this.timeoutID = null
  }
  return this.currentBuild.catch(function() { /* always fulfill, never reject */ })
}
