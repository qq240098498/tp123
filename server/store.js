const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const MIN_OFFSET = -720;
const MAX_OFFSET = 840;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_NAME_LENGTH = 40;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_NOTE_LENGTH = 200;
// 一条档案最多登记多少个偏移分段，挡住误操作把表单刷成长清单
const MAX_PERIODS = 20;

// 时区档案的初始数据。十条档案里有一条偏移贯穿至今的，有几十年前换过偏移分成几段登记的
// （加德满都一九八六年由东五区半改成东五区三刻、平壤二〇一五年改八点半二〇一八年改回九点），
// 有带半小时与三刻偏移的、有南半球跨年实行夏令时的、有已经停止实行夏令时但保留生效年份区间的
function seedZones() {
  const at = '2026-09-05T02:00:00.000Z';
  return [
    {
      id: 'zone-1001', name: 'Asia/Shanghai', displayName: '中国标准时间',
      offsetPeriods: [{ fromYear: 1949, toYear: null, offsetMinutes: 480 }],
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      dstFromYear: null, dstToYear: null, note: '全国统一使用，不实行夏令时', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1002', name: 'Asia/Kolkata', displayName: '印度标准时间',
      offsetPeriods: [{ fromYear: 1947, toYear: null, offsetMinutes: 330 }],
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      dstFromYear: null, dstToYear: null, note: '偏移带半小时', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1003', name: 'Asia/Kathmandu', displayName: '尼泊尔时间',
      offsetPeriods: [
        { fromYear: 1972, toYear: 1985, offsetMinutes: 330 },
        { fromYear: 1986, toYear: null, offsetMinutes: 345 },
      ],
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      dstFromYear: null, dstToYear: null, note: '偏移带三刻；一九八六年之前与印度同为东五区半，之后再快十五分钟', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1004', name: 'UTC', displayName: '协调世界时',
      offsetPeriods: [{ fromYear: 1972, toYear: null, offsetMinutes: 0 }],
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      dstFromYear: null, dstToYear: null, note: '换算的基准', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1005', name: 'America/New_York', displayName: '美国东部时间',
      offsetPeriods: [{ fromYear: 1967, toYear: null, offsetMinutes: -300 }],
      usesDst: true, dstOffsetMinutes: -240,
      dstStart: { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 },
      dstEnd: { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 },
      dstFromYear: null, dstToYear: null, note: '三月第二个周日凌晨开始，十一月第一个周日凌晨结束', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1006', name: 'Europe/London', displayName: '英国时间',
      offsetPeriods: [{ fromYear: 1972, toYear: null, offsetMinutes: 0 }],
      usesDst: true, dstOffsetMinutes: 60,
      dstStart: { month: 3, week: 'last', weekday: 0, hour: 1, minute: 0 },
      dstEnd: { month: 10, week: 'last', weekday: 0, hour: 2, minute: 0 },
      dstFromYear: null, dstToYear: null, note: '切换时刻落在当地凌晨一点与两点', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1007', name: 'Australia/Sydney', displayName: '澳大利亚东部时间',
      offsetPeriods: [{ fromYear: 1971, toYear: null, offsetMinutes: 600 }],
      usesDst: true, dstOffsetMinutes: 660,
      dstStart: { month: 10, week: '1', weekday: 0, hour: 2, minute: 0 },
      dstEnd: { month: 4, week: '1', weekday: 0, hour: 3, minute: 0 },
      dstFromYear: null, dstToYear: null, note: '南半球，夏令时跨年，开始月份晚于结束月份', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1008', name: 'Pacific/Chatham', displayName: '查塔姆群岛时间',
      offsetPeriods: [{ fromYear: 1974, toYear: null, offsetMinutes: 765 }],
      usesDst: true, dstOffsetMinutes: 825,
      dstStart: { month: 9, week: 'last', weekday: 0, hour: 2, minute: 45 },
      dstEnd: { month: 4, week: '1', weekday: 0, hour: 3, minute: 45 },
      dstFromYear: null, dstToYear: null, note: '偏移与切换时刻都带三刻', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1009', name: 'America/Sao_Paulo', displayName: '巴西利亚时间',
      offsetPeriods: [{ fromYear: 1985, toYear: null, offsetMinutes: -180 }],
      usesDst: true, dstOffsetMinutes: -120,
      dstStart: { month: 11, week: '1', weekday: 0, hour: 0, minute: 0 },
      dstEnd: { month: 2, week: '3', weekday: 0, hour: 0, minute: 0 },
      dstFromYear: null, dstToYear: 2019, note: '二〇一九年起不再实行夏令时，夏令时规则只登记到二〇一九年', createdAt: at, updatedAt: at,
    },
    {
      id: 'zone-1010', name: 'Asia/Pyongyang', displayName: '平壤时间',
      offsetPeriods: [
        { fromYear: 1945, toYear: 2014, offsetMinutes: 540 },
        { fromYear: 2015, toYear: 2017, offsetMinutes: 510 },
        { fromYear: 2018, toYear: null, offsetMinutes: 540 },
      ],
      usesDst: false, dstOffsetMinutes: null, dstStart: null, dstEnd: null,
      dstFromYear: null, dstToYear: null, note: '二〇一五年起改用东八点半，二〇一八年又改回东九区，偏移历史分三段登记', createdAt: at, updatedAt: at,
    },
  ];
}

// 把夏令时规则里的一段整理成固定结构，字段不认识时置空表示这一段没有
function normalizeRulePart(item) {
  if (!item || typeof item !== 'object') return null;
  const month = Number(item.month);
  const week = item.week === 'last' ? 'last' : String(Number(item.week));
  const weekday = Number(item.weekday);
  const hour = Number(item.hour);
  const minute = Number(item.minute);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (week !== 'last' && (!Number.isInteger(Number(week)) || Number(week) < 1 || Number(week) > 4)) return null;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { month, week, weekday, hour, minute };
}

function yearInRange(value) {
  return Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR;
}

// 单个偏移分段：开始年份必填，结束年份留空表示这段至今有效
function normalizePeriod(item) {
  if (!item || typeof item !== 'object') return null;
  const fromYear = Number(item.fromYear);
  if (!yearInRange(fromYear)) return null;
  let toYear = null;
  if (item.toYear !== null && item.toYear !== undefined && item.toYear !== '') {
    toYear = Number(item.toYear);
    if (!yearInRange(toYear) || toYear < fromYear) return null;
  }
  const offsetMinutes = Number(item.offsetMinutes);
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < MIN_OFFSET || offsetMinutes > MAX_OFFSET) return null;
  return { fromYear, toYear, offsetMinutes };
}

// 老版本档案只有一个偏移与一对生效年份，这里把它迁成只有一段的分段历史
function migrateLegacyPeriods(source) {
  const offset = Number(source.offsetMinutes);
  if (!Number.isInteger(offset) || offset < MIN_OFFSET || offset > MAX_OFFSET) return [];
  const fromRaw = Number(source.fromYear);
  const fromYear = yearInRange(fromRaw) ? fromRaw : MIN_YEAR;
  let toYear = null;
  if (source.toYear !== null && source.toYear !== undefined && source.toYear !== '') {
    const toRaw = Number(source.toYear);
    if (yearInRange(toRaw) && toRaw >= fromYear) toYear = toRaw;
  }
  return [{ fromYear, toYear, offsetMinutes: offset }];
}

// 分段按开始年份排好；文件被手工改坏出现重叠时，同一批年份只保留最早出现的一段
function arrangePeriods(periods) {
  const sorted = periods.slice().sort((a, b) => a.fromYear - b.fromYear);
  const result = [];
  sorted.forEach((period) => {
    const prev = result[result.length - 1];
    if (prev && (prev.toYear === null || period.fromYear <= prev.toYear)) return;
    result.push(period);
  });
  return result;
}

// 把单条时区档案整理成固定结构。分段缺失或全部不合法时返回 null，由上层丢弃
function normalizeZone(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  const usesDst = source.usesDst === true;
  const dstOffsetRaw = Number(source.dstOffsetMinutes);
  const dstOffsetMinutes = usesDst && Number.isInteger(dstOffsetRaw) && dstOffsetRaw >= MIN_OFFSET && dstOffsetRaw <= MAX_OFFSET
    ? dstOffsetRaw
    : null;

  let periods = [];
  if (Array.isArray(source.offsetPeriods)) {
    periods = source.offsetPeriods.map(normalizePeriod).filter(Boolean);
  } else if (source.offsetMinutes !== undefined) {
    periods = migrateLegacyPeriods(source);
  }
  periods = arrangePeriods(periods);
  if (periods.length === 0) return null;

  // 夏令时的生效年份只在实行夏令时时保留，且不早于最早的偏移分段
  let dstFromYear = null;
  let dstToYear = null;
  if (usesDst) {
    if (source.dstFromYear !== undefined) {
      const raw = Number(source.dstFromYear);
      if (yearInRange(raw)) dstFromYear = raw;
    } else {
      const legacy = Number(source.fromYear);
      dstFromYear = yearInRange(legacy) ? legacy : null;
    }
    if (source.dstToYear !== null && source.dstToYear !== undefined && source.dstToYear !== '') {
      const raw = Number(source.dstToYear);
      if (yearInRange(raw)) dstToYear = raw;
    } else if (source.toYear !== null && source.toYear !== undefined && source.toYear !== ''
      && source.dstFromYear === undefined) {
      const raw = Number(source.toYear);
      if (yearInRange(raw)) dstToYear = raw;
    }
    if (dstFromYear !== null && dstToYear !== null && dstToYear < dstFromYear) dstToYear = dstFromYear;
    const earliest = periods[0].fromYear;
    if (dstFromYear !== null && dstFromYear < earliest) dstFromYear = earliest;
    if (dstToYear !== null && dstToYear < earliest) dstToYear = earliest;
  }

  return {
    id: typeof source.id === 'string' && source.id ? source.id : `zone-restored-${fallbackIndex + 1}`,
    name: typeof source.name === 'string' ? source.name.trim() : '',
    displayName: typeof source.displayName === 'string' ? source.displayName.trim() : '',
    offsetPeriods: periods,
    usesDst,
    dstOffsetMinutes,
    dstStart: usesDst ? normalizeRulePart(source.dstStart) : null,
    dstEnd: usesDst ? normalizeRulePart(source.dstEnd) : null,
    dstFromYear,
    dstToYear,
    note: typeof source.note === 'string' ? source.note : '',
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

// 整份数据保证结构一致，缺名称、缺显示名、没有合法分段的档案一律丢掉，名称重复的只留第一条
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawZones = Array.isArray(source.zones) ? source.zones : seedZones();

  const seenIds = new Set();
  const seenNames = new Set();
  const zones = [];
  rawZones.forEach((item, index) => {
    const zone = normalizeZone(item, index);
    if (!zone || !zone.name || !zone.displayName) return;
    const lower = zone.name.toLowerCase();
    if (seenIds.has(zone.id) || seenNames.has(lower)) return;
    seenIds.add(zone.id);
    seenNames.add(lower);
    zones.push(zone);
  });

  return { zones };
}

// 读取数据文件：文件缺失或内容损坏时回落到初始数据并立刻补写
function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    const data = { zones: seedZones() };
    save(data);
    return data;
  }
}

// 先写临时文件再改名，写入中途被打断也不会把正式数据文件写坏
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = `${JSON.stringify(normalize(data), null, 2)}\n`;
  fs.writeFileSync(TEMP_FILE, text, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

module.exports = {
  load,
  save,
  seedZones,
  normalize,
  normalizeZone,
  normalizePeriod,
  normalizeRulePart,
  arrangePeriods,
  WEEKDAY_NAMES,
  MONTH_NAMES,
  MIN_OFFSET,
  MAX_OFFSET,
  MIN_YEAR,
  MAX_YEAR,
  MAX_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PERIODS,
  DATA_FILE,
};
