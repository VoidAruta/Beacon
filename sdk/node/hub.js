/**
 * Совместимый алиас require('hub') -> require('beacon')
 */
if (!process.env._BEACON_HUB_WARNED) {
  process.env._BEACON_HUB_WARNED = '1';
  process.emitWarning(
    "Модуль 'hub' переименован в 'beacon'. Используйте require('beacon') (обратная совместимость сохранена).",
    'DeprecationWarning'
  );
}
module.exports = require('./beacon');
