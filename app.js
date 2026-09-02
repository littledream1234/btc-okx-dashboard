/* BTC-USDT-SWAP 工作台：只使用 OKX 公開市場 API，不傳送交易指令。 */
const API = 'https://www.okx.com/api/v5';
const INSTRUMENT = 'BTC-USDT-SWAP';
const storageKey = 'btcSwapJournalV1';
const checklistKey = 'btcSwapChecklistV1';
const oiSnapshotKey = 'btcSwapOiSnapshotV1';

const state = {
  last: null, mark: null, funding: null, openInterest: null, contractValue: 0.01,
  candles: [], candles15m: [], candles4h: [], ema20: [], ema50: [], report: null
};
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money = (value, digits = 2) => Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value, suffix = '') => `${value >= 0 ? '+' : ''}${money(value)}${suffix}`;
const taipeiDate = (date = new Date()) => {
  const fields = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => fields.find(field => field.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

function setConnection(status, text) {
  const element = $('connection-status');
  element.className = `connection ${status}`;
  element.lastElementChild.textContent = text;
}

async function getJson(path) {
  const response = await fetch(`${API}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.code && json.code !== '0') throw new Error(json.msg || `OKX error ${json.code}`);
  return json.data;
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const results = [];
  let previous = values[0];
  values.forEach((value, index) => {
    previous = index === 0 ? value : (value - previous) * multiplier + previous;
    results.push(previous);
  });
  return results;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const diff = values[i] - values[i - 1]; gains += Math.max(diff, 0); losses += Math.max(-diff, 0); }
  let averageGain = gains / period, averageLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) { const diff = values[i] - values[i - 1]; averageGain = (averageGain * (period - 1) + Math.max(diff, 0)) / period; averageLoss = (averageLoss * (period - 1) + Math.max(-diff, 0)) / period; }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index].close), Math.abs(candle.low - candles[index].close)));
  return ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function parseCandles(data) {
  return data.slice().reverse().map(row => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[5]), quoteVolume: Number(row[7]), confirmed: row[8] === '1'
  }));
}

function technicals(candles) {
  const completed = candles.filter(candle => candle.confirmed);
  const series = completed.length >= 55 ? completed : candles;
  if (series.length < 55) return null;
  const closes = series.map(candle => candle.close);
  const ema20Values = ema(closes, 20), ema50Values = ema(closes, 50);
  const latest = series.at(-1), recent = series.slice(-20), volumes = recent.map(candle => candle.quoteVolume || candle.volume);
  const averageVolume = volumes.reduce((sum, value) => sum + value, 0) / volumes.length;
  return {
    latest, lastClose: latest.close, ema20: ema20Values.at(-1), ema50: ema50Values.at(-1),
    ema50Slope: ema50Values.at(-1) - ema50Values.at(-4), rsi: rsi(closes), atr: atr(series),
    volumeRatio: averageVolume ? (volumes.at(-1) / averageVolume) : 1,
    swingHigh: Math.max(...recent.map(candle => candle.high)), swingLow: Math.min(...recent.map(candle => candle.low)),
    lastCandleTime: latest.time
  };
}

function updateOpenInterest(data) {
  if (!data) return null;
  const current = { oi: Number(data.oi), oiCcy: Number(data.oiCcy), oiUsd: Number(data.oiUsd), ts: Number(data.ts) };
  try {
    const previous = JSON.parse(localStorage.getItem(oiSnapshotKey) || 'null');
    if (previous?.oiUsd > 0 && current.ts > previous.ts && current.ts - previous.ts <= 6 * 60 * 60 * 1000) current.changePct = (current.oiUsd - previous.oiUsd) / previous.oiUsd * 100;
    localStorage.setItem(oiSnapshotKey, JSON.stringify(current));
  } catch { /* OI is optional data; a blocked local store must not break analysis. */ }
  return current;
}

function reportClass(direction) { return direction === 'long' ? 'positive' : direction === 'short' ? 'negative' : 'neutral'; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

function calculateDirectionReport() {
  const h4 = technicals(state.candles4h), h1 = technicals(state.candles), m15 = technicals(state.candles15m);
  if (!h4 || !h1 || !m15 || !state.last || !state.funding) return null;
  const fundingRate = state.funding.rate;
  const spreadBps = state.ticker?.bid && state.ticker?.ask ? ((state.ticker.ask - state.ticker.bid) / state.last) * 10000 : null;
  const longRules = [
    { weight: 25, label: '4H EMA20 高於 EMA50', pass: h4.ema20 > h4.ema50 },
    { weight: 10, label: '4H EMA50 斜率向上', pass: h4.ema50Slope > 0 },
    { weight: 25, label: '1H 趨勢與價格在 EMA50 上方', pass: h1.ema20 > h1.ema50 && state.last > h1.ema50 },
    { weight: 15, label: '1H 動能：價格在 EMA20 上方且 RSI 50–70', pass: state.last > h1.ema20 && h1.rsi >= 50 && h1.rsi <= 70 },
    { weight: 15, label: '15m 確認：站上 EMA20、RSI ≥ 48、量能非萎縮', pass: m15.lastClose > m15.ema20 && m15.rsi >= 48 && m15.volumeRatio >= .8 },
    { weight: 10, label: '資金費率未達擁擠多頭門檻（≤ 0.05%）', pass: fundingRate <= .0005 }
  ];
  const shortRules = [
    { weight: 25, label: '4H EMA20 低於 EMA50', pass: h4.ema20 < h4.ema50 },
    { weight: 10, label: '4H EMA50 斜率向下', pass: h4.ema50Slope < 0 },
    { weight: 25, label: '1H 趨勢與價格在 EMA50 下方', pass: h1.ema20 < h1.ema50 && state.last < h1.ema50 },
    { weight: 15, label: '1H 動能：價格在 EMA20 下方且 RSI 30–50', pass: state.last < h1.ema20 && h1.rsi >= 30 && h1.rsi <= 50 },
    { weight: 15, label: '15m 確認：位於 EMA20 下方、RSI ≤ 52、量能非萎縮', pass: m15.lastClose < m15.ema20 && m15.rsi <= 52 && m15.volumeRatio >= .8 },
    { weight: 10, label: '資金費率未達擁擠空頭門檻（≥ -0.05%）', pass: fundingRate >= -.0005 }
  ];
  const longScore = longRules.filter(rule => rule.pass).reduce((sum, rule) => sum + rule.weight, 0);
  const shortScore = shortRules.filter(rule => rule.pass).reduce((sum, rule) => sum + rule.weight, 0);
  const stale = Date.now() - Number(state.ticker.ts) > 5 * 60 * 1000;
  const liquidityIssue = spreadBps !== null && spreadBps > 5;
  const longAligned = longRules[0].pass && longRules[2].pass;
  const shortAligned = shortRules[0].pass && shortRules[2].pass;
  let direction = 'wait', score = Math.max(longScore, shortScore), status = '不交易／等待', subtitle = '多週期方向未一致或資料條件尚不足，因此不給出單邊交易方案。';
  if (!stale && !liquidityIssue && longAligned && longScore >= 70 && longScore - shortScore >= 15) {
    direction = 'long'; status = '偏多：等待回踩確認'; subtitle = '高週期與 1H 結構偏多；此為等待回踩的條件式方案，不是立即追價指令。';
  } else if (!stale && !liquidityIssue && shortAligned && shortScore >= 70 && shortScore - longScore >= 15) {
    direction = 'short'; status = '偏空：等待反彈確認'; subtitle = '高週期與 1H 結構偏空；此為等待反彈的條件式方案，不是立即追空指令。';
  } else if (stale) subtitle = '市場資料時間過期，暫停產生方向結論。';
  else if (liquidityIssue) subtitle = `買賣價差約 ${money(spreadBps, 2)} bps，高於 5 bps 門檻，暫不交易。`;
  const activeRules = direction === 'long' ? longRules : direction === 'short' ? shortRules : (longScore >= shortScore ? longRules : shortRules);
  const plan = direction === 'wait' ? null : createConditionalPlan(direction, h1, m15);
  return { direction, status, subtitle, score, longScore, shortScore, rules: activeRules, h4, h1, m15, plan, fundingRate, spreadBps, stale, liquidityIssue, oi: state.openInterest, createdAt: Date.now() };
}

function createConditionalPlan(direction, h1, m15) {
  const isLong = direction === 'long';
  const entryLow = isLong ? h1.ema20 - h1.atr * .2 : h1.ema20 - h1.atr * .1;
  const entryHigh = isLong ? h1.ema20 + h1.atr * .1 : h1.ema20 + h1.atr * .2;
  const entry = (entryLow + entryHigh) / 2;
  let stop = isLong ? Math.min(h1.swingLow, entryLow - h1.atr * .35) : Math.max(h1.swingHigh, entryHigh + h1.atr * .35);
  if (isLong && stop >= entry) stop = entry - h1.atr;
  if (!isLong && stop <= entry) stop = entry + h1.atr;
  const risk = Math.abs(entry - stop), tp1 = isLong ? entry + risk : entry - risk, tp2 = isLong ? entry + risk * 2 : entry - risk * 2;
  const withinZone = state.last >= entryLow && state.last <= entryHigh;
  const trigger = isLong
    ? `15m 在 ${money(entryLow)}–${money(entryHigh)} 區間回踩後，收盤重新站上 EMA20／回踩高點。`
    : `15m 反彈至 ${money(entryLow)}–${money(entryHigh)} 區間後，收盤重新跌回 EMA20／反彈低點下方。`;
  const invalidation = isLong ? `15m 收盤跌破 ${money(entryLow - m15.atr * .2)}，或交易觸及止損。` : `15m 收盤突破 ${money(entryHigh + m15.atr * .2)}，或交易觸及止損。`;
  return { entryLow, entryHigh, entry, stop, risk, tp1, tp2, rr: 2, withinZone, trigger, invalidation };
}

function reportText(report) {
  const directionText = report.direction === 'long' ? '偏多（等待回踩確認）' : report.direction === 'short' ? '偏空（等待反彈確認）' : '不交易／等待';
  const lines = [
    `BTC-USDT-SWAP｜trend-retest-v1｜評估時間 ${new Date(report.createdAt).toLocaleString('zh-TW')}`,
    '', `決策：${directionText}`, `規則符合度：${report.score}/100（不是勝率）`, `多方分數：${report.longScore}/100｜空方分數：${report.shortScore}/100`, `說明：${report.subtitle}`, '', '使用數據：',
    `現價：${money(state.last)}｜標記價：${money(state.mark)}｜24H：${signed(state.ticker.change, '%')}`,
    `4H EMA20/EMA50：${money(report.h4.ema20)} / ${money(report.h4.ema50)}｜RSI：${money(report.h4.rsi)}`,
    `1H EMA20/EMA50：${money(report.h1.ema20)} / ${money(report.h1.ema50)}｜RSI：${money(report.h1.rsi)}｜ATR：${money(report.h1.atr)}`,
    `15m RSI：${money(report.m15.rsi)}｜量能比：${money(report.m15.volumeRatio)}×｜資金費率：${signed(report.fundingRate * 100, '%')}`,
    `未平倉量：${report.oi ? `${money(report.oi.oiCcy, 2)} BTC（僅快照，不單獨判定方向）` : '資料未提供'}`,
    '', '判定條件：', ...report.rules.map(rule => `- [${rule.pass ? '通過' : '未通過'}] ${rule.label}`)
  ];
  if (report.plan) lines.push('', '條件式方案（確認前不進場）：', `進場區：${money(report.plan.entryLow)}–${money(report.plan.entryHigh)}`, `觸發：${report.plan.trigger}`, `止損：${money(report.plan.stop)}｜TP1：${money(report.plan.tp1)}（1R）｜TP2：${money(report.plan.tp2)}（2R）`, `失效：${report.plan.invalidation}`, '提醒：請用風控頁依你的帳戶與單筆風險上限重新計算張數。');
  else lines.push('', `等待條件：1H 收盤上破 ${money(report.h1.swingHigh)} 或下破 ${money(report.h1.swingLow)} 後，再等待 15m 完成確認。`);
  lines.push('', '此為規則型市場分析與風險管理輔助，不構成投資建議或獲利保證。');
  return lines.join('\n');
}

function renderTradeReport() {
  const report = calculateDirectionReport();
  if (!report) return;
  state.report = report;
  const className = reportClass(report.direction);
  $('report-badge').className = `decision-badge ${className}`; $('report-badge').textContent = report.status;
  $('report-title').textContent = report.status; $('report-title').className = `report-title ${className}`;
  $('report-subtitle').textContent = report.subtitle; $('report-time').textContent = new Date(report.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('report-reasons').innerHTML = report.rules.map(rule => `<div class="report-item ${rule.pass ? 'positive' : 'negative'}"><span>${escapeHtml(rule.label)}</span><span>${rule.pass ? '通過' : '未通過'}</span></div>`).join('');
  if (report.plan) {
    const plan = report.plan;
    $('report-plan').innerHTML = [
      ['進場區', `${money(plan.entryLow)} – ${money(plan.entryHigh)} USDT`], ['觸發條件', plan.trigger], ['止損／失效', `${money(plan.stop)}｜${plan.invalidation}`], ['TP1／TP2', `${money(plan.tp1)}（1R）／${money(plan.tp2)}（2R）`], ['最小規劃 R:R', `1 : ${plan.rr.toFixed(1)}`]
    ].map(([label, value]) => `<div class="plan-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('') + `<p class="plan-note">${plan.withinZone ? '現價位於回踩區：仍須等待 15m 收盤確認。' : '現價不在計畫區：不要追價，等待價格回到區間並完成確認。'}</p>`;
  } else {
    $('report-plan').innerHTML = `<p>目前不建立多／空單計畫。等待 1H 收盤上破 <strong>${money(report.h1.swingHigh)}</strong> 或下破 <strong>${money(report.h1.swingLow)}</strong>，再以 15m K 線確認。</p>`;
  }
  const oiText = report.oi ? `${money(report.oi.oiCcy, 2)} BTC${Number.isFinite(report.oi.changePct) ? `｜快照變化 ${signed(report.oi.changePct, '%')}` : '｜首次快照'}` : '未提供';
  const data = [
    ['現價／標記價', `${money(state.last)}／${money(state.mark)}`], ['24H 漲跌', signed(state.ticker.change, '%')], ['資金費率', signed(report.fundingRate * 100, '%')],
    ['4H EMA20／50', `${money(report.h4.ema20)}／${money(report.h4.ema50)}`], ['4H RSI', money(report.h4.rsi)], ['1H EMA20／50', `${money(report.h1.ema20)}／${money(report.h1.ema50)}`],
    ['1H RSI／ATR', `${money(report.h1.rsi)}／${money(report.h1.atr)}`], ['15m RSI／量能比', `${money(report.m15.rsi)}／${money(report.m15.volumeRatio)}×`], ['未平倉量', oiText],
    ['買賣價差', report.spreadBps === null ? '未提供' : `${money(report.spreadBps, 2)} bps`], ['1H 區間', `${money(report.h1.swingLow)} – ${money(report.h1.swingHigh)}`], ['資料狀態', report.stale ? '過期' : '正常']
  ];
  $('report-data').innerHTML = data.map(([label, value]) => `<div class="data-point"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

async function copyTradeReport() {
  if (!state.report) return;
  const content = reportText(state.report);
  try { await navigator.clipboard.writeText(content); alert('報告已複製到剪貼簿。'); }
  catch { const box = document.createElement('textarea'); box.value = content; document.body.appendChild(box); box.select(); document.execCommand('copy'); box.remove(); alert('報告已複製到剪貼簿。'); }
}

function downloadTradeReport() {
  if (!state.report) return;
  const file = new Blob(['\uFEFF', reportText(state.report)], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = `btc-swap-report-${taipeiDate()}.txt`; link.click(); URL.revokeObjectURL(link.href);
}

function setText(id, value, className = '') { const element = $(id); element.textContent = value; element.className = className; }

function drawChart() {
  const canvas = $('price-chart');
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  const width = rect.width, height = rect.height, padding = { left: 6, right: 52, top: 14, bottom: 16 };
  const values = state.candles.map(c => c.close);
  if (!values.length || !width) return;
  const points = [...values, ...state.ema20, ...state.ema50];
  const min = Math.min(...points), max = Math.max(...points), range = Math.max(max - min, 1);
  const x = index => padding.left + index / (values.length - 1) * (width - padding.left - padding.right);
  const y = value => padding.top + (max - value) / range * (height - padding.top - padding.bottom);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(167,190,224,.12)'; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) { const lineY = padding.top + i / 3 * (height - padding.top - padding.bottom); ctx.beginPath(); ctx.moveTo(padding.left, lineY); ctx.lineTo(width - padding.right, lineY); ctx.stroke(); ctx.fillStyle = '#8094b2'; ctx.font = '11px system-ui'; ctx.fillText(number.format(max - i / 3 * range), width - padding.right + 7, lineY + 4); }
  const line = (data, color, lineWidth) => { ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.beginPath(); data.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value))); ctx.stroke(); };
  line(values, '#62a7ff', 2.1); line(state.ema20, '#39ddc1', 1.3); line(state.ema50, '#f8c76d', 1.3);
}

function renderSignal() {
  const closes = state.candles.map(c => c.close);
  const last = closes.at(-1), ema20 = state.ema20.at(-1), ema50 = state.ema50.at(-1), valueRsi = rsi(closes), high20 = Math.max(...closes.slice(-21, -1)), low20 = Math.min(...closes.slice(-21, -1));
  const trendBull = ema20 > ema50, trendBear = ema20 < ema50;
  const priceBull = last > ema20, priceBear = last < ema20;
  const rsiBull = valueRsi >= 50 && valueRsi <= 70, rsiBear = valueRsi >= 30 && valueRsi < 50;
  const breakoutBull = last > high20, breakoutBear = last < low20;
  const longScore = [trendBull, priceBull, rsiBull, breakoutBull].filter(Boolean).length * 25;
  const shortScore = [trendBear, priceBear, rsiBear, breakoutBear].filter(Boolean).length * 25;
  const rules = [
    { label: `EMA20 ${money(ema20)} ${trendBull ? '高於' : '低於'} EMA50 ${money(ema50)}（${trendBull ? '多方' : '空方'}趨勢）`, good: true, side: trendBull ? 'long' : 'short' },
    { label: `收盤價 ${priceBull ? '位於 EMA20 上方' : '位於 EMA20 下方'}（${priceBull ? '多方' : '空方'}結構）`, good: true, side: priceBull ? 'long' : 'short' },
    { label: `RSI ${money(valueRsi)}（${rsiBull ? '多方健康區' : rsiBear ? '空方健康區' : '非理想區間'}）`, good: rsiBull || rsiBear, side: rsiBull ? 'long' : rsiBear ? 'short' : 'neutral' },
    { label: `20 根收盤突破：${breakoutBull ? '向上突破' : breakoutBear ? '向下突破' : '尚未確認突破'}`, good: breakoutBull || breakoutBear, side: breakoutBull ? 'long' : breakoutBear ? 'short' : 'neutral' }
  ];
  let score = Math.max(longScore, shortScore), bias = '中性／等待', description = '多空條件未形成一致結構；優先等待明確的收盤確認與可定義的止損。', color = 'neutral';
  if (longScore >= 50 && longScore > shortScore) { bias = '偏多結構'; description = 'EMA 與收盤結構傾向多方；仍應避免追價，僅在回踩或突破確認後依固定風險規則規劃。'; color = 'positive'; }
  if (shortScore >= 50 && shortScore > longScore) { bias = '偏空結構'; description = 'EMA 與收盤結構傾向空方；仍應等待進場結構完成，並將止損置於失效點。'; color = 'negative'; }
  setText('signal-score', `${score}/100`, color); setText('signal-bias', bias, color); $('signal-description').textContent = description;
  $('trend-pill').textContent = bias;
  $('signal-rules').innerHTML = rules.map(rule => `<div class="rule ${rule.good ? 'good' : 'bad'}"><i></i>${rule.label}</div>`).join('');
}

function renderMarket(ticker, mark, funding, instrument) {
  const last = Number(ticker.last); state.last = last;
  const change = ((last / Number(ticker.open24h)) - 1) * 100;
  state.mark = Number(mark.markPx);
  state.funding = { rate: Number(funding.fundingRate), nextFundingTime: Number(funding.nextFundingTime), fundingTime: Number(funding.fundingTime) };
  state.ticker = { bid: Number(ticker.bidPx), ask: Number(ticker.askPx), ts: Number(ticker.ts), change };
  state.contractValue = Number(instrument.ctVal) || .01;
  setText('last-price', `$${money(last)}`);
  setText('change-24h', signed(change, '%'), change >= 0 ? 'positive' : 'negative');
  setText('mark-price', `$${money(state.mark)}`);
  const rate = state.funding.rate * 100;
  setText('funding-rate', signed(rate, '%'), rate > 0 ? 'negative' : rate < 0 ? 'positive' : 'neutral');
  $('next-funding').textContent = `下一期：${new Date(Number(funding.nextFundingTime)).toLocaleString('zh-TW', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}`;
  $('contract-size').textContent = `合約面值：${state.contractValue} BTC / 張`;
  $('last-updated').textContent = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (!$('risk-entry').value) $('risk-entry').value = last.toFixed(1);
  updatePosition();
}

function renderCandles(data) {
  state.candles = parseCandles(data);
  const closes = state.candles.map(c => c.close); state.ema20 = ema(closes, 20); state.ema50 = ema(closes, 50);
  const valueRsi = rsi(closes), valueAtr = atr(state.candles);
  setText('rsi-value', money(valueRsi)); $('rsi-state').textContent = valueRsi > 70 ? '可能過熱，避免追多' : valueRsi < 30 ? '可能超賣，避免追空' : '尚在中性區間';
  setText('atr-value', `$${money(valueAtr)}`);
  drawChart(); renderSignal();
}

async function loadMarket() {
  setConnection('', '更新市場資料中');
  try {
    const [tickerData, markData, fundingData, candleData, candle15mData, candle4hData, instrumentData, openInterestData] = await Promise.all([
      getJson(`/market/ticker?instId=${INSTRUMENT}`),
      getJson(`/public/mark-price?instType=SWAP&instId=${INSTRUMENT}`),
      getJson(`/public/funding-rate?instId=${INSTRUMENT}`),
      getJson(`/market/candles?instId=${INSTRUMENT}&bar=1H&limit=100`),
      getJson(`/market/candles?instId=${INSTRUMENT}&bar=15m&limit=100`),
      getJson(`/market/candles?instId=${INSTRUMENT}&bar=4H&limit=100`),
      getJson(`/public/instruments?instType=SWAP&instId=${INSTRUMENT}`),
      getJson(`/public/open-interest?instType=SWAP&instId=${INSTRUMENT}`).catch(() => [])
    ]);
    renderMarket(tickerData[0], markData[0], fundingData[0], instrumentData[0]);
    renderCandles(candleData); state.candles15m = parseCandles(candle15mData); state.candles4h = parseCandles(candle4hData);
    state.openInterest = updateOpenInterest(openInterestData[0]); renderTradeReport();
    setConnection('online', 'OKX 公開資料已連線');
  } catch (error) {
    console.error(error); setConnection('offline', '無法取得 OKX 資料');
  }
}

function updatePosition() {
  const side = $('position-side').value, entry = Number($('position-entry').value), size = Number($('position-size').value), stop = Number($('position-stop').value), current = state.last;
  if (!(entry > 0 && size > 0 && stop > 0 && current > 0)) { $('position-results').innerHTML = '<p>輸入計畫中的持倉，便可估算目前盈虧與止損風險。</p>'; return; }
  const sign = side === 'long' ? 1 : -1, pnl = (current - entry) * size * sign, risk = (stop - entry) * size * sign;
  const stopValid = risk < 0;
  $('position-results').innerHTML = [
    ['目前估計盈虧', `<span class="${pnl >= 0 ? 'positive' : 'negative'}">${signed(pnl, ' USDT')}</span>`],
    ['距離止損', `${money(Math.abs(current - stop))} USDT`],
    ['觸及止損的估計損失', `<span class="${stopValid ? 'negative' : 'neutral'}">${signed(risk, ' USDT')}</span>`],
    ['風險檢查', stopValid ? '<span class="positive">止損方向合理</span>' : '<span class="negative">止損方向不合理，請重新確認</span>']
  ].map(([label, value]) => `<div class="result-line"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function calculateRisk(event) {
  event.preventDefault();
  const equity = Number($('account-equity').value), riskPercent = Number($('risk-percent').value), entry = Number($('risk-entry').value), stop = Number($('risk-stop').value), leverage = Number($('risk-leverage').value), feePercent = Number($('fee-buffer').value);
  const distance = Math.abs(entry - stop);
  if (!(equity > 0 && riskPercent > 0 && entry > 0 && stop > 0 && distance > 0 && leverage > 0)) return;
  const rawRisk = equity * riskPercent / 100;
  const feePerBtc = entry * feePercent / 100;
  const quantity = rawRisk / (distance + feePerBtc);
  const contracts = Math.floor(quantity / state.contractValue);
  const roundedQuantity = contracts * state.contractValue;
  const notional = roundedQuantity * entry, margin = notional / leverage, actualRisk = roundedQuantity * (distance + feePerBtc);
  $('risk-results').innerHTML = `<div class="result-grid">
    <div><span>風險上限</span><strong>$${money(rawRisk)}</strong></div>
    <div><span>進場到止損距離</span><strong>$${money(distance)}</strong></div>
    <div><span>建議數量</span><strong>${roundedQuantity.toFixed(4)} BTC</strong></div>
    <div><span>估計張數</span><strong>${contracts.toLocaleString()} 張</strong></div>
    <div><span>名目價值</span><strong>$${money(notional)}</strong></div>
    <div><span>${leverage}× 下估計保證金</span><strong>$${money(margin)}</strong></div>
    <p class="result-note">以每張 ${state.contractValue} BTC、費用／滑價緩衝 ${feePercent}% 估算。實際可下單張數、保證金、維持保證金與強平價由 OKX 帳戶模式及市場狀況決定；送單前務必在 OKX 確認。</p>
  </div>`;
  $('position-entry').value = entry; $('position-stop').value = stop; $('position-size').value = roundedQuantity.toFixed(4); updatePosition();
}

function journal() { try { return JSON.parse(localStorage.getItem(storageKey)) || []; } catch { return []; } }
function saveJournal(entries) { localStorage.setItem(storageKey, JSON.stringify(entries)); }
function renderJournal() {
  const entries = journal(), body = $('journal-rows');
  if (!entries.length) body.innerHTML = '<tr><td colspan="6" class="empty-row">尚無紀錄</td></tr>';
  else body.innerHTML = entries.map(entry => `<tr><td>${entry.date}</td><td class="${entry.side === 'long' ? 'positive' : 'negative'}">${entry.side === 'long' ? '多' : '空'}</td><td>${money(entry.entry)} / ${money(entry.exit)}</td><td>${entry.size.toFixed(4)}</td><td class="${entry.pnl >= 0 ? 'positive' : 'negative'}">${signed(entry.pnl)}</td><td><button class="icon-button" data-delete="${entry.id}" title="刪除">刪除</button></td></tr>`).join('');
  const total = entries.reduce((sum, entry) => sum + entry.pnl, 0), wins = entries.filter(entry => entry.pnl > 0), losses = entries.filter(entry => entry.pnl < 0), grossWin = wins.reduce((sum, entry) => sum + entry.pnl, 0), grossLoss = Math.abs(losses.reduce((sum, entry) => sum + entry.pnl, 0));
  const profitFactor = grossLoss ? grossWin / grossLoss : wins.length ? Infinity : 0;
  $('journal-stats').innerHTML = [['交易筆數', entries.length], ['勝率', entries.length ? `${money(wins.length / entries.length * 100)}%` : '--'], ['估計總盈虧', signed(total, ' USDT')], ['獲利因子', profitFactor === Infinity ? '∞' : money(profitFactor)]].map(([label, value], i) => `<div><span>${label}</span><strong class="${i === 2 ? (total >= 0 ? 'positive' : 'negative') : ''}">${value}</strong></div>`).join('');
}

function addJournalEntry(event) {
  event.preventDefault();
  const side = $('journal-side').value, entry = Number($('journal-entry').value), exit = Number($('journal-exit').value), size = Number($('journal-size').value);
  if (!(entry > 0 && exit > 0 && size > 0)) return;
  const record = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), date: $('journal-date').value, side, entry, exit, size, reason: $('journal-reason').value.trim(), notes: $('journal-notes').value.trim(), pnl: (exit - entry) * size * (side === 'long' ? 1 : -1) };
  const entries = journal(); entries.unshift(record); saveJournal(entries); event.target.reset(); $('journal-date').value = taipeiDate(); renderJournal();
}

function exportJournal() {
  const entries = journal(); if (!entries.length) { alert('目前沒有可匯出的交易紀錄。'); return; }
  const headers = ['date', 'side', 'entry', 'exit', 'size_btc', 'estimated_pnl_usdt', 'reason', 'notes'];
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const content = '\uFEFF' + [headers.join(','), ...entries.map(row => headers.map(header => quote(row[header === 'size_btc' ? 'size' : header === 'estimated_pnl_usdt' ? 'pnl' : header])).join(','))].join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); link.download = `btc-swap-journal-${taipeiDate()}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

function setupChecklist() {
  const saved = JSON.parse(localStorage.getItem(checklistKey) || '{}'); document.querySelectorAll('[data-check]').forEach(box => { box.checked = Boolean(saved[box.dataset.check]); box.addEventListener('change', () => { const current = {}; document.querySelectorAll('[data-check]').forEach(item => current[item.dataset.check] = item.checked); localStorage.setItem(checklistKey, JSON.stringify(current)); renderChecklist(); }); }); renderChecklist();
}
function renderChecklist() { const done = [...document.querySelectorAll('[data-check]')].filter(box => box.checked).length; $('check-status').textContent = `完成 ${done} / 4 項${done === 4 ? ' · 可進行最後風險確認' : ''}`; }
function setupTabs() { document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab)); document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === tab.dataset.tab)); })); }

function init() {
  $('journal-date').value = taipeiDate();
  setupTabs(); setupChecklist(); renderJournal();
  $('refresh-market').addEventListener('click', loadMarket); $('copy-report').addEventListener('click', copyTradeReport); $('download-report').addEventListener('click', downloadTradeReport); $('position-form').addEventListener('submit', event => { event.preventDefault(); updatePosition(); }); ['position-side', 'position-entry', 'position-size', 'position-stop'].forEach(id => $(id).addEventListener('input', updatePosition));
  $('risk-form').addEventListener('submit', calculateRisk); $('journal-form').addEventListener('submit', addJournalEntry); $('export-journal').addEventListener('click', exportJournal); $('journal-rows').addEventListener('click', event => { const id = event.target.dataset.delete; if (id) { saveJournal(journal().filter(item => item.id !== id)); renderJournal(); } });
  window.addEventListener('resize', drawChart); loadMarket(); setInterval(loadMarket, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
