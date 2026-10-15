'use strict';

// Deterministic, offline embedding. No package installation, fetching or
// execution of vendor inputs. The Google deployment still has exactly 5 files.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const libraries = [
  { name: 'PASSWORD KDF', file: 'vendor/sjcl-password-kdf.js', targets: ['Code.gs'] },
  { name: 'MFA QR', file: 'vendor/nayuki-qr.js', targets: ['User.html', 'Admin.html', 'SuperAdmin.html'] }
];

function sync(checkOnly = false) {
  for (const library of libraries) {
    const source = fs.readFileSync(path.join(root, library.file), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    if (source.includes('</script')) throw new Error('Unsafe inline script boundary in ' + library.file);
    for (const target of library.targets) {
      const file = path.join(root, 'apps-script', target);
      const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const start = `/* BEGIN LOCAL ${library.name} */`;
      const end = `/* END LOCAL ${library.name} */`;
      if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('Missing/duplicate markers: ' + target);
      const from = text.indexOf(start) + start.length;
      const to = text.indexOf(end, from);
      if (to < from) throw new Error('Invalid markers: ' + target);
      const result = text.slice(0, from) + '\n' + source + '\n' + text.slice(to);
      if (checkOnly) {
        if (result !== text) throw new Error('Stale local library in ' + target);
      } else if (result !== text) fs.writeFileSync(file, result);
    }
  }
}

if (require.main === module) {
  sync(process.argv.includes('--check'));
  console.log('Local libraries ' + (process.argv.includes('--check') ? 'verified.' : 'embedded.'));
}
module.exports = { sync };
