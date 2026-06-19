const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Configura a pasta de cache do Puppeteer para ficar dentro do projeto
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};