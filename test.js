var mktemp = require('mktemp');
 
mktemp
  .createFile('XXXXX.txt')
  .then(function(path) {
    // path match a /^[\da-zA-Z]{5}\.txt$/ 
    console.log(path);
  })
  .catch(function(err) {
    console.error(err);
  });
 
mktemp
  .createDir('XXXXX')
  .then(function(path) {
    // path match a /^[\da-zA-Z]{5}$/ 
    console.log(path);
  })
  .catch(function(err) {
    console.error(err);
  });
