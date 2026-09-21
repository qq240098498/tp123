// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  detailId: '',
  formSegments: [],
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
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderZones();
  renderConvertZoneOptions();
}

function renderZones() {
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；当前筛选出 ${state.zones.length} 条`;
  const body = el('zone-body');
  body.innerHTML = state.zones.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="seg-cell"><span class="tag ${item.segmentCount > 1 ? 'warn' : 'off'}">${item.segmentCount} 段</span><span class="mono seg-years">${escapeHtml(item.yearRangeText)}</span></td>
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

function emptySegmentRow() {
  return { fromYear: '', toYear: '', offsetMinutes: '' };
}

function renderSegmentRows() {
  const box = el('segment-rows');
  box.innerHTML = state.formSegments.map((seg, index) => `
    <div class="segment-row">
      <span class="seg-index">第 ${index + 1} 段${index === state.formSegments.length - 1 ? '<em>（最后一段）</em>' : ''}</span>
      <label data-field="segments[${index}].fromYear"><input data-seg-index="${index}" data-seg-key="fromYear" value="${escapeHtml(seg.fromYear)}" placeholder="例如 1949" maxlength="4"></label>
      <label data-field="segments[${index}].toYear"><input data-seg-index="${index}" data-seg-key="toYear" value="${escapeHtml(seg.toYear)}" placeholder="留空表示至今" maxlength="4"></label>
      <label data-field="segments[${index}].offsetMinutes"><input data-seg-index="${index}" data-seg-key="offsetMinutes" value="${escapeHtml(seg.offsetMinutes)}" placeholder="例如 480" maxlength="6"></label>
      <button type="button" class="link danger" data-seg-remove="${index}"${state.formSegments.length <= 1 ? ' disabled' : ''}>删除这一段</button>
    </div>`).join('');
}

function syncSegmentInput(node) {
  const index = Number(node.dataset.segIndex);
  const key = node.dataset.segKey;
  if (!state.formSegments[index]) return;
  state.formSegments[index][key] = node.value.trim();
}

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
  el('zone-form-title').textContent = zone ? `编辑档案：${zone.name}` : '新建档案';
  el('zone-name').value = zone ? zone.name : '';
  el('zone-display').value = zone ? zone.displayName : '';
  el('zone-uses-dst').checked = zone ? zone.usesDst : false;
  el('zone-dst-offset').value = zone && zone.dstOffsetMinutes !== null && zone.dstOffsetMinutes !== undefined ? String(zone.dstOffsetMinutes) : '';
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
  el('zone-note').value = zone ? zone.note : '';
  if (zone && Array.isArray(zone.segments) && zone.segments.length) {
    state.formSegments = zone.segments.map((seg) => ({
      fromYear: String(seg.fromYear),
      toYear: seg.toYear === null ? '' : String(seg.toYear),
      offsetMinutes: String(seg.offsetMinutes),
    }));
  } else {
    state.formSegments = [emptySegmentRow()];
  }
  renderSegmentRows();
  el('zone-detail').classList.add('hidden');
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function closeZoneForm() {
  state.editingId = '';
  state.formSegments = [];
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
    segments: state.formSegments.map((seg) => ({
      fromYear: seg.fromYear,
      toYear: seg.toYear === '' ? null : seg.toYear,
      offsetMinutes: seg.offsetMinutes,
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
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
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

// ---- 档案详情：完整分段历史 + 按年查偏移 -------------------------------

async function openZoneDetail(id) {
  clearNotice();
  try {
    const zone = await request(`/api/zones/${encodeURIComponent(id)}`);
    state.detailId = zone.id;
    el('detail-title').textContent = `档案详情：${zone.name}`;
    el('detail-year').value = '';
    el('detail-year-result').textContent = '填上年份查询，年份落在哪一段就取哪一段的偏移';
    el('detail-year-result').className = 'detail-year-result';
    const segmentRows = zone.segments.map((seg, index) => `
      <tr>
        <td>第 ${index + 1} 段${seg.toYear === null ? ' <span class="tag on">当前</span>' : ''}</td>
        <td class="mono">${escapeHtml(seg.yearsText)}</td>
        <td class="mono">${escapeHtml(seg.offsetText)}</td>
        <td class="mono">${seg.offsetMinutes} 分钟</td>
      </tr>`).join('');
    el('detail-body').innerHTML = `
      <dl class="detail-grid">
        <dt>时区名称</dt><dd class="mono">${escapeHtml(zone.name)}</dd>
        <dt>显示名称</dt><dd>${escapeHtml(zone.displayName)}</dd>
        <dt>当前偏移</dt><dd class="mono">${escapeHtml(zone.offsetText)}（${zone.offsetMinutes} 分钟）</dd>
        <dt>整体生效年份</dt><dd class="mono">${escapeHtml(zone.yearRangeText)}</dd>
        <dt>夏令时</dt><dd>${zone.usesDst ? `实行，夏令时偏移 <span class="mono">${escapeHtml(zone.dstOffsetText)}</span>，${escapeHtml(ruleText(zone.dstStart))} 起，${escapeHtml(ruleText(zone.dstEnd))} 止` : '不实行'}</dd>
        <dt>备注</dt><dd>${escapeHtml(zone.note) || '—'}</dd>
      </dl>
      <h4>偏移分段历史（共 ${zone.segmentCount} 段）</h4>
      <div class="table-wrap">
        <table class="grid detail-table">
          <thead><tr><th>段次</th><th>生效年份</th><th>偏移</th><th>分钟数</th></tr></thead>
          <tbody>${segmentRows}</tbody>
        </table>
      </div>`;
    el('zone-form').classList.add('hidden');
    el('zone-detail').classList.remove('hidden');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function lookupDetailYear() {
  clearNotice();
  const result = el('detail-year-result');
  if (!state.detailId) return;
  const year = el('detail-year').value.trim();
  if (!year) {
    result.textContent = '请先填写要查询的年份';
    result.className = 'detail-year-result bad';
    return;
  }
  try {
    const data = await request(`/api/zones/${encodeURIComponent(state.detailId)}/offset?year=${encodeURIComponent(year)}`);
    if (data.available) {
      result.textContent = `${data.year} 年落在「${data.segmentYearsText}」这一段，实际偏移 ${data.offsetText}（${data.offsetMinutes} 分钟）`;
      result.className = 'detail-year-result ok';
    } else {
      result.textContent = `${data.year} 年不可用：${data.reason}`;
      result.className = 'detail-year-result bad';
    }
  } catch (err) {
    result.textContent = err.message;
    result.className = 'detail-year-result bad';
    markField(err.field);
  }
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

function renderConvert(result) {
  const maxHour = Math.floor(result.maxDiffMinutes / 60);
  const maxMinute = result.maxDiffMinutes % 60;
  const unavailableNote = result.unavailableCount > 0
    ? `；${result.unavailableCount} 条在 ${result.input.year} 年没有分段覆盖，按不可用处理`
    : '';
  el('convert-meta').textContent = `来源 ${result.input.zoneName}（${result.input.zoneDisplayName}，${result.input.year} 年落在「${result.input.sourceSegmentYearsText}」段，偏移 ${result.input.offsetText}）的 ${result.input.date} ${result.input.time}，换算时刻 ${formatTime(result.convertedAt)}；参与换算的档案 ${result.zonesInScope} 条，可用 ${result.availableCount} 条，与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${maxHour} 小时 ${maxMinute} 分${unavailableNote}`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}${item.available ? '' : ' unavailable-row'}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${item.available ? escapeHtml(item.localDate) : '—'}</td>
      <td class="mono">${item.available ? escapeHtml(item.localTime) : '—'}</td>
      <td>${item.available ? escapeHtml(item.weekday) : '—'}</td>
      <td><span class="tag ${item.available ? (item.dayOffset === 0 ? 'off' : 'warn') : 'off'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${item.available ? escapeHtml(item.offsetText) : '<span class="tag off">不可用</span>'}</td>
      <td class="mono">${item.available ? escapeHtml(item.segmentYearsText) : '—'}</td>
      <td class="reason-cell"${item.available ? '' : ` title="${escapeHtml(item.unavailableReason)}"`}>${item.available ? escapeHtml(item.diffText) : `<span class="unavailable-reason">${escapeHtml(item.unavailableReason)}</span>`}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

// 列表与分段编辑器上的操作用事件委托统一处理，重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneDetail) {
    await openZoneDetail(node.dataset.zoneDetail);
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
      if (state.detailId === node.dataset.zoneDelete) el('zone-detail').classList.add('hidden');
      notify('时区档案已删除', 'ok');
      await loadZones();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.id === 'segment-add') {
    state.formSegments.push(emptySegmentRow());
    renderSegmentRows();
    return;
  }

  if (node.dataset.segRemove !== undefined) {
    const index = Number(node.dataset.segRemove);
    if (state.formSegments.length > 1) {
      state.formSegments.splice(index, 1);
      renderSegmentRows();
    }
  }
});

// 分段输入框的输入实时同步回内存里的分段表
el('segment-rows').addEventListener('input', (event) => {
  const input = event.target.closest('input[data-seg-index]');
  if (input) syncSegmentInput(input);
});

el('zone-form').addEventListener('submit', submitZone);
el('zone-new').addEventListener('click', () => {
  clearNotice();
  openZoneForm(null);
});
el('zone-cancel').addEventListener('click', closeZoneForm);
el('detail-close').addEventListener('click', () => {
  state.detailId = '';
  el('zone-detail').classList.add('hidden');
});
el('detail-year-run').addEventListener('click', lookupDetailYear);
el('detail-year').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    lookupDetailYear();
  }
});
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

// 页面打开时先把档案拉一遍，换算台的来源时区下拉按这份清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
loadZones().catch((err) => notify(err.message, 'error'));
