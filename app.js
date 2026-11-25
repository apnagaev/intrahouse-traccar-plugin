'use strict';

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const binary = value => typeof value === 'boolean' ? Number(value) : undefined;
const timestamp = value => typeof value === 'string' ? numeric(Date.parse(value) / 1000) : undefined;

function positionValues(position) {
  const attr = position.attributes ?? {};
  const geofences = position.geofenceIds ?? attr.geofenceIds;
  const ids = Array.isArray(geofences) ? geofences.filter(Number.isSafeInteger) : undefined;
  const speed = numeric(position.speed);
  const values = {
    position_id: numeric(position.id), fix_time: timestamp(position.fixTime),
    server_time: timestamp(position.serverTime), valid: binary(position.valid),
    latitude: numeric(position.latitude), longitude: numeric(position.longitude),
    altitude: numeric(position.altitude), course: numeric(position.course),
    speed: speed === undefined ? undefined : Math.round(speed * 1852) / 1000,
    address: typeof position.address === 'string' ? position.address : '',
    geofence_ids: ids ? JSON.stringify(ids) : undefined,
    geofence_id: ids ? (ids[0] ?? 0) : undefined,
    power: numeric(attr.power), battery: numeric(attr.battery),
    ignition: binary(attr.ignition), motion: binary(attr.motion),
    obd_speed: numeric(attr.obdSpeed), rpm: numeric(attr.rpm),
    fuel: numeric(attr.fuel), odometer: numeric(attr.odometer),
    total_distance: numeric(attr.totalDistance),
    protocol: typeof position.protocol === 'string' ? position.protocol : undefined,
    attributes: JSON.stringify(attr)
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function options(params) {
  const url = new URL(String(params.url ?? '').trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Укажите базовый URL Traccar без учётных данных и параметров');
  }
  const deviceId = Number(params.deviceId);
  const interval = Number(params.pollSeconds ?? 30);
  const token = String(params.token ?? '').trim();
  if (!Number.isSafeInteger(deviceId) || deviceId < 1 || !token ||
      !Number.isInteger(interval) || interval < 10 || interval > 600) {
    throw new Error('Укажите токен, числовой ID устройства и интервал 10–600 секунд');
  }
  return {url: url.href.replace(/\/+$/, ''), deviceId, interval: interval * 1000, token};
}

function run(plugin, params, request = fetch) {
  const {url, deviceId, interval, token} = options(params);
  const state = {};
  const sent = new Map();
  let channels = [];
  let stopped = false;
  let pending = false;
  let loadRevision = 0;
  let lastError = '';

  function publish(values) {
    if (stopped) return;
    Object.assign(state, values);
    const changes = channels.flatMap(({id, chan}) => Object.hasOwn(state, chan) &&
      sent.get(id) !== state[chan] ? [{id, value: state[chan]}] : []);
    if (!changes.length) return;
    plugin.sendData(changes);
    for (const {id, value} of changes) sent.set(id, value);
  }

  async function poll() {
    if (pending || stopped) return;
    pending = true;
    try {
      const response = await request(url + '/api/positions', {
        headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'},
        redirect: 'error',
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const positions = await response.json();
      if (!Array.isArray(positions)) throw new Error('неожиданный формат ответа');
      const position = positions.filter(point => point?.deviceId === deviceId)
        .sort((a, b) => b.id - a.id)[0];
      lastError = '';
      const values = {online: 1, has_position: Number(Boolean(position))};
      if (position) Object.assign(values, positionValues(position));
      publish(values);
    } catch (error) {
      const message = /^(HTTP \d{3}|неожиданный формат ответа)$/.test(error.message)
        ? error.message : 'ошибка связи или чтения ответа';
      if (!stopped && message !== lastError) plugin.log('Traccar: ' + message);
      lastError = message;
      publish({online: 0, has_position: 0});
    } finally {
      pending = false;
    }
  }

  async function reloadChannels() {
    const revision = ++loadRevision;
    try {
      const list = await plugin.channels.get();
      if (stopped || revision !== loadRevision) return;
      channels = list.filter(item => item.id && item.chan);
      sent.clear();
      publish({});
    } catch {
      if (!stopped) plugin.log('Traccar: не удалось загрузить каналы');
    }
  }

  const tick = () => poll().catch(() => plugin.log('Traccar: не удалось передать данные каналов'));
  plugin.onChange?.('channels', reloadChannels);
  void reloadChannels().then(tick);
  const timer = setInterval(tick, interval);
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = run;
module.exports.positionValues = positionValues;
