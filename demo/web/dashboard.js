'use strict';

const $ = id => document.getElementById(id);
const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const phases = { WAITING: 'รอเริ่มตลาด', SETUP: 'เตรียมตลาด', APPRAISAL: 'ประเมินมูลค่า',
  ROUND_OPEN: 'เปิดรับซอง', ROUND_CLEARING: 'จับคู่แล้ว', CLOSED: 'ปิดตลาด' };
const statusLabels = { OPEN: 'ยื่นแล้ว', ACCEPTED: 'ขายได้', PARTIAL: 'ขายบางส่วน',
  OUTBID: 'ถูกแย่งซื้อ', ABOVE_LIMIT: 'เกินเพดาน', SPEC_MISMATCH: 'ไม่ผ่านสเปก' };
const agentLabels = { idle: 'เอเจนต์พร้อม', running: 'optimized-v2 กำลังทำงาน',
  closed: 'เอเจนต์จบเกม', external: 'รอเอเจนต์ภายนอก', connected: 'optimized-v2 เชื่อมต่อแล้ว',
  error: 'เอเจนต์พบข้อผิดพลาด' };
const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = text => String(text).replace(/[&<>"']/g, ch => escapes[ch]);
let calendar = [];
let busy = false;
let pending = false;
let viewing;
let resultsKey = '';

function label(id, value) {
  if ($(id).textContent !== String(value)) $(id).textContent = value;
}

async function request(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || response.status);
  return data;
}

function render({ state, reveal, events, results, agentStatus }) {
  const { round, phase, standings } = state;
  const { round_id: current, number = -1 } = round || {};
  label('phase', [current, phases[phase]].filter(Boolean).join(' · '));
  label('duration', state.seconds_left == null ? (round?.calendar ?? phases[phase])
    : `${round?.calendar ?? phases[phase]} · เหลือ ${Math.ceil(state.seconds_left)} วิ`);
  $('calendar').innerHTML = calendar.map(item => {
    const category = item.number >= 13 ? 'late' : item.number >= 6 && item.number <= 8 ? 'festival' : '';
    const mark = item.number < number || phase === 'CLOSED' ? ' done' : '';
    return `<li class="${category}${mark}" title="${safe(item.calendar)}"${current === item.round_id && phase !== 'CLOSED' ? ' aria-current="step"' : ''}>${item.round_id}</li>`;
  }).join('');
  $('start').hidden = phase !== 'WAITING';
  $('start').disabled = busy;
  $('speed').disabled = phase !== 'WAITING' || busy;
  $('advance').hidden = ['WAITING', 'CLOSED'].includes(phase);
  $('advance').disabled = busy;
  $('advance').textContent = phase === 'ROUND_OPEN' ? 'ปิดรับซอง' : 'ไปขั้นถัดไป';
  $('reset').hidden = phase === 'WAITING';
  $('reset').disabled = busy;
  label('revenue', num.format(standings.revenue_thb));
  label('sold', num.format(standings.kg_sold));
  label('stock', num.format(standings.kg_remaining));
  label('pr', reveal ? percent.format(reveal.pr) : '—');
  label('pr-note', reveal ? 'รวมมูลค่าขายซาก' : 'แสดงเมื่อปิดตลาด');
  $('scorecard').hidden = !reveal;
  if (reveal) {
    $('score').innerHTML = [
      ['TV รวม', `${num.format(reveal.total_tv_thb)} บาท`],
      ['มูลค่าขายซาก', `${num.format(reveal.salvage_thb)} บาท`],
      ['รายได้รวมขายซาก', `${num.format(reveal.revenue_thb + reveal.salvage_thb)} บาท`],
      ['คะแนนประเมิน', `${num.format(reveal.appraisal_points)} / 20`],
    ].map(([title, value]) => `<div><dt>${title}</dt><dd>${value}</dd></div>`).join('');
  }
  label('appraisal', state.appraisal_submitted ? 'ส่งผลประเมินแล้ว' : 'รอประเมิน');
  $('lots').innerHTML = state.lots.map(lot => `<tr><td><strong>${safe(lot.lot_id)}</strong><small>${safe(lot.origin)} · ${safe(lot.process)}</small></td>
    <td>${num.format(lot.sample.defect_pct)}%</td><td>${num.format(lot.sample.moisture_pct)}%</td>
    <td>${lot.sample.screen}</td><td>${num.format(lot.kg_remaining)} / ${num.format(lot.kg_total)}</td></tr>`).join('');
  label('capacity', phase === 'ROUND_OPEN' ? `เสนอเพิ่มได้ ${num.format(state.capacity_left_kg)} กก.` : '');
  $('rfqs').innerHTML = state.rfqs.map(rfq => {
    const spec = rfq.spec;
    return `<div class="rfq"><strong>${safe(rfq.buyer)}</strong><span class="order-kg">${num.format(rfq.kg)} กก.</span>
      <small>${safe(rfq.buyer_type)} · ตำหนิ ≤ ${spec.max_defect_pct}% · ชื้น ≤ ${spec.max_moisture_pct}%${spec.min_screen ? ` · Screen ≥ ${spec.min_screen}` : ''}</small></div>`;
  }).join('') || '<p class="empty">แสดงคำขอซื้อเมื่อเปิดรับซอง</p>';
  const key = results.map(result => result.round_id).join();
  if (key !== resultsKey) {
    const selected = $('result-picker').value;
    $('result-picker').innerHTML = '<option value="">ล่าสุด</option>' +
      results.slice().reverse().map(r => `<option value="${r.round_id}">${r.round_id}</option>`).join('');
    $('result-picker').value = results.some(result => result.round_id === selected) ? selected : '';
    resultsKey = key;
  }
  const selected = $('result-picker').value;
  const shown = selected ? results.find(r => r.round_id === selected)?.my_offers
    : phase === 'ROUND_OPEN' ? state.my_open_offers : state.last_results?.my_offers;
  $('offers').innerHTML = (shown || []).map(o => `<tr><td>${safe(o.lot_id)}<small>${safe(o.rfq_id)}</small></td>
    <td>${num.format(o.price_per_kg)}</td><td>${num.format(o.kg)}</td>
    <td>${o.filled_kg == null ? '—' : num.format(o.filled_kg)}</td>
    <td><span class="tag ${safe(o.status.toLowerCase())}">${safe(statusLabels[o.status] || o.status)}</span></td></tr>`).join('')
    || '<tr><td class="empty" colspan="5">ยังไม่มีซองในรอบที่แสดง</td></tr>';
  label('agent', agentLabels[agentStatus] || agentStatus);
  $('events').innerHTML = events.slice(-14).reverse().map(e =>
    `<li><time datetime="${safe(e.at)}">${time.format(new Date(e.at))}</time><b>${safe(e.method)} ${safe(e.path)}</b><small>${safe(e.detail)}</small></li>`
  ).join('') || '<li>คำขอ API จะแสดงเมื่อเริ่มเดโม</li>';
}

function showError(error) {
  $('error').hidden = !error;
  label('error', error?.message || '');
}

async function refresh() {
  if (pending || busy) return;
  pending = true;
  try {
    viewing = await request('/demo/session');
    render(viewing);
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
  }
}

async function control(path, body) {
  if (busy) return;
  busy = true;
  if (viewing) render(viewing);
  showError(null);
  try {
    await request(path, body);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    await refresh();
  }
}

$('start').addEventListener('click', () => {
  const speed = $('speed').value;
  control('/demo/start', { automatic: speed !== 'manual', roundSeconds: Number(speed) || 8 });
});
$('advance').addEventListener('click', () => control('/demo/advance', {}));
$('reset').addEventListener('click', () => control('/v1/sandbox/reset', {}));
$('result-picker').addEventListener('change', () => { if (viewing) render(viewing); });

request('/v1/calendar').then(data => {
  calendar = data.calendar;
  refresh();
  setInterval(refresh, 450);
}).catch(showError);
