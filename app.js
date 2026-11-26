'use strict';

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const binary = value => typeof value === 'boolean' ? Number(value) : [0, 1].includes(value) ? value : undefined;
const attributeNumber = value => typeof value === 'string' && value.trim() ? numeric(Number(value)) : numeric(value);
function timestamp(value) {
  if (typeof value === 'string' && value.trim()) return numeric(Date.parse(value) / 1000);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value >= 1e12 ? value / 1000 : value;
}

function pointValues(position, trackerIndex) {
  const attrs = position.attributes ?? {};
  const deviceId = Number(position.deviceId);
  const serverTime = timestamp(position.serverTime);
  if (!(serverTime > 0)) return;
  const latitude = attributeNumber(position.latitude);
  const longitude = attributeNumber(position.longitude);
  const gpsValid = binary(position.valid) === 1 && Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 && Boolean(latitude || longitude);
  const gpsSpeed = gpsValid ? attributeNumber(position.speed) : undefined;
  const obdSpeed = attributeNumber(attrs.obdSpeed);
  const rpm = attributeNumber(attrs.rpm ?? attrs.engineRpm);
  const zones = position.geofenceIds ?? attrs.geofenceIds;
  const geofences = Array.isArray(zones) ? zones.map(attributeNumber).filter(id => Number.isSafeInteger(id) && id > 0) : undefined;
  const ignition = binary(attrs.ignition) ?? binary(attributeNumber(attrs.ignition));
  const engineRunning = ['Ra', 'Rm'].includes(attrs.astart) ? true
    : rpm !== undefined ? rpm > 0 : ignition === 0 ? false : undefined;
  return {
    deviceId, serverTime, raw: position, positionId: Number(position.id) || 0,
    fields: {
      latitude: gpsValid ? latitude : undefined,
      longitude: gpsValid ? longitude : undefined,
      address: [position.address, attrs.address].find(value => typeof value === 'string' && value.trim())?.trim(),
      geofences,
      speed: gpsSpeed >= 0 ? Math.round(gpsSpeed * 1852) / 1000 : obdSpeed >= 0 ? obdSpeed : undefined,
      voltage: attributeNumber(attrs.power),
      ignition,
      motion: binary(attrs.motion) ?? binary(attributeNumber(attrs.motion)),
      rpm,
      engineRunning,
      engineTemp: attributeNumber(attrs.engine_temp ?? attrs.engineTemp),
      coolantTemp: attributeNumber(attrs.coolant_temp ?? attrs.coolantTemp),
      cabinTemp: attributeNumber(attrs.cabin_temp ?? attrs.cabinTemp),
      intakeTemp: attributeNumber(attrs.intake_air_temp ?? attrs.intakeTemp),
      throttle: attributeNumber(attrs.throttle_position ?? attrs.throttle),
      fuel: attributeNumber(attrs.fuelLitres ?? (trackerIndex === 1 ? attrs.fuel : undefined)),
      fuelAverage: attributeNumber(attrs.fuel_average),
      fuelRange: attributeNumber(attrs.fuel_range),
      fuelDistance: attributeNumber(attrs.fuel_distance),
      eco: attributeNumber(attrs.ECO ?? attrs.eco),
      odometerKm: attributeNumber(attrs.odometer) === undefined ? undefined : Number(attrs.odometer) / 1000
    }
  };
}

function compare(a, b) {
  return b.serverTime - a.serverTime || b.positionId - a.positionId || a.deviceId - b.deviceId;
}

function snapshot(points, ids, mode, now, status) {
  const newest = [...points.values()].sort(compare);
  const preferred = mode === 0 ? newest[0] : points.get(ids[mode - 1]);
  const candidates = preferred ? [preferred, ...newest.filter(point => point !== preferred)] : newest;
  const primary = candidates[0];
  const result = {
    mode, online: status.online, error: status.error,
    trackers: ids.map(id => ({id, serverTime: points.get(id)?.serverTime ?? null})),
    deviceId: primary?.deviceId, timestamp: primary?.serverTime,
    fresh: Boolean(status.online && primary && Math.abs(now - primary.serverTime) <= 300),
    sources: {}
  };
  for (const point of candidates) {
    for (const [property, value] of Object.entries(point.fields)) {
      if (value === undefined || Object.hasOwn(result, property)) continue;
      result[property] = value;
      result.sources[property] = point.deviceId;
    }
  }
  return result;
}

function options(params) {
  const url = new URL(String(params.url ?? '').trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Укажите базовый URL Traccar без учётных данных и параметров');
  }
  const input = String(params.trackerIds ?? '').trim() || [params.deviceId, params.deviceId2, params.deviceId3].filter(Boolean).join(',');
  const ids = input.split(',').map(value => Number(value.trim()));
  const interval = Number(params.pollSeconds ?? 30);
  const token = String(params.token ?? '').trim();
  if (!token ||
      !Number.isInteger(interval) || interval < 10 || interval > 600) {
    throw new Error('Укажите токен, числовой ID устройства и интервал 10–600 секунд');
  }
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new Error('Дополнительные ID должны быть уникальными положительными числами');
  }
  const mode = Number(params.sourceMode || 0);
  if (!Number.isInteger(mode) || mode < 0 || mode > ids.length) throw new Error('Проверьте режим источника');
  return {ids, mode, url: url.href.replace(/\/+$/, ''), interval: interval * 1000, token};
}

const CHANNEL = 'source_snapshot';

function run(plugin, params, request = fetch) {
  const {url, ids, interval, token, mode: initialMode} = options(params);
  let mode = initialMode;
  let points = new Map();
  let status = {online: false, error: 'Ожидание ответа Traccar'};
  let channels = [];
  const sent = new Map();
  let stopped = false;
  let pending = false;
  let loadRevision = 0;

  function publish() {
    if (stopped) return;
    const packet = snapshot(points, ids, mode, Date.now() / 1000, status);
    const ordered = [...points.values()].sort(compare);
    const preferred = points.get(ids[mode - 1]);
    if (preferred) ordered.unshift(preferred);
    const changes = [];
    for (const channel of channels) {
      let value;
      if (channel.chan === CHANNEL) value = JSON.stringify(packet);
      else {
        const path = String(channel.jsonPath || channel.chan).trim().split('.');
        for (const point of ordered) {
          value = point.raw;
          for (const key of path) {
            value = value != null && Object.hasOwn(value, key) ? value[key] : undefined;
          }
          if (value != null && value !== '') break;
        }
        if (value == null || value === '') value = null;
        else if (typeof value === 'object') value = JSON.stringify(value);
      }
      if (sent.get(channel.id) !== value) changes.push({id:channel.id, value});
    }
    if (changes.length) {
      plugin.sendData(changes);
      for (const item of changes) sent.set(item.id, item.value);
    }
  }

  async function getRows(path) {
    const response = await request(url + path, {
      headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'},
      redirect: 'error',
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('неожиданный формат ответа');
    return rows;
  }

  async function poll() {
    if (pending || stopped) return;
    pending = true;
    try {
      const latest = new Map();
      function addPositions(rows) {
        for (const row of rows) {
          const index = ids.indexOf(Number(row?.deviceId));
          if (index < 0) continue;
          const point = pointValues(row, index);
          if (!point) continue;
          const previous = latest.get(point.deviceId);
          if (!previous || compare(point, previous) < 0) latest.set(point.deviceId, point);
        }
      }
      addPositions(await getRows('/api/positions'));
      if (latest.size < ids.length) {
        try {
          const devices = await getRows('/api/devices');
          const positionIds = devices.filter(device => {
            const id = Number(device?.id);
            return ids.includes(id) && !latest.has(id);
          }).map(device => Number(device.positionId)).filter(id => Number.isSafeInteger(id) && id > 0);
          if (positionIds.length) {
            const query = new URLSearchParams(positionIds.map(id => ['id', String(id)]));
            addPositions(await getRows('/api/positions?' + query));
          }
        } catch (error) {
          if (latest.size === 0) throw error;
        }
      }
      points = latest;
      status = {online: true, error: latest.size ? '' : 'Traccar не вернул точки настроенных устройств'};
    } catch (error) {
      const message = /^(HTTP \d{3}|неожиданный формат ответа)$/.test(error.message)
        ? error.message : 'ошибка связи или чтения ответа';
      if (!stopped && message !== status.error) plugin.log('Traccar: ' + message);
      status = {online: false, error: message};
    } finally {
      pending = false;
    }
    publish();
  }

  async function reloadChannels() {
    const revision = ++loadRevision;
    try {
      const list = await plugin.channels.get();
      if (stopped || revision !== loadRevision) return;
      channels = list.filter(item => item.id && item.chan);
      sent.clear();
      publish();
    } catch {
      if (!stopped) plugin.log('Traccar: не удалось загрузить канал');
    }
  }

  const tick = () => poll().catch(() => plugin.log('Traccar: не удалось передать данные'));
  plugin.onAct?.(message => {
    const channel = channels.find(item => item.chan === CHANNEL);
    if (!channel) return;
    for (const action of message.data ?? []) {
      if (action.id ? action.id !== channel.id : action.chan !== CHANNEL && action.prop !== CHANNEL) continue;
      let command;
      try { command = typeof action.value === 'string' ? JSON.parse(action.value) : action.value; } catch { continue; }
      const next = command?.mode;
      if (!Number.isInteger(next) || next < 0 || next > ids.length) continue;
      mode = next;
      sent.delete(channel.id);
      publish();
    }
  });
  plugin.onChange?.('channels', reloadChannels);
  void reloadChannels().then(tick);
  const timer = setInterval(tick, interval);
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = run;
module.exports.pointValues = pointValues;
module.exports.snapshot = snapshot;
