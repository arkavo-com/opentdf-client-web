'use strict';

const FileHound = require('filehound');
const fs = require('fs');

(async () => {
  const files = await FileHound.create()
    .paths([__dirname + '/dist/esm/src', __dirname + '/dist/esm/tdf3'])
    .discard('node_modules')
    .ext('js')
    .find((err, files) => {
      if (err || !files.length) {
        console.error('There is no ESM build folder.');
      }
      return files;
    });

  files.forEach((filepath) => {
    fs.readFile(filepath, 'utf8', (err, data) => {
      if (!data.match(/(?:import|export) .* from/g)) {
        return;
      }
      let newData = data
        .replace(/((?:import|export) .* from\s+['"])@tdfStream(?=['"])/, '$1./NodeTdfStream')
        .replace(/((?:import|export) .* from\s+['"])@readableStream(?=['"])/, '$1./stream-web-node')
        .replace(/((?:import|export) .* from\s+['"])([./].*)((?<!\.js)(?=['"]))/g, '$1$2.js');
      if (err) throw err;

      fs.writeFile(filepath, newData, function (err) {
        if (err) {
          throw err;
        }
      });
    });
  });
})();
