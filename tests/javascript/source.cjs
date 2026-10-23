const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../src/ink_viewer/web');
const sourcePath = name => path.join(root, name === 'index.html' ? name : 'js/' + name);
const read = name => fs.readFileSync(sourcePath(name), 'utf8');
module.exports = {read, sourcePath, root};
