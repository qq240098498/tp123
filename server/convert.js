const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText, offsetInYear } = require('./zones');

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

function segmentYearsText(segment) {
  return segment.toYear === null ? `${segment.fromYear} 年起` : `${segment.fromYear} 至 ${segment.toYear} 年`;
}

// 换算：先按输入年份落在来源时区的哪一段取偏移，把输入时刻折算成基准时刻，
// 再逐个时区按同一年落段取偏移加上去；年份没有被分段覆盖的时区按不可用处理
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const sourceOffset = offsetInYear(source, date.year);
  if (!sourceOffset.available) {
    throw new ApiError(
      409,
      'ZONE_UNAVAILABLE_IN_YEAR',
      `来源时区 ${source.name} 在 ${date.year} 年不可用：${sourceOffset.reason}`,
      'date',
    );
  }
  const sourceMinutes = sourceOffset.offsetMinutes;

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const utcMs = baseMs - sourceMinutes * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone) => {
    const lookup = offsetInYear(zone, date.year);
    const common = {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      usesDst: zone.usesDst,
      isSource: zone.id === source.id,
      year: date.year,
    };
    if (!lookup.available) {
      return {
        ...common,
        available: false,
        unavailableReason: lookup.reason,
        offsetMinutes: null,
        offsetText: '',
        segmentYearsText: '',
        localDate: '',
        localTime: '',
        weekday: '',
        dayOffset: null,
        dayOffsetText: '不可用',
        diffMinutes: null,
        diffText: lookup.reason,
      };
    }
    const localMs = utcMs + lookup.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = lookup.offsetMinutes - sourceMinutes;
    return {
      ...common,
      available: true,
      unavailableReason: '',
      offsetMinutes: lookup.offsetMinutes,
      offsetText: offsetText(lookup.offsetMinutes),
      segmentYearsText: segmentYearsText(lookup.segment),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
    };
  });

  const availableResults = results.filter((item) => item.available);
  const unavailableResults = results.filter((item) => !item.available);

  availableResults.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });
  unavailableResults.sort((a, b) => (a.name < b.name ? -1 : 1));

  const sortedResults = [...availableResults, ...unavailableResults];

  return {
    input: {
      date: date.text,
      time: time.text,
      year: date.year,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(sourceMinutes),
      sourceSegmentYearsText: segmentYearsText(sourceOffset.segment),
      usesDst: source.usesDst,
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    availableCount: availableResults.length,
    unavailableCount: unavailableResults.length,
    crossDayCount: availableResults.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: availableResults.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results: sortedResults,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText };
