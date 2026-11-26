'use strict';

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const binary = value => typeof value === 'boolean' ? Number(value) : [0, 1].includes(value) ? value : undefined;
const attributeNumber = value => typeof value === 'string' && value.trim() ? numeric(Number(value)) : numeric(value);
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
    accuracy: numeric(position.accuracy), altitude: numeric(position.altitude), course: numeric(position.course),
    speed: speed === undefined ? undefined : Math.round(speed * 1852) / 1000,
    address: [position.address, attr.address].find(value => typeof value === 'string' && value.trim())?.trim() ?? '',
    geofence_ids: ids ? JSON.stringify(ids) : undefined,
    geofence_id: ids ? (ids[0] ?? 0) : undefined,
    power: attributeNumber(attr.power), battery: numeric(attr.battery),
    ignition: typeof attr.ignition === 'string' ? binary(attributeNumber(attr.ignition)) : binary(attr.ignition), motion: binary(attr.motion),
    engine_mode: typeof attr.astart === 'string' ? attr.astart : undefined,
    obd_speed: attributeNumber(attr.obdSpeed), rpm: numeric(attr.rpm),
    fuel: numeric(attr.fuel), odometer: numeric(attr.odometer),
    total_distance: numeric(attr.totalDistance),
    protocol: typeof position.protocol === 'string' ? position.protocol : undefined,
    attributes: JSON.stringify(attr)
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) *
    Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function selectPosition(points, mode, previous, now) {
  return points.find((point, index) => {
    if (!point || (mode && mode !== index + 1)) return false;
    const {latitude, longitude, fix_time: fix, server_time: received, speed, accuracy} = point;
    if (point.valid !== 1 || latitude === undefined || longitude === undefined ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (!latitude && !longitude) ||
        fix === undefined || received === undefined || fix > now + 300 || received > now + 300 ||
        now - Math.min(fix, received) > 300 || (speed ?? 0) > 200 || (accuracy ?? 0) > 100) {
      return false;
    }
    if (!previous) return true;
    const elapsed = Math.min(fix, received) - Math.min(previous.fix_time, previous.server_time);
    if (elapsed < -30) return false;
    return distanceKm(previous, point) <= Math.max(0.5, elapsed * 200 / 3600);
  });
}

function displayAddress(selected, points, mode) {
  if (selected?.address) return selected.address;
  const last = points.reduce((best, point, index) => {
    if (!point?.address || (mode && mode !== index + 1) || !Number.isFinite(point.fix_time)) return best;
    return !best || point.fix_time > best.fix_time ? point : best;
  }, undefined);
  return last ? 'Последний адрес: ' + last.address : '';
}

function driveValues(points, now, lastFix) {
  const [teltonika, pandora] = points;
  const candidates = [teltonika, pandora].map((point, index) => {
    if (!point || !Number.isFinite(point.fix_time) || now - point.fix_time > 300 ||
        point.fix_time > now + 30 || point.fix_time < lastFix) return undefined;
    const values = {};
    if (point.power !== undefined) values.drive_voltage = point.power;
    const gps = point.valid === 1 ? point.speed : undefined;
    const speed = [gps, point.obd_speed].find(value => Number.isFinite(value) && value >= 0 && value <= 200);
    if (speed !== undefined) values.drive_speed = speed;
    if (point.ignition !== undefined) values.drive_ignition = point.ignition;
    if (index === 1 && ['Ra', 'Rm'].includes(point.engine_mode)) values.drive_engine = 1;
    else if (point.ignition === 0 || (index === 1 && point.engine_mode === '')) values.drive_engine = 0;
    else if (index === 0 && point.ignition === 1 && point.obd_speed >= 13.5) values.drive_engine = 1;
    if (!Object.keys(values).length) return undefined;
    return {...values, drive_fix_time: point.fix_time, drive_source: index === 0 ? 'T' : 'P'};
  });
  const [tracker, cloud] = candidates;
  return tracker && (!cloud || tracker.drive_fix_time >= cloud.drive_fix_time) ? tracker : cloud;
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
  if (params.deviceId3 && !params.deviceId2) throw new Error('Сначала укажите второй трекер');
  const ids = [deviceId, ...[params.deviceId2, params.deviceId3]
    .map(value => String(value ?? '').trim())
    .filter(Boolean).map(Number)];
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new Error('Дополнительные ID должны быть уникальными положительными числами');
  }
  const mode = Number(params.sourceMode || 0);
  if (!Number.isInteger(mode) || mode < 0 || mode > ids.length) throw new Error('Проверьте режим источника');
  return {ids, mode, url: url.href.replace(/\/+$/, ''), deviceId, interval: interval * 1000, token};
}

function run(plugin, params, request = fetch) {
  const {url, ids, interval, token, mode: defaultMode} = options(params);
  let mode = defaultMode;
  let accepted;
  let points = [];
  const addressPoints = [];
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

  function sourceValues() {
    const selected = selectPosition(points, mode, accepted, Date.now() / 1000);
    if (selected) accepted = selected;
    return {
      source_mode: mode,
      set_source_mode: mode,
      source_device_id: selected?.sourceId ?? 0,
      source_ready: Number(Boolean(selected)),
      source_fix_time: selected?.fix_time ?? 0,
      source_latitude: selected?.latitude ?? 0,
      source_longitude: selected?.longitude ?? 0,
      source_address: selected?.address ?? '',
      project_address: displayAddress(selected, addressPoints, mode).replace(/,\s*(?:RU|Россия)$/i, ''),
      source_geofence_known: Number(selected?.geofence_ids !== undefined),
      source_geofence_ids: selected?.geofence_ids ?? '[]'
    };
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
      const latest = new Map();
      for (const position of positions) {
        if (!position || !ids.includes(position.deviceId)) continue;
        if (!latest.has(position.deviceId) || position.id > latest.get(position.deviceId).id) {
          latest.set(position.deviceId, position);
        }
      }
      lastError = '';
      const values = {online: 1};
      points = ids.map((id, index) => {
        const prefix = index ? 'tracker' + (index + 1) + '_' : '';
        const position = latest.get(id);
        values[prefix + 'has_position'] = Number(Boolean(position));
        if (!position) return undefined;
        const point = positionValues(position);
        for (const [key, value] of Object.entries(point)) values[prefix + key] = value;
        if (point.address && Number.isFinite(point.fix_time) &&
            (!addressPoints[index] || point.fix_time >= addressPoints[index].fix_time)) {
          addressPoints[index] = point;
        }
        return {...point, sourceId: id};
      });
      const source = sourceValues();
      if (channels.some(item => item.chan === 'drive_source')) {
        const drive = driveValues(points, Date.now() / 1000, state.drive_fix_time ?? 0);
        if (drive) Object.assign(values, drive);
        values.drive_speed = drive?.drive_speed ?? -1;
        if (source.source_ready && source.source_geofence_known) {
          const zones = JSON.parse(source.source_geofence_ids).filter(id => id > 0);
          values.project_geofence_id = zones.includes(state.project_geofence_id)
            ? state.project_geofence_id : (zones[0] ?? 0);
        }
      }
      publish({...values, ...source});
    } catch (error) {
      const message = /^(HTTP \d{3}|неожиданный формат ответа)$/.test(error.message)
        ? error.message : 'ошибка связи или чтения ответа';
      if (!stopped && message !== lastError) plugin.log('Traccar: ' + message);
      lastError = message;
      points = [];
      publish({online: 0, drive_speed: -1, has_position: 0, tracker2_has_position: 0,
        tracker3_has_position: 0, ...sourceValues()});
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
  plugin.onAct?.(message => {
    for (const action of message.data ?? []) {
      const binding = channels.find(item => item.id === action.id);
      const channel = binding?.chan ?? action.chan ?? action.devpropname ?? action.prop;
      if (channel !== 'set_source_mode' && !String(channel).endsWith('.set_source_mode')) continue;
      const raw = action.value;
      const next = typeof raw === 'number' || (typeof raw === 'string' && raw.trim())
        ? Number(raw) : NaN;
      if (!Number.isInteger(next) || next < 0 || next > ids.length) {
        plugin.log('Traccar: режим источника отклонён. Проверьте значение и ID трекеров.');
        continue;
      }
      mode = next;
      for (const item of channels) {
        if (item.chan === 'source_mode' || item.chan === 'set_source_mode') sent.delete(item.id);
      }
      publish(sourceValues());
      plugin.log('Traccar: применён режим источника ' + mode);
    }
  });
  plugin.onChange?.('channels', reloadChannels);
  void reloadChannels().then(tick);
  const timer = setInterval(tick, interval);
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = run;
module.exports.positionValues = positionValues;
module.exports.driveValues = driveValues;
module.exports.selectPosition = selectPosition;
