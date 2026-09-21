const crypto = require('crypto');
const {
  load,
  save,
  MIN_OFFSET,
  MAX_OFFSET,
  MIN_YEAR,
  MAX_YEAR,
  MAX_SEGMENTS,
  MAX_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_NOTE_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');

// 时区名固定成地区加城市的写法，UTC 单独允许
const NAME_PATTERN = /^([A-Za-z_]+(\/[A-Za-z_]+)+|UTC)$/;
const WEEK_TOKENS = ['1', '2', '3', '4', 'last'];

function validateName(value, data, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写时区名称', 'name');
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `时区名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'NAME_INVALID', '时区名称要写成地区加城市，例如 Asia/Shanghai，基准时可以写 UTC', 'name');
  }
  const hit = data.zones.find((item) => item.id !== selfId && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'NAME_DUPLICATED', `${hit.name} 已经登记过了`, 'name');
  return name;
}

function validateDisplayName(value) {
  const displayName = pickText(value);
  if (!displayName) throw new ApiError(400, 'DISPLAY_NAME_REQUIRED', '请填写显示名称', 'displayName');
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ApiError(400, 'DISPLAY_NAME_TOO_LONG', `显示名称不能超过 ${MAX_DISPLAY_NAME_LENGTH} 个字符`, 'displayName');
  }
  return displayName;
}

// 偏移一律按分钟存，允许半小时与三刻这样的写法
function validateOffset(value, field) {
  const raw = typeof value === 'number' ? value : Number(pickText(String(value === undefined || value === null ? '' : value)));
  if (!Number.isInteger(raw)) {
    throw new ApiError(400, 'OFFSET_INVALID', '偏移要写成整数分钟，例如东八区写 480', field);
  }
  if (raw < MIN_OFFSET || raw > MAX_OFFSET) {
    throw new ApiError(400, 'OFFSET_OUT_OF_RANGE', `偏移要在 ${MIN_OFFSET} 到 ${MAX_OFFSET} 分钟之间`, field);
  }
  return raw;
}

// 夏令时规则里的一段：第几个星期几的几点几分
function validateRulePart(value, field) {
  const source = value && typeof value === 'object' ? value : {};
  const month = Number(source.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'DST_MONTH_INVALID', '切换月份要填一到十二', field);
  }
  const week = String(source.week);
  if (!WEEK_TOKENS.includes(week)) {
    throw new ApiError(400, 'DST_WEEK_INVALID', '第几个星期只能填一到四，或者填最后一个', field);
  }
  const weekday = Number(source.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ApiError(400, 'DST_WEEKDAY_INVALID', '星期要填零到六，零表示周日', field);
  }
  const hour = Number(source.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(400, 'DST_HOUR_INVALID', '切换时刻的小时要填零到二十三', field);
  }
  const minute = Number(source.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ApiError(400, 'DST_MINUTE_INVALID', '切换时刻的分钟要填零到五十九', field);
  }
  return { month, week, weekday, hour, minute };
}

function sameRulePart(a, b) {
  if (!a || !b) return false;
  return a.month === b.month && a.week === b.week && a.weekday === b.weekday
    && a.hour === b.hour && a.minute === b.minute;
}

function parseYearValue(value, field, label) {
  if (value === undefined || value === null || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `${label}要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, field);
  }
  return year;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 年份区间的展示写法
function segmentYearsText(segment) {
  return segment.toYear === null ? `${segment.fromYear} 年起` : `${segment.fromYear} 至 ${segment.toYear} 年`;
}

// 分段里某一行的字段名，报错时指到具体那一段的那一格
function segmentField(index, key) {
  return `segments[${index}].${key}`;
}

// 校验一条档案的分段表：至少一段、每段年份合法、段与段首尾相接，
// 不允许重叠、不允许留空洞，开口（至今）段最多一段且只能是最后一段。
// 出错时把撞上的两段年份、或者空着的年份范围直接写在说明里。
function validateSegments(input) {
  const rawList = input.segments;
  if (rawList === undefined || rawList === null) {
    // 没有带分段表时，回退到顶层的偏移与生效年份单段写法
    const offsetMinutes = validateOffset(input.offsetMinutes, 'offsetMinutes');
    const fromYear = parseYearValue(input.fromYear, 'fromYear', '开始年份');
    const toYear = parseYearValue(input.toYear, 'toYear', '结束年份');
    const start = fromYear === null ? MIN_YEAR : fromYear;
    if (toYear !== null && toYear < start) {
      throw new ApiError(400, 'YEAR_RANGE_INVALID', '结束年份不能早于开始年份', 'toYear');
    }
    return { segments: [{ fromYear: start, toYear, offsetMinutes }] };
  }
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new ApiError(400, 'SEGMENTS_REQUIRED', '至少要登记一段偏移区间，写清开始年份与这段期间的偏移', 'segments');
  }
  if (rawList.length > MAX_SEGMENTS) {
    throw new ApiError(400, 'SEGMENTS_TOO_MANY', `偏移分段最多登记 ${MAX_SEGMENTS} 段`, 'segments');
  }

  const segments = rawList.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const fromYear = parseYearValue(source.fromYear, segmentField(index, 'fromYear'), `第 ${index + 1} 段的开始年份`);
    if (fromYear === null) {
      throw new ApiError(400, 'SEGMENT_YEAR_REQUIRED', `第 ${index + 1} 段还没填开始年份`, segmentField(index, 'fromYear'));
    }
    const toYear = parseYearValue(source.toYear, segmentField(index, 'toYear'), `第 ${index + 1} 段的结束年份`);
    if (toYear !== null && toYear < fromYear) {
      throw new ApiError(
        400,
        'SEGMENT_RANGE_INVALID',
        `第 ${index + 1} 段的结束年份 ${toYear} 早于开始年份 ${fromYear}`,
        segmentField(index, 'toYear'),
      );
    }
    const offsetMinutes = validateOffset(source.offsetMinutes, segmentField(index, 'offsetMinutes'));
    return { fromYear, toYear, offsetMinutes };
  });

  const sorted = segments
    .map((segment, index) => ({ ...segment, index }))
    .sort((a, b) => {
      if (a.fromYear !== b.fromYear) return a.fromYear - b.fromYear;
      if (a.toYear === null) return 1;
      if (b.toYear === null) return -1;
      return a.toYear - b.toYear;
    });

  sorted.forEach((segment, order) => {
    // 开口段只能有一段，而且必须落在所有段的最后
    if (segment.toYear === null && order !== sorted.length - 1) {
      throw new ApiError(
        400,
        'SEGMENT_OPEN_NOT_LAST',
        `第 ${segment.index + 1} 段（${segment.fromYear} 年起）没有结束年份，至今段只能是最后一段`,
        segmentField(segment.index, 'toYear'),
      );
    }
  });

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const current = sorted[i];
    if (prev.toYear === null) {
      // 理论上前面的开口段拦截已覆盖，这里再兜一层
      throw new ApiError(
        400,
        'SEGMENT_OVERLAP',
        `第 ${prev.index + 1} 段 ${segmentYearsText(prev)} 没有结束年份，和第 ${current.index + 1} 段从 ${current.fromYear} 年开始撞在一起`,
        segmentField(current.index, 'fromYear'),
      );
    }
    if (current.fromYear <= prev.toYear) {
      throw new ApiError(
        400,
        'SEGMENT_OVERLAP',
        `第 ${prev.index + 1} 段（${segmentYearsText(prev)}）与第 ${current.index + 1} 段（${segmentYearsText(current)}）在 ${current.fromYear} 至 ${prev.toYear} 年重叠`,
        segmentField(current.index, 'fromYear'),
      );
    }
    if (current.fromYear > prev.toYear + 1) {
      throw new ApiError(
        400,
        'SEGMENT_GAP',
        `第 ${prev.index + 1} 段到 ${prev.toYear} 年结束，第 ${current.index + 1} 段从 ${current.fromYear} 年才开始，中间 ${prev.toYear + 1} 至 ${current.fromYear - 1} 年没有任何分段覆盖`,
        segmentField(current.index, 'fromYear'),
      );
    }
  }

  return { segments: sorted.map(({ fromYear, toYear, offsetMinutes }) => ({ fromYear, toYear, offsetMinutes })) };
}

// 一整条档案的校验：偏移分段、夏令时三段与生效年份要能对得上
function validatePayload(input, data, selfId) {
  const name = validateName(input.name, data, selfId);
  const displayName = validateDisplayName(input.displayName);
  const usesDst = input.usesDst === true || input.usesDst === 'true';

  const checkedSegments = validateSegments(input);
  const segments = checkedSegments.segments;
  const first = segments[0];
  const last = segments[segments.length - 1];
  // 顶层字段从分段表反推：整体生效年份取首尾，当前偏移取最后一段
  const fromYear = first.fromYear;
  const toYear = last.toYear;
  const offsetMinutes = last.offsetMinutes;

  let dstOffsetMinutes = null;
  let dstStart = null;
  let dstEnd = null;

  if (usesDst) {
    dstOffsetMinutes = validateOffset(input.dstOffsetMinutes, 'dstOffsetMinutes');
    if (dstOffsetMinutes <= offsetMinutes) {
      throw new ApiError(400, 'DST_OFFSET_INVALID', `夏令时偏移要比当前标准偏移（${offsetMinutes} 分钟）更靠前，也就是数值更大`, 'dstOffsetMinutes');
    }
    if (!input.dstStart || !input.dstEnd) {
      throw new ApiError(400, 'DST_RULE_REQUIRED', '实行夏令时的时区要把开始与结束两段规则都填上', 'dstStart');
    }
    dstStart = validateRulePart(input.dstStart, 'dstStart');
    dstEnd = validateRulePart(input.dstEnd, 'dstEnd');
    if (sameRulePart(dstStart, dstEnd)) {
      throw new ApiError(400, 'DST_RULE_SAME', '开始与结束两段规则不能完全相同，否则推算不出切换区间', 'dstEnd');
    }
  }

  return {
    name,
    displayName,
    offsetMinutes,
    segments,
    usesDst,
    dstOffsetMinutes,
    dstStart,
    dstEnd,
    fromYear,
    toYear,
    note: validateNote(input.note),
  };
}

// 偏移的展示写法，半小时与三刻都要看得清
function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hour = String(Math.floor(abs / 60)).padStart(2, '0');
  const minute = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hour}:${minute}`;
}

// 给出这条时区在某一年的实际偏移；年份没有被任何分段覆盖时返回不可用说明
function offsetInYear(zone, year) {
  const segment = zone.segments.find((item) => year >= item.fromYear && (item.toYear === null || year <= item.toYear));
  if (!segment) {
    const first = zone.segments[0];
    const last = zone.segments[zone.segments.length - 1];
    let reason;
    if (year < first.fromYear) {
      reason = `${year} 年早于这条时区最早的分段开始年份 ${first.fromYear} 年，没有登记这段期间的偏移`;
    } else if (last.toYear !== null && year > last.toYear) {
      reason = `${year} 年晚于最后一段的结束年份 ${last.toYear} 年，这之后没有登记偏移`;
    } else {
      reason = `${year} 年没有落在任何已登记的分段内`;
    }
    return { available: false, reason, segment: null, offsetMinutes: null, offsetText: '' };
  }
  return {
    available: true,
    reason: '',
    segment,
    offsetMinutes: segment.offsetMinutes,
    offsetText: offsetText(segment.offsetMinutes),
  };
}

function withOffsetText(zone) {
  const segments = zone.segments.map((segment) => ({
    ...segment,
    offsetText: offsetText(segment.offsetMinutes),
    yearsText: segmentYearsText(segment),
  }));
  return {
    ...zone,
    offsetText: offsetText(zone.offsetMinutes),
    dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    yearRangeText: zone.toYear === null ? `${zone.fromYear} 年起` : `${zone.fromYear} 至 ${zone.toYear} 年`,
    segmentCount: segments.length,
    segments,
  };
}

function sortZones(list) {
  return list.slice().sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });
}

// 档案清单：按是否实行夏令时筛选，再按名称、显示名或备注搜索
function listZones(options) {
  const input = options && typeof options === 'object' ? options : {};
  const dst = pickText(input.dst);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.zones;
  if (dst === 'yes') list = list.filter((item) => item.usesDst);
  if (dst === 'no') list = list.filter((item) => !item.usesDst);
  if (keyword) {
    list = list.filter((item) => item.name.toLowerCase().includes(keyword)
      || item.displayName.toLowerCase().includes(keyword)
      || item.note.toLowerCase().includes(keyword));
  }

  return {
    zones: sortZones(list).map(withOffsetText),
    total: data.zones.length,
    dstCount: data.zones.filter((item) => item.usesDst).length,
    noDstCount: data.zones.filter((item) => !item.usesDst).length,
  };
}

function getZone(id) {
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  return withOffsetText(found);
}

// 按年份查这条时区的实际偏移：年份落在哪一段就取哪一段，没落到段上按不可用处理
function getZoneOffsetInYear(id, yearValue) {
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  const year = parseYearValue(yearValue, 'year', '要查询的年份');
  if (year === null) throw new ApiError(400, 'YEAR_REQUIRED', '请填写要查询的年份', 'year');

  const lookup = offsetInYear(found, year);
  if (!lookup.available) {
    return {
      zoneId: found.id,
      name: found.name,
      displayName: found.displayName,
      year,
      available: false,
      reason: lookup.reason,
      offsetMinutes: null,
      offsetText: '',
      segment: null,
      segmentYearsText: '',
    };
  }
  return {
    zoneId: found.id,
    name: found.name,
    displayName: found.displayName,
    year,
    available: true,
    reason: '',
    offsetMinutes: lookup.offsetMinutes,
    offsetText: lookup.offsetText,
    segment: lookup.segment,
    segmentYearsText: segmentYearsText(lookup.segment),
  };
}

function createZone(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const checked = validatePayload(input, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.zones.push(created);
  save(data);
  return withOffsetText(created);
}

function updateZone(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');

  const merged = {
    name: input.name === undefined ? found.name : input.name,
    displayName: input.displayName === undefined ? found.displayName : input.displayName,
    usesDst: input.usesDst === undefined ? found.usesDst : (input.usesDst === true || input.usesDst === 'true'),
    dstOffsetMinutes: input.dstOffsetMinutes === undefined ? found.dstOffsetMinutes : input.dstOffsetMinutes,
    dstStart: input.dstStart === undefined ? found.dstStart : input.dstStart,
    dstEnd: input.dstEnd === undefined ? found.dstEnd : input.dstEnd,
    note: input.note === undefined ? found.note : input.note,
  };
  // 分段表整体替换；没有带分段表时，沿用旧的分段（或旧的顶层单段写法）
  if (input.segments !== undefined) {
    merged.segments = input.segments;
  } else if (found.segments && found.segments.length) {
    merged.segments = found.segments;
  } else {
    merged.offsetMinutes = input.offsetMinutes === undefined ? found.offsetMinutes : input.offsetMinutes;
    merged.fromYear = input.fromYear === undefined ? found.fromYear : input.fromYear;
    merged.toYear = input.toYear === undefined ? found.toYear : input.toYear;
  }

  const checked = validatePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  return withOffsetText(found);
}

function deleteZone(id) {
  const data = load();
  const index = data.zones.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  const [removed] = data.zones.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name, displayName: removed.displayName };
}

module.exports = {
  listZones,
  getZone,
  getZoneOffsetInYear,
  createZone,
  updateZone,
  deleteZone,
  offsetText,
  offsetInYear,
  segmentYearsText,
  withOffsetText,
};
