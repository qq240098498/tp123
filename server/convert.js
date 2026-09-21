const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText, periodRangeText, findPeriodAt, uncoveredReason } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 换算：先按来源时区在输入年份那一段的偏移折成基准时刻，再逐个时区取该年所在段的偏移
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  // 来源时区在输入年份落在哪一段：落不进来就没法把输入时刻折成基准时刻，整个换算不成立
  const sourceHit = findPeriodAt(source, date.year);
  if (!sourceHit) {
    const reason = uncoveredReason(source, date.year);
    throw new ApiError(400, 'CONVERT_YEAR_UNCOVERED', reason, 'date');
  }
  const sourceOffset = sourceHit.period.offsetMinutes;

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const utcMs = baseMs - sourceOffset * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const available = [];
  const unavailable = [];

  data.zones.forEach((zone) => {
    const hit = findPeriodAt(zone, date.year);
    if (!hit) {
      unavailable.push({
        zoneId: zone.id,
        name: zone.name,
        displayName: zone.displayName,
        usesDst: zone.usesDst,
        isSource: zone.id === source.id,
        available: false,
        unavailableReason: uncoveredReason(zone, date.year),
      });
      return;
    }

    const { period, index } = hit;
    const localMs = utcMs + period.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = period.offsetMinutes - sourceOffset;
    available.push({
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      available: true,
      periodIndex: index,
      periodRangeText: periodRangeText(period),
      offsetMinutes: period.offsetMinutes,
      offsetText: offsetText(period.offsetMinutes),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      isSource: zone.id === source.id,
    });
  });

  available.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });
  unavailable.sort((a, b) => (a.name < b.name ? -1 : 1));
  const results = available.concat(unavailable);

  return {
    input: {
      date: date.text,
      year: date.year,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(sourceOffset),
      sourcePeriodText: periodRangeText(sourceHit.period),
      usesDst: source.usesDst,
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    availableCount: available.length,
    unavailableCount: unavailable.length,
    crossDayCount: available.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: available.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText };
