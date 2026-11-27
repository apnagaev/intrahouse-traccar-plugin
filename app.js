'use strict';

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const binary = value => typeof value === 'boolean' ? Number(value) : [0, 1].includes(value) ? value : undefined;
const attributeNumber = value => typeof value === 'string' && value.trim() ? numeric(Number(value)) : numeric(value);
function timestamp(value) {
  if (typeof value === 'string' && value.trim()) {
    const input = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(input)) return timestamp(Number(input));
    return numeric(Date.parse(input) / 1000);
  }
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
  const odometer = attributeNumber(attrs.odometer);
  const totalDistance = attributeNumber(attrs.totalDistance);
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
      fuel: attributeNumber(attrs.fuelLitres ?? attrs.fuel),
      fuelAverage: attributeNumber(attrs.fuel_average),
      fuelRange: attributeNumber(attrs.fuel_range),
      fuelDistance: attributeNumber(attrs.fuel_distance),
      eco: attributeNumber(attrs.ECO ?? attrs.eco),
      odometerKm: odometer !== undefined ? odometer / 1000 : totalDistance === undefined ? undefined : totalDistance / 1000
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

// ---------------------------------------------------------------------------
// DEBUG: диагностика токена без утечки его в лог.
// fp — djb2-отпечаток (можно сравнить с эталоном: 177 симв. → сравните fp вручную).
// +/= etc — счётчики символов: если sp>0 или ctrl>0, токен испорчен при передаче.
// ---------------------------------------------------------------------------
function tokenDiag(t) {
  let h = 5381;
  let spaces = 0, plus = 0, slash = 0, eq = 0, dash = 0, underscore = 0, ctrl = 0, nonAscii = 0;
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    h = ((h * 33) ^ code) >>> 0;
    const c = t[i];
    if (c === ' ') spaces++;
    else if (c === '+') plus++;
    else if (c === '/') slash++;
    else if (c === '=') eq++;
    else if (c === '-') dash++;
    else if (c === '_') underscore++;
    else if (code < 0x20 || code === 0x7f) ctrl++;
    else if (code > 0x7e) nonAscii++;
  }
  return `len=${t.length} fp=${h.toString(16).padStart(8, '0')} ` +
    `first=${JSON.stringify(t.slice(0, 8))} last=${JSON.stringify(t.slice(-4))} ` +
    `+${plus} /${slash} =${eq} -${dash} _${underscore} sp=${spaces} ctrl=${ctrl} hi=${nonAscii}`;
}

const CHANNEL = 'source_snapshot';

function run(plugin, params, request = fetch) {
  const {url, ids, interval, token, mode: initialMode} = options(params);
  let mode = initialMode;
  let points = new Map();
  let names = new Map();
  let refreshNamesAt = 0;
  let status = {online: false, error: 'Ожидание ответа Traccar'};
  let channels = [];
  const sent = new Map();
  let stopped = false;
  let pending = false;
  let loadRevision = 0;

  // -------------------------------------------------------------------------
  // DEBUG: первые N поллов подробно пишем в лог, потом тишина.
  // -------------------------------------------------------------------------
  const DIAG_POLLS = 3;
  let diagCounter = 0;

  plugin.log('Traccar diag: url=' + url + ' ids=' + JSON.stringify(ids) +
    ' interval=' + Math.round(interval / 1000) + 's mode=' + mode);
  plugin.log('Traccar diag: params keys=' + Object.keys(params).join(',') +
    ' rawTokenLen=' + String(params.token ?? '').length);
  plugin.log('Traccar diag: token ' + tokenDiag(token));

  function publish() {
    if (stopped) return;
    const packet = snapshot(points, ids, mode, Date.now() / 1000, status);
    for (const tracker of packet.trackers) tracker.name = names.get(tracker.id);
    const packetFields = {
      address: 'address', latitude: 'latitude', longitude: 'longitude', speed: 'speed',
      geofenceIds: 'geofences', attributes_fuel: 'fuel', attributes_odometer: 'odometerKm',
      attributes_power: 'voltage', attributes_ignition: 'ignition', attributes_motion: 'motion',
      attributes_rpm: 'rpm', attributes_engine_temp: 'engineTemp', attributes_cabin_temp: 'cabinTemp',
      attributes_ECO: 'eco'
    };
    for (const channel of channels) {
      const field = packetFields[channel.chan];
      if (!Object.hasOwn(packetFields, channel.chan) || !channel.sourceDeviceId) continue;
      const point = points.get(Number(channel.sourceDeviceId));
      packet[field] = point?.fields[field];
      delete packet.sources[field];
      if (packet[field] !== undefined) packet.sources[field] = point.deviceId;
    }
    const ordered = [...points.values()].sort(compare);
    const preferred = points.get(ids[mode - 1]);
    if (preferred) ordered.unshift(preferred);
    const changes = [];
    for (const channel of channels) {
      let value;
      if (channel.chan === CHANNEL) value = JSON.stringify(packet);
      else {
        const path = String(channel.jsonPath || channel.chan).trim().split('.');
        for (const point of channel.sourceDeviceId ? ordered.filter(p => p.deviceId === Number(channel.sourceDeviceId)) : ordered) {
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
    let response;
    try {
      response = await request(url + path, {
        headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'},
        redirect: 'error',
        signal: AbortSignal.timeout(8000)
      });
    } catch (netError) {
      const error = new Error('NET ' + path);
      error.status = 0;
      error.body = String(netError && netError.message || netError || '');
      throw error;
    }
    if (!response.ok) {
      let body = '';
      try {
        body = (await response.text()).slice(0, 400).replace(/\s+/g, ' ');
      } catch { /* ignore */ }
      const error = new Error('HTTP ' + response.status + ' GET ' + path);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('неожиданный формат ответа');
    return rows;
  }

  async function poll() {
    if (pending || stopped) return;
    pending = true;
    const verbose = diagCounter < DIAG_POLLS;
    try {
      const latest = new Map();
      let invalidTimes = 0;
      let visibleIds = [];
      const rejected = [];  // {path, body}
      if (verbose) plugin.log('Traccar diag: poll #' + (diagCounter + 1));

      function addPositions(rows) {
        for (const row of rows) {
          const index = ids.indexOf(Number(row?.deviceId));
          if (index < 0) continue;
          const point = pointValues(row, index);
          if (!point) { invalidTimes++; continue; }
          const previous = latest.get(point.deviceId);
          if (!previous || compare(point, previous) < 0) latest.set(point.deviceId, point);
        }
      }

      async function read(path) {
        if (verbose) plugin.log('Traccar → ' + path);
        try {
          const rows = await getRows(path);
          if (verbose) plugin.log('Traccar ← ' + path + ' rows=' + rows.length);
          return rows;
        } catch (error) {
          if (error.status !== 400) {
            if (verbose) plugin.log('Traccar ← ' + path + ' FAIL ' +
              (error.status || error.name) + (error.body ? ' [' + error.body.slice(0, 200) + ']' : ''));
            throw error;
          }
          rejected.push({path: error.message, body: error.body || ''});
          if (verbose) plugin.log('Traccar ← ' + path + ' 400' +
            (error.body ? ' [' + error.body.slice(0, 150) + ']' : ''));
          return [];
        }
      }

      // 1. Все последние позиции
      addPositions(await read('/api/positions'));

      // 2. Голый ?deviceId= — форма, подтверждённая рабочим curl
      for (const id of ids) {
        if (stopped) return;
        if (latest.has(id)) continue;
        addPositions(await read('/api/positions?deviceId=' + id));
      }

      // 3. Стандартный Traccar: deviceId + from/to (совместимость)
      if (latest.size < ids.length) {
        const to = new Date();
        const from = new Date(to.getTime() - 10 * 60 * 1000);
        for (const id of ids) {
          if (stopped) return;
          if (latest.has(id)) continue;
          const query = new URLSearchParams({
            deviceId: String(id),
            from: from.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            to: to.toISOString().replace(/\.\d{3}Z$/, 'Z')
          });
          addPositions(await read('/api/positions?' + query));
        }
      }

      // 4. Резерв через positionId из /api/devices
      if (latest.size < ids.length) {
        try {
          const devices = await read('/api/devices');
          visibleIds = devices.map(device => Number(device?.id)).filter(Number.isSafeInteger);
          const positionIds = devices.filter(device => {
            const id = Number(device?.id);
            return ids.includes(id) && !latest.has(id);
          }).map(device => Number(device.positionId)).filter(id => Number.isSafeInteger(id) && id > 0);
          if (positionIds.length) {
            const query = new URLSearchParams(positionIds.map(id => ['id', String(id)]));
            addPositions(await read('/api/positions?' + query));
          }
        } catch (error) {
          if (latest.size === 0) throw error;
        }
      }

      if (verbose) {
        plugin.log('Traccar diag: latest=' + latest.size + '/' + ids.length +
          ' rejected=' + rejected.length + ' visibleIds=' + JSON.stringify(visibleIds) +
          ' invalidTimes=' + invalidTimes);
      }

      if (!latest.size && rejected.length) {
        plugin.log('Traccar diag: все запросы упали:\n  ' +
          rejected.map(item => item.path + (item.body ? ' [' + item.body + ']' : '')).join('\n  '));
        throw new Error(rejected[0].path);
      }

      if (Date.now() >= refreshNamesAt) {
        refreshNamesAt = Date.now() + 300000;
        try {
          const devices = await getRows('/api/devices');
          names = new Map(devices.map(device => [Number(device.id), device.name]));
        } catch (error) {
          plugin.log('Traccar: не удалось обновить названия устройств');
        }
      }
      points = latest;
      status = {online: true, error: latest.size ? '' : invalidTimes
        ? `Получено строк без корректного serverTime: ${invalidTimes}`
        : visibleIds.some(id => ids.includes(id))
          ? `Нет последних точек и точек за 10 минут. Настроены ID: ${ids.join(', ')}`
          : `Настроены ID: ${ids.join(', ')}. Доступные ID Traccar: ${visibleIds.join(', ') || 'нет'}`};
    } catch (error) {
      const message = /^(HTTP \d{3} GET \/api\/[^\s]+|NET \/api\/[^\s]+|неожиданный формат ответа)$/.test(error.message)
        ? error.message : 'ошибка связи или чтения ответа';
      if (!stopped && message !== status.error) plugin.log('Traccar: ' + message);
      status = {online: false, error: message};
    } finally {
      pending = false;
      if (diagCounter < DIAG_POLLS) diagCounter++;
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
module.exports.tokenDiag = tokenDiag;
