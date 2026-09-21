// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  // 表单里的偏移分段，输入过程中按文本存着，保存时整体交给服务端校验
  editingPeriods: [],
  lastConvert: null,
};

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.matches('input, select, textarea') ? target : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTH_LABEL = Object.fromEntries(MONTHS);
const WEEK_LABEL = Object.fromEntries(WEEKS);
const WEEKDAY_LABEL = Object.fromEntries(WEEKDAYS);

function ruleText(part) {
  if (!part) return '—';
  const hour = String(part.hour).padStart(2, '0');
  const minute = String(part.minute).padStart(2, '0');
  return `${MONTH_LABEL[String(part.month)] || part.month}${WEEK_LABEL[part.week] || part.week}${WEEKDAY_LABEL[String(part.weekday)] || part.weekday} ${hour}:${minute}`;
}

// 偏移的即时预览：输入过程中让填表人看清这一段写的是几点
function previewOffsetText(value) {
  const raw = Number(value);
  if (!Number.isInteger(raw)) return '偏移待填';
  if (raw < -720 || raw > 840) return '超出范围';
  const sign = raw < 0 ? '-' : '+';
  const abs = Math.abs(raw);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const OPERATOR_KEY = 'zone-clock-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

function fillOptions() {
  const monthOptions = MONTHS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekOptions = WEEKS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekdayOptions = WEEKDAYS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  ['zone-start-month', 'zone-end-month'].forEach((id) => { el(id).innerHTML = monthOptions; });
  ['zone-start-week', 'zone-end-week'].forEach((id) => { el(id).innerHTML = weekOptions; });
  ['zone-start-weekday', 'zone-end-weekday'].forEach((id) => { el(id).innerHTML = weekdayOptions; });
}

async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword');
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderZones();
  renderConvertZoneOptions();
}

// 列表里分段列只放摘要，完整历史放到详情弹窗里
function periodsSummary(item) {
  if (!item.periodCount) return '';
  if (item.periodCount === 1) {
    const only = item.offsetPeriods[0];
    return `<span class="mono">${escapeHtml(only.rangeText)}　${escapeHtml(only.offsetText)}</span>`;
  }
  const transitions = item.offsetPeriods.slice(1)
    .map((period) => `${period.fromYear} 年起改为 ${period.offsetText}`)
    .join('；');
  return `<span class="mono">${escapeHtml(item.coverageText)}</span><br><span class="period-transition">${escapeHtml(transitions)}</span>`;
}

function renderZones() {
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；当前筛选出 ${state.zones.length} 条`;
  const body = el('zone-body');
  body.innerHTML = state.zones.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td class="rule-cell">${periodsSummary(item)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="mono">${item.usesDst ? escapeHtml(item.dstYearRangeText) : '—'}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions">
        <button type="button" class="link" data-zone-detail="${escapeHtml(item.id)}">详情</button>
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.zones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.zones.some((item) => item.id === current)) select.value = current;
}

// ---- 偏移分段编辑器 -----------------------------------------------------

function blankPeriod() {
  return { fromYear: '', toYear: '', offsetMinutes: '' };
}

function setEditingPeriods(periods) {
  state.editingPeriods = (periods && periods.length ? periods : [blankPeriod()])
    .map((period) => ({
      fromYear: period.fromYear === null || period.fromYear === undefined ? '' : String(period.fromYear),
      toYear: period.toYear === null || period.toYear === undefined ? '' : String(period.toYear),
      offsetMinutes: period.offsetMinutes === null || period.offsetMinutes === undefined ? '' : String(period.offsetMinutes),
    }));
  renderPeriodRows();
}

function periodRowHtml(period, index) {
  return `<div class="period-row" data-period-index="${index}">
    <span class="period-index">第 ${index + 1} 段</span>
    <label>开始年份<input class="p-from" value="${escapeHtml(period.fromYear)}" placeholder="例如 1986" maxlength="4"></label>
    <label>结束年份<input class="p-to" value="${escapeHtml(period.toYear)}" placeholder="留空表示至今" maxlength="4"></label>
    <label>偏移（分钟）<input class="p-offset" value="${escapeHtml(period.offsetMinutes)}" placeholder="例如 345" maxlength="6"></label>
    <span class="p-preview mono">${escapeHtml(previewOffsetText(period.offsetMinutes))}</span>
    <button type="button" class="link danger p-del" data-period-del="${index}">删除这一段</button>
  </div>`;
}

function renderPeriodRows() {
  el('period-rows').innerHTML = state.editingPeriods.map(periodRowHtml).join('');
}

// 分段输入框变化时同步到状态并刷新偏移预览，行本身不重绘以免打断输入
el('period-rows').addEventListener('input', (event) => {
  const row = event.target.closest('.period-row');
  if (!row) return;
  const index = Number(row.dataset.periodIndex);
  const period = state.editingPeriods[index];
  if (!period) return;
  if (event.target.classList.contains('p-from')) period.fromYear = event.target.value;
  if (event.target.classList.contains('p-to')) period.toYear = event.target.value;
  if (event.target.classList.contains('p-offset')) {
    period.offsetMinutes = event.target.value;
    const preview = row.querySelector('.p-preview');
    if (preview) preview.textContent = previewOffsetText(event.target.value);
  }
});

el('period-add').addEventListener('click', () => {
  state.editingPeriods.push(blankPeriod());
  renderPeriodRows();
});

el('period-rows').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-period-del]');
  if (!button) return;
  if (state.editingPeriods.length <= 1) {
    notify('至少要保留一个偏移分段，这一段可以直接改成新的年份与偏移', 'error');
    return;
  }
  state.editingPeriods.splice(Number(button.dataset.periodDel), 1);
  renderPeriodRows();
});

// ---- 档案表单 -----------------------------------------------------------

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
  el('zone-form-title').textContent = zone ? `编辑档案：${zone.name}` : '新建档案';
  el('zone-name').value = zone ? zone.name : '';
  el('zone-display').value = zone ? zone.displayName : '';
  setEditingPeriods(zone ? zone.offsetPeriods : null);
  el('zone-uses-dst').checked = zone ? zone.usesDst : false;
  el('zone-dst-offset').value = zone && zone.dstOffsetMinutes !== null ? String(zone.dstOffsetMinutes) : '';
  const start = zone && zone.dstStart ? zone.dstStart : { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 };
  const end = zone && zone.dstEnd ? zone.dstEnd : { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 };
  el('zone-start-month').value = String(start.month);
  el('zone-start-week').value = start.week;
  el('zone-start-weekday').value = String(start.weekday);
  el('zone-start-hour').value = String(start.hour);
  el('zone-start-minute').value = String(start.minute);
  el('zone-end-month').value = String(end.month);
  el('zone-end-week').value = end.week;
  el('zone-end-weekday').value = String(end.weekday);
  el('zone-end-hour').value = String(end.hour);
  el('zone-end-minute').value = String(end.minute);
  el('zone-dst-from-year').value = zone && zone.dstFromYear !== null ? String(zone.dstFromYear) : '';
  el('zone-dst-to-year').value = zone && zone.dstToYear !== null ? String(zone.dstToYear) : '';
  el('zone-note').value = zone ? zone.note : '';
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function closeZoneForm() {
  state.editingId = '';
  el('zone-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitZone(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('zone-name').value,
    displayName: el('zone-display').value,
    offsetPeriods: state.editingPeriods.map((period) => ({
      fromYear: period.fromYear,
      toYear: period.toYear === '' ? null : period.toYear,
      offsetMinutes: period.offsetMinutes,
    })),
    usesDst: el('zone-uses-dst').checked,
    dstOffsetMinutes: el('zone-dst-offset').value === '' ? null : el('zone-dst-offset').value,
    dstStart: {
      month: el('zone-start-month').value,
      week: el('zone-start-week').value,
      weekday: el('zone-start-weekday').value,
      hour: el('zone-start-hour').value,
      minute: el('zone-start-minute').value,
    },
    dstEnd: {
      month: el('zone-end-month').value,
      week: el('zone-end-week').value,
      weekday: el('zone-end-weekday').value,
      hour: el('zone-end-hour').value,
      minute: el('zone-end-minute').value,
    },
    dstFromYear: el('zone-dst-from-year').value === '' ? null : el('zone-dst-from-year').value,
    dstToYear: el('zone-dst-to-year').value === '' ? null : el('zone-dst-to-year').value,
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
    payload.dstFromYear = null;
    payload.dstToYear = null;
  }
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/zones/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('时区档案已保存', 'ok');
    } else {
      await request('/api/zones', { method: 'POST', body: JSON.stringify(payload) });
      notify('时区档案已新增', 'ok');
    }
    closeZoneForm();
    await loadZones();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// ---- 档案详情：完整分段历史都在这里看 -----------------------------------

async function openDetail(id) {
  let zone = state.zones.find((item) => item.id === id);
  // 清单可能正被筛选或关键词过滤着，找不到时直接向服务端要这一条
  if (!zone) {
    try {
      zone = await request(`/api/zones/${encodeURIComponent(id)}`);
    } catch (err) {
      notify(err.message, 'error');
      return;
    }
  }

  const periodRows = zone.offsetPeriods.map((period, index) => `<tr${period.toYear === null ? ' class="current-period"' : ''}>
      <td>第 ${index + 1} 段${index === zone.offsetPeriods.length - 1 ? '（当前）' : ''}</td>
      <td class="mono">${period.fromYear}</td>
      <td class="mono">${period.toYear === null ? '至今' : period.toYear}</td>
      <td class="mono">${escapeHtml(period.offsetText)}</td>
    </tr>`).join('');

  const dstBlock = zone.usesDst ? `
    <h4>夏令时规则</h4>
    <dl class="detail-list">
      <dt>夏令时偏移</dt><dd class="mono">${escapeHtml(zone.dstOffsetText)}</dd>
      <dt>开始规则</dt><dd>${escapeHtml(ruleText(zone.dstStart))}</dd>
      <dt>结束规则</dt><dd>${escapeHtml(ruleText(zone.dstEnd))}</dd>
      <dt>夏令时生效年份</dt><dd class="mono">${escapeHtml(zone.dstYearRangeText)}</dd>
    </dl>` : '<p class="detail-muted">这条档案不实行夏令时。</p>';

  el('detail-title').textContent = `档案详情：${zone.name}`;
  el('detail-body').innerHTML = `
    <dl class="detail-list">
      <dt>时区名称</dt><dd class="mono">${escapeHtml(zone.name)}</dd>
      <dt>显示名称</dt><dd>${escapeHtml(zone.displayName)}</dd>
      <dt>当前偏移</dt><dd class="mono">${escapeHtml(zone.offsetText)}</dd>
      <dt>分段覆盖</dt><dd class="mono">${escapeHtml(zone.coverageText)}</dd>
      <dt>备注</dt><dd>${escapeHtml(zone.note) || '—'}</dd>
      <dt>登记时间</dt><dd>${escapeHtml(formatTime(zone.createdAt))}</dd>
      <dt>最近修改</dt><dd>${escapeHtml(formatTime(zone.updatedAt))}</dd>
    </dl>
    <h4>偏移分段历史（${zone.periodCount} 段）</h4>
    <div class="table-wrap">
      <table class="grid detail-table">
        <thead><tr><th>段次</th><th>开始年份</th><th>结束年份</th><th>这段期间的偏移</th></tr></thead>
        <tbody>${periodRows}</tbody>
      </table>
    </div>
    ${dstBlock}`;
  el('detail-mask').classList.remove('hidden');
}

function closeDetail() {
  el('detail-mask').classList.add('hidden');
}

// ---- 换算台 -------------------------------------------------------------

async function runConvert() {
  clearNotice();
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
  };
  try {
    const result = await request('/api/convert', { method: 'POST', body: JSON.stringify(payload) });
    state.lastConvert = result;
    renderConvert(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

function renderConvertRow(item) {
  if (!item.available) {
    return `<tr class="unavailable-row">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td colspan="4"><span class="tag danger-tag">${escapeHtml(String(item.inputYear))} 年没有可用偏移</span></td>
      <td class="mono">—</td>
      <td class="rule-cell unavailable-reason" colspan="2">${escapeHtml(item.unavailableReason)}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`;
  }
  return `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.localDate)}</td>
      <td class="mono">${escapeHtml(item.localTime)}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td class="rule-cell">${escapeHtml(item.periodRangeText)}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`;
}

function renderConvert(result) {
  el('convert-meta').textContent = `来源 ${result.input.zoneName}（${result.input.zoneDisplayName}）在 ${result.input.year} 年落在「${result.input.sourcePeriodText}」这段，偏移 ${result.input.offsetText}；输入 ${result.input.date} ${result.input.time}，换算时刻 ${formatTime(result.convertedAt)}。参与换算的档案 ${result.zonesInScope} 条：可用 ${result.availableCount} 条，该年没有分段覆盖、按不可用处理的 ${result.unavailableCount} 条；可用行里与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${Math.floor(result.maxDiffMinutes / 60)} 小时 ${result.maxDiffMinutes % 60} 分`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => renderConvertRow({ ...item, inputYear: result.input.year })).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneDetail) {
    clearNotice();
    await openDetail(node.dataset.zoneDetail);
    return;
  }

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneDelete) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？`)) return;
    try {
      await request(`/api/zones/${encodeURIComponent(node.dataset.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.zoneDelete) closeZoneForm();
      notify('时区档案已删除', 'ok');
      await loadZones();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('zone-form').addEventListener('submit', submitZone);
el('zone-new').addEventListener('click', () => {
  clearNotice();
  openZoneForm(null);
});
el('zone-cancel').addEventListener('click', closeZoneForm);
el('zone-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-reset').addEventListener('click', () => {
  el('zone-filter-dst').value = '';
  el('zone-filter-keyword').value = '';
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-refresh').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-dst').addEventListener('change', () => {
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('convert-run').addEventListener('click', runConvert);
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});
el('detail-close').addEventListener('click', closeDetail);
el('detail-mask').addEventListener('click', (event) => {
  if (event.target === el('detail-mask')) closeDetail();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el('detail-mask').classList.contains('hidden')) closeDetail();
});

// 页面打开时先把档案拉一遍，换算台的来源时区下拉按这份清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
loadZones().catch((err) => notify(err.message, 'error'));
