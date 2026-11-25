'use strict';

const path = require('path');

function readToken(plugin, params) {
  const token = params.ppw_token && plugin.getPassword
    ? plugin.getPassword(params, 'token')
    : params.token;
  const value = typeof token === 'string' ? token.trim() : '';
  return /^\$\{[^}]+\}$/.test(value) ? '' : value;
}

async function main() {
  let plugin;
  try {
    const options = JSON.parse(process.argv[2]);
    plugin = require(path.join(options.pluginapi, 'index.js'))();
    const params = await plugin.params.get();
    const token = readToken(plugin, params);
    if (!token) throw new Error('Токен Traccar отсутствует. Сохраните его в параметрах экземпляра.');
    require('./app')(plugin, {...params, token});
  } catch (error) {
    const message = 'Traccar: ' + error.message;
    if (plugin) {
      plugin.exit(8, message);
    } else {
      if (process.send) process.send({ type: 'debug', txt: message });
      else console.error(message);
      process.exitCode = 8;
      if (process.connected) process.disconnect();
    }
  }
}

if (require.main === module) main();
