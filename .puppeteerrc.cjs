const { join } = require('path');

module.exports = {
  // Define o caminho absoluto para o cache do Puppeteer no Render
  cacheDirectory: join('/opt/render/project/src', '.cache', 'puppeteer'),
};