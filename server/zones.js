const crypto = require('crypto');
const {
  load, save,
  MIN_OFFSET, MAX_OFFSET, MIN_YEAR, MAX_YEAR,
  MAX_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH, MAX_NOTE_LENGTH, MAX_PERIODS,
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

// 夏令时的生效年份允许留空，空表示不限；偏移分段的开始年份不允许空
function validateYear(value, field, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'YEAR_REQUIRED', `${label}要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, field);
    return null;
  }
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

// 偏移的展示写法，半小时与三刻都要看得清
function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hour = String(Math.floor(abs / 60)).padStart(2, '0');
  const minute = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hour}:${minute}`;
}

function periodRangeText(period) {
  return period.toYear === null ? `${period.fromYear} 年起` : `${period.fromYear} 至 ${period.toYear} 年`;
}

// 报错时用来指明是哪一段：区间加偏移
function periodLabel(period) {
  return `${periodRangeText(period)}（${offsetText(period.offsetMinutes)}）`;
}

function gapYearsText(from, to) {
  return from === to ? `${from} 年` : `${from} 至 ${to} 年`;
}

// 偏移分段的校验：每段自身要合法，段与段之间既不能撞上也不能空着年份
function validatePeriods(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(400, 'PERIODS_REQUIRED', '至少要登记一个偏移分段，写清开始年份与这段期间的偏移', 'offsetPeriods');
  }
  if (value.length > MAX_PERIODS) {
    throw new ApiError(400, 'PERIODS_TOO_MANY', `一条档案最多登记 ${MAX_PERIODS} 个偏移分段`, 'offsetPeriods');
  }

  const periods = value.map((raw, index) => {
    const ordinal = `第 ${index + 1} 段`;
    const source = raw && typeof raw === 'object' ? raw : {};
    const fromYear = validateYear(source.fromYear, 'offsetPeriods', `${ordinal}的开始年份`, { required: true });
    const toYear = validateYear(source.toYear, 'offsetPeriods', `${ordinal}的结束年份`);
    if (toYear !== null && toYear < fromYear) {
      throw new ApiError(400, 'PERIOD_RANGE_INVALID', `${ordinal}的结束年份不能早于开始年份（${fromYear} 至 ${toYear} 年）`, 'offsetPeriods');
    }
    const offsetMinutes = validateOffset(source.offsetMinutes, 'offsetPeriods');
    return { fromYear, toYear, offsetMinutes };
  });

  // 按开始年份排好再逐对检查，开始年份相同的两段天然撞在同一年
  const sorted = periods.slice().sort((a, b) => a.fromYear - b.fromYear);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (current.toYear === null) {
      throw new ApiError(
        400,
        'PERIODS_OVERLAP',
        `${periodLabel(current)}没有结束年份，后面又接了${periodLabel(next)}：开放至今的分段只能放在最后，这两段在 ${next.fromYear} 年撞上了`,
        'offsetPeriods',
      );
    }
    if (next.fromYear <= current.toYear) {
      const overlapEnd = Math.min(current.toYear, next.toYear === null ? MAX_YEAR : next.toYear);
      throw new ApiError(
        400,
        'PERIODS_OVERLAP',
        `${periodLabel(current)}与${periodLabel(next)}重叠，${gapYearsText(next.fromYear, overlapEnd)}这几年被两段同时占着`,
        'offsetPeriods',
      );
    }
    if (next.fromYear > current.toYear + 1) {
      throw new ApiError(
        400,
        'PERIODS_GAP',
        `${periodLabel(current)}到 ${current.toYear} 年结束，${periodLabel(next)}到 ${next.fromYear} 年才接上，中间 ${gapYearsText(current.toYear + 1, next.fromYear - 1)}没有任何分段覆盖`,
        'offsetPeriods',
      );
    }
  }
  return sorted;
}

// 夏令时生效年份：留空表示不限；填了就要落在偏移分段已经覆盖到的年份里
function validateDstYear(value, field, label, periods) {
  const year = validateYear(value, field, label);
  if (year === null) return null;
  const covered = periods.some((period) => year >= period.fromYear
    && (period.toYear === null || year <= period.toYear));
  if (!covered) {
    throw new ApiError(400, 'DST_YEAR_UNCOVERED', `${label}${year} 年不在任何一个偏移分段的覆盖年份里，先把偏移分段补齐再登记夏令时`, field);
  }
  return year;
}

// 一整条档案的校验：偏移分段、夏令时三段与夏令时生效年份要能对得上
function validatePayload(input, data, selfId) {
  const name = validateName(input.name, data, selfId);
  const displayName = validateDisplayName(input.displayName);
  const offsetPeriods = validatePeriods(input.offsetPeriods);
  const usesDst = input.usesDst === true || input.usesDst === 'true';

  let dstOffsetMinutes = null;
  let dstStart = null;
  let dstEnd = null;
  let dstFromYear = null;
  let dstToYear = null;

  if (usesDst) {
    dstOffsetMinutes = validateOffset(input.dstOffsetMinutes, 'dstOffsetMinutes');
    // 夏令时偏移要比它生效期间每一段标准偏移都更靠前，找出第一个不满足的段说明白
    const worse = offsetPeriods.find((period) => dstOffsetMinutes <= period.offsetMinutes);
    if (worse) {
      throw new ApiError(
        400,
        'DST_OFFSET_INVALID',
        `夏令时偏移 ${offsetText(dstOffsetMinutes)} 不比${periodRangeText(worse)}那段标准偏移 ${offsetText(worse.offsetMinutes)} 更靠前（数值要更大）`,
        'dstOffsetMinutes',
      );
    }
    if (!input.dstStart || !input.dstEnd) {
      throw new ApiError(400, 'DST_RULE_REQUIRED', '实行夏令时的时区要把开始与结束两段规则都填上', 'dstStart');
    }
    dstStart = validateRulePart(input.dstStart, 'dstStart');
    dstEnd = validateRulePart(input.dstEnd, 'dstEnd');
    if (sameRulePart(dstStart, dstEnd)) {
      throw new ApiError(400, 'DST_RULE_SAME', '开始与结束两段规则不能完全相同，否则推算不出切换区间', 'dstEnd');
    }
    dstFromYear = validateDstYear(input.dstFromYear, 'dstFromYear', '夏令时开始年份', offsetPeriods);
    dstToYear = validateDstYear(input.dstToYear, 'dstToYear', '夏令时结束年份', offsetPeriods);
    if (dstFromYear !== null && dstToYear !== null && dstToYear < dstFromYear) {
      throw new ApiError(400, 'YEAR_RANGE_INVALID', '夏令时结束年份不能早于开始年份', 'dstToYear');
    }
  }

  return {
    name,
    displayName,
    offsetPeriods,
    usesDst,
    dstOffsetMinutes,
    dstStart,
    dstEnd,
    dstFromYear,
    dstToYear,
    note: validateNote(input.note),
  };
}

// 最新一段（开始年份最晚，通常开放至今）的偏移当作这条档案的当前偏移
function currentPeriod(zone) {
  return zone.offsetPeriods[zone.offsetPeriods.length - 1];
}

// 某一年落在哪一段；一年最多落在一段，落不进来返回 null
function findPeriodAt(zone, year) {
  const periods = zone.offsetPeriods;
  for (let i = 0; i < periods.length; i += 1) {
    const period = periods[i];
    if (year >= period.fromYear && (period.toYear === null || year <= period.toYear)) {
      return { period, index: i };
    }
  }
  return null;
}

// 年份没有被任何分段覆盖时给出原因：在最早一段之前、最后一段之后，或两段之间空着
function uncoveredReason(zone, year) {
  const name = zone.name;
  const periods = zone.offsetPeriods;
  for (let i = 0; i < periods.length; i += 1) {
    const period = periods[i];
    if (year < period.fromYear) {
      if (i === 0) {
        return `${name} 的偏移分段从 ${period.fromYear} 年才开始登记，${year} 年在最早一段之前，没有这一年的偏移记录`;
      }
      const prev = periods[i - 1];
      return `${name} 的偏移在 ${prev.toYear} 年到 ${period.fromYear} 年之间空着，${year} 年没有任何分段覆盖（${periodRangeText(prev)}与${periodRangeText(period)}之间的空档）`;
    }
    if (year <= (period.toYear === null ? MAX_YEAR : period.toYear)) return null;
  }
  const last = periods[periods.length - 1];
  return `${name} 的偏移分段只登记到 ${last.toYear} 年，${year} 年在最后一段之后，没有这一年的偏移记录`;
}

function withOffsetText(zone) {
  const periods = zone.offsetPeriods.map((period, index) => ({
    ...period,
    index,
    offsetText: offsetText(period.offsetMinutes),
    rangeText: periodRangeText(period),
  }));
  const current = currentPeriod(zone);
  const first = zone.offsetPeriods[0];
  const coverageEnd = current.toYear === null ? null : current.toYear;
  return {
    ...zone,
    offsetPeriods: periods,
    offsetMinutes: current.offsetMinutes,
    offsetText: offsetText(current.offsetMinutes),
    periodCount: periods.length,
    coverageStartYear: first.fromYear,
    coverageEndYear: coverageEnd,
    coverageText: coverageEnd === null
      ? `${first.fromYear} 年起，分 ${periods.length} 段`
      : `${first.fromYear} 至 ${coverageEnd} 年，分 ${periods.length} 段`,
    dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    dstYearRangeText: zone.usesDst
      ? (zone.dstToYear === null
        ? (zone.dstFromYear === null ? '长期实行' : `${zone.dstFromYear} 年起`)
        : (zone.dstFromYear === null
          ? `至 ${zone.dstToYear} 年止（开始年份不限）`
          : `${zone.dstFromYear} 至 ${zone.dstToYear}`))
      : '',
  };
}

function sortZones(list) {
  return list.slice().sort((a, b) => {
    const offsetA = currentPeriod(a).offsetMinutes;
    const offsetB = currentPeriod(b).offsetMinutes;
    if (offsetA !== offsetB) return offsetA - offsetB;
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
    offsetPeriods: input.offsetPeriods === undefined ? found.offsetPeriods : input.offsetPeriods,
    usesDst: input.usesDst === undefined ? found.usesDst : (input.usesDst === true || input.usesDst === 'true'),
    dstOffsetMinutes: input.dstOffsetMinutes === undefined ? found.dstOffsetMinutes : input.dstOffsetMinutes,
    dstStart: input.dstStart === undefined ? found.dstStart : input.dstStart,
    dstEnd: input.dstEnd === undefined ? found.dstEnd : input.dstEnd,
    dstFromYear: input.dstFromYear === undefined ? found.dstFromYear : input.dstFromYear,
    dstToYear: input.dstToYear === undefined ? found.dstToYear : input.dstToYear,
    note: input.note === undefined ? found.note : input.note,
  };

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
  createZone,
  updateZone,
  deleteZone,
  offsetText,
  periodRangeText,
  findPeriodAt,
  uncoveredReason,
  withOffsetText,
};
