/* BTC-USDT-SWAP 工作台：只使用 OKX 公開市場 API，不傳送交易指令。 */
const API = 'https://www.okx.com/api/v5';
let INSTRUMENT = 'BTC-USDT-SWAP';
const storageKey = 'btcSwapJournalV1';
const checklistKey = 'btcSwapChecklistV1';
const oiSnapshotKey = 'btcSwapOiSeriesV2';

const state = {
  last: null, mark: null, funding: null, openInterest: null, contractValue: null,
  candles: [], candles15m: [], candles4h: [], ema20: [], ema50: [], report: null,
  fundingHistory: [], historyFetchedAt: 0, loading: false, healthy: false,
  instruments: [], meta: null, requestId: 0, drafts: {}, base: 'BTC'
};
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money = (value, digits = (Math.abs(Number(value))>0 && Math.abs(Number(value))<10 ? Math.min(12,Math.max(2,Math.ceil(-Math.log10(Math.abs(Number(value))))+4)) : 2)) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const quantityText = value => Number(value).toLocaleString('en-US',{maximumFractionDigits:12});
const journalStorageKey = () => INSTRUMENT==='BTC-USDT-SWAP'?storageKey:`okxJournal:${INSTRUMENT}:v1`;
const draftFields=['position-side','position-entry','position-size','position-stop','risk-entry','risk-stop','journal-date','journal-side','journal-entry','journal-exit','journal-size','journal-reason','journal-notes'];

function renderInstrumentOptions() {
  const query=$('instrument-search').value.trim().toUpperCase();
  const matching=state.instruments.filter(i=>i.instId.includes(query));
  const selected=state.instruments.find(i=>i.instId===INSTRUMENT);
  if(selected&&!matching.includes(selected))matching.unshift(selected);
  $('instrument-select').replaceChildren(...matching.map(i=>new Option(`${i.instId.split('-')[0]} / USDT 永續`,i.instId,false,i.instId===INSTRUMENT)));
  $('instrument-count').textContent=`${state.instruments.length} 個可用 USDT 永續合約；搜尋符合 ${state.instruments.filter(i=>i.instId.includes(query)).length} 個。`;
}
async function loadInstruments() {
  $('reload-instruments').disabled=true;
  try {
    const list=(await getJson('/public/instruments?instType=SWAP')).filter(OkxContracts.valid);
    if(!list.length)throw new Error('無支援合約');
    const rank=id=>['BTC-USDT-SWAP','ETH-USDT-SWAP','SOL-USDT-SWAP'].indexOf(id);
    state.instruments=list.sort((a,b)=>(rank(a.instId)<0?999:rank(a.instId))-(rank(b.instId)<0?999:rank(b.instId))||a.instId.localeCompare(b.instId));
    renderInstrumentOptions();$('instrument-select').disabled=false;
    if(!list.some(i=>i.instId===INSTRUMENT)) {
      $('instrument-select').prepend(new Option(`${INSTRUMENT}（目前不可用）`,INSTRUMENT,true,true));
      state.meta=null;invalidateReport('目前合約不在可用清單，請選擇其他幣種。');
    }
  } catch { $('instrument-count').textContent='無法更新合約清單，請按「重載清單」重試。'; }
  finally {$('reload-instruments').disabled=false;}
}
function updateInstrumentLabels() {
  state.base=INSTRUMENT.split('-')[0];
  $('instrument-name').textContent=INSTRUMENT;document.title=`${state.base}｜OKX 合約工作台`;
  $('price-chart').setAttribute('aria-label',`${INSTRUMENT} 1 小時價格走勢圖`);
  document.querySelectorAll('[data-base]').forEach(el=>el.textContent=state.base);
  document.querySelectorAll('[data-instrument]').forEach(el=>el.textContent=INSTRUMENT);
}
function switchInstrument(next) {
  if(next===INSTRUMENT || !state.instruments.some(i=>i.instId===next))return;
  state.drafts[INSTRUMENT]=Object.fromEntries(draftFields.map(id=>[id,$(id).value]));
  INSTRUMENT=next;state.requestId++;state.loading=false;state.meta=null;
  Object.assign(state,{last:null,mark:null,funding:null,ticker:null,openInterest:null,contractValue:null,candles:[],candles15m:[],candles4h:[],ema20:[],ema50:[],fundingHistory:[],historyFetchedAt:0});
  invalidateReport(`切換至 ${next}，等待新資料。`);updateInstrumentLabels();
  for(const id of ['last-price','change-24h','mark-price','funding-rate','rsi-value','rsi-state','atr-value','contract-size','last-updated','next-funding','report-time'])setText(id,'—');
  for(const id of draftFields)$(id).value=state.drafts[next]?.[id]??(id.endsWith('-side')?'long':id==='journal-date'?taipeiDate():'');
  $('risk-results').textContent='已切換合約，請重新計算倉位。';$('position-results').textContent='等待此合約的最新行情。';
  document.querySelectorAll('[data-check]').forEach(el=>el.checked=false);renderChecklist();renderJournal();
  const canvas=$('price-chart');canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  loadMarket();
}
const fundingPercent = value => `${money(value * 100, 5)}%`;
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
  const response = await fetch(`${API}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.code && json.code !== '0') throw new Error(json.msg || `OKX error ${json.code}`);
  if (!Array.isArray(json.data)) throw new Error('OKX 資料格式不符');
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
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index].close), Math.abs(candle.low - candles[index].close)));
  let result = ranges.slice(0,period).reduce((sum,value)=>sum+value,0)/period;
  for (const value of ranges.slice(period)) result=(result*(period-1)+value)/period;
  return result;
}

function parseCandles(data) {
  return data.slice().reverse().map(row => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[5]), quoteVolume: Number(row[7]), confirmed: row[8] === '1'
  }));
}

function technicals(candles, interval) {
  const series = BtcEvidence.completed(candles, interval);
  if (!series) return null;
  const closes = series.map(candle => candle.close);
  const ema20Values = ema(closes, 20), ema50Values = ema(closes, 50);
  const latest = series.at(-1), recent = series.slice(-20);
  return {
    latest, lastClose: latest.close, ema20: ema20Values.at(-1), ema50: ema50Values.at(-1),
    ema50Slope: ema50Values.at(-1) - ema50Values.at(-4), rsi: rsi(closes), atr: atr(series),
    volumeRatio: BtcEvidence.relativeVolume(series), adx: BtcEvidence.adx(series), levels: BtcEvidence.pivots(series),
    swingHigh: Math.max(...recent.map(candle => candle.high)), swingLow: Math.min(...recent.map(candle => candle.low)),
    lastCandleTime: latest.time
  };
}

function updateOpenInterest(data) {
  if (!data) return null;
  const current = { oi: Number(data.oi), oiCcy: Number(data.oiCcy), oiUsd: Number(data.oiUsd), ts: Number(data.ts) };
  try {
    if (!(current.oiCcy > 0) || !Number.isFinite(current.ts) || Math.abs(Date.now()-current.ts)>90000) return null;
    const key=`${oiSnapshotKey}:${INSTRUMENT}`;
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    const series = (Array.isArray(saved)?saved:[]).filter(p=>p.ts>current.ts-86400000 && p.ts<=current.ts);
    Object.assign(current, BtcEvidence.oiChange(series,current));
    if (!series.length || current.ts-series.at(-1).ts>=60000) series.push(current);
    localStorage.setItem(key, JSON.stringify(series));
  } catch { /* OI is optional data; a blocked local store must not break analysis. */ }
  return current;
}

function reportClass(direction) { return direction === 'long' ? 'positive' : direction === 'short' ? 'negative' : 'neutral'; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

function calculateDirectionReport() {
  const h4 = technicals(state.candles4h,14400000), h1 = technicals(state.candles,3600000), m15 = technicals(state.candles15m,900000);
  if (!h4 || !h1 || !m15 || !state.last || !state.funding) return null;
  const fundingRate = state.funding.rate;
  const spreadBps = state.ticker?.bid && state.ticker?.ask ? ((state.ticker.ask - state.ticker.bid) / state.last) * 10000 : null;
  const longRules = [
    { weight: 25, label: '4H EMA20 高於 EMA50', pass: h4.ema20 > h4.ema50 },
    { weight: 10, label: '4H EMA50 斜率向上', pass: h4.ema50Slope > 0 },
    { weight: 25, label: '1H 趨勢與收盤在 EMA50 上方', pass: h1.ema20 > h1.ema50 && h1.lastClose > h1.ema50 },
    { weight: 15, label: '1H 動能：收盤在 EMA20 上方且 RSI 50–70', pass: h1.lastClose > h1.ema20 && h1.rsi >= 50 && h1.rsi <= 70 },
    { weight: 15, label: '15m 確認：站上 EMA20、RSI ≥ 48、量能非萎縮', pass: m15.lastClose > m15.ema20 && m15.rsi >= 48 && m15.volumeRatio >= .8 },
    { weight: 10, label: '資金費率未達擁擠多頭門檻（≤ 0.05%）', pass: fundingRate <= .0005 }
  ];
  const shortRules = [
    { weight: 25, label: '4H EMA20 低於 EMA50', pass: h4.ema20 < h4.ema50 },
    { weight: 10, label: '4H EMA50 斜率向下', pass: h4.ema50Slope < 0 },
    { weight: 25, label: '1H 趨勢與收盤在 EMA50 下方', pass: h1.ema20 < h1.ema50 && h1.lastClose < h1.ema50 },
    { weight: 15, label: '1H 動能：收盤在 EMA20 下方且 RSI 30–50', pass: h1.lastClose < h1.ema20 && h1.rsi >= 30 && h1.rsi <= 50 },
    { weight: 15, label: '15m 確認：位於 EMA20 下方、RSI ≤ 52、量能非萎縮', pass: m15.lastClose < m15.ema20 && m15.rsi <= 52 && m15.volumeRatio >= .8 },
    { weight: 10, label: '資金費率未達擁擠空頭門檻（≥ -0.05%）', pass: fundingRate >= -.0005 }
  ];
  const longScore = longRules.filter(rule => rule.pass).reduce((sum, rule) => sum + rule.weight, 0);
  const shortScore = shortRules.filter(rule => rule.pass).reduce((sum, rule) => sum + rule.weight, 0);
  const stale = !state.healthy || !Number.isFinite(fundingRate) || [state.ticker.ts,state.markTs,state.funding.ts].some(ts=>!Number.isFinite(ts) || Date.now()-ts>90000 || ts-Date.now()>5000);
  const liquidityIssue = spreadBps === null || !Number.isFinite(spreadBps) || spreadBps < 0 || spreadBps > 5;
  const longAligned = longRules[0].pass && longRules[2].pass;
  const shortAligned = shortRules[0].pass && shortRules[2].pass;
  let direction = 'wait', score = Math.max(longScore, shortScore), status = '不交易／等待', subtitle = '多週期方向未一致或資料條件尚不足，因此不給出單邊交易方案。';
  if (!stale && !liquidityIssue && longAligned && longScore >= 70 && longScore - shortScore >= 15) {
    direction = 'long'; status = '偏多：等待回踩確認'; subtitle = '高週期與 1H 結構偏多；此為等待回踩的條件式方案，不是立即追價指令。';
  } else if (!stale && !liquidityIssue && shortAligned && shortScore >= 70 && shortScore - longScore >= 15) {
    direction = 'short'; status = '偏空：等待反彈確認'; subtitle = '高週期與 1H 結構偏空；此為等待反彈的條件式方案，不是立即追空指令。';
  } else if (stale) subtitle = '市場資料時間過期，暫停產生方向結論。';
  else if (liquidityIssue) subtitle = `買賣價差約 ${money(spreadBps, 2)} bps，高於 5 bps 門檻，暫不交易。`;
  const bias = direction;
  const fundingPosition = Date.now()-state.historyFetchedAt<600000 ? BtcEvidence.fundingPosition(state.fundingHistory,state.funding) : null;
  const levels = [...new Set([...h1.levels,...h4.levels])].sort((a,b)=>a-b);
  const costPercent = $('analysis-cost').value==='' ? NaN : Number($('analysis-cost').value);
  const candidate = bias==='wait' || !Number.isFinite(costPercent) || costPercent<0 || costPercent>5 ? null : BtcEvidence.structurePlan(bias,h1,levels,costPercent,state.last);
  const gates = [
    {label:'行情與已收盤 K 線有效；價差 ≤ 5 bps',pass:!stale&&!liquidityIssue},
    {label:`1H ADX(14) ${money(h1.adx)} ≥ 20（只衡量趨勢強弱）`,pass:h1.adx>=20},
    {label:`15m 相對成交量 ${money(m15.volumeRatio)}× ≥ 1.20×（對前 20 根已收盤 K）`,pass:m15.volumeRatio!==null&&m15.volumeRatio>=1.2},
    {label:fundingPosition?`同 ${fundingPosition.hours} 小時結算之費率歷史：第 ${money(fundingPosition.percentile,1)} 百分位／${fundingPosition.count} 筆`:'資金費率歷史不足或取得失敗',pass:!!fundingPosition&&(bias==='long'?fundingPosition.percentile<90:bias==='short'?fundingPosition.percentile>10:false)},
    {label:`到最近結構價位、扣費後 R:R ${candidate?.rr===null || !candidate?'無可用目標':money(candidate.rr)}；需 ≥ 2`,pass:!!candidate?.eligible}
  ];
  const blocked = gates.filter(g=>!g.pass);
  let plan = null;
  if (bias!=='wait' && !blocked.length) {
    plan={...candidate,trigger:'尚未自動確認進場觸發。人工確認 15m 回測進場區、收盤回到趨勢側後，再重新檢查價格與風控。',invalidation:'觸及止損、趨勢改變或任一篩選條件失效，即取消方案。'};
  } else {
    direction='wait'; status='不交易／等待';
    subtitle=`${bias==='long'?'趨勢偏多':bias==='short'?'趨勢偏空':'多週期尚未形成可用方向'}。${blocked.length?'未通過：'+blocked.map(g=>g.label).join('；'):'等待方向一致'}。`;
  }
  const activeRules = bias === 'long' ? longRules : bias === 'short' ? shortRules : (longScore >= shortScore ? longRules : shortRules);
  return { instrument:INSTRUMENT,base:state.base, direction,bias,status,subtitle,score,longScore,shortScore,rules:activeRules,gates,h4,h1,m15,plan,candidate,fundingPosition,fundingRate,spreadBps,stale,liquidityIssue,oi:state.openInterest,createdAt:Date.now(),last:state.last,mark:state.mark,ticker:{...state.ticker},costPercent,support:levels.filter(x=>x<state.last).at(-1),resistance:levels.find(x=>x>state.last) };
}


function reportText(report) {
  const directionText = report.direction === 'long' ? '偏多（等待回踩確認）' : report.direction === 'short' ? '偏空（等待反彈確認）' : '不交易／等待';
  const lines = [
    `${report.instrument}｜multi-v4（未回測驗證）｜評估時間 ${new Date(report.createdAt).toLocaleString('zh-TW')}`,
    '', `決策：${directionText}`, `規則符合度：${report.score}/100（不是勝率）`, `多方分數：${report.longScore}/100｜空方分數：${report.shortScore}/100`, `說明：${report.subtitle}`, '', '使用數據：',
    `現價：${money(report.last)}｜標記價：${money(report.mark)}｜24H：${signed(report.ticker.change, '%')}｜行情時間：${new Date(report.ticker.ts).toISOString()}`,
    `4H EMA20/EMA50：${money(report.h4.ema20)} / ${money(report.h4.ema50)}｜RSI：${money(report.h4.rsi)}`,
    `1H EMA20/EMA50：${money(report.h1.ema20)} / ${money(report.h1.ema50)}｜RSI：${money(report.h1.rsi)}｜ATR：${money(report.h1.atr)}`,
    `15m RSI：${money(report.m15.rsi)}｜量能比：${money(report.m15.volumeRatio)}×｜資金費率：${fundingPercent(report.fundingRate)}`,
    `1H ADX：${money(report.h1.adx)}｜支撐／壓力：${money(report.support)}／${money(report.resistance)}｜價差：${money(report.spreadBps)} bps`,
    `來回手續費＋滑價假設：${report.costPercent}%（不含持倉資金費；請依帳戶調整）`,
    `K 線開盤時間（均已收盤）4H / 1H / 15m：${[report.h4,report.h1,report.m15].map(t=>new Date(t.lastCandleTime).toISOString()).join(' / ')}`,
    `OI 約一小時變化：${Number.isFinite(report.oi?.changePct)?signed(report.oi.changePct,'%')+'／間隔 '+money(report.oi.minutes,1)+' 分鐘':'尚無對照資料；需累積約一小時，非多空比'}`,
    `費率歷史樣本期間：${report.fundingPosition?new Date(report.fundingPosition.from).toISOString()+' 至 '+new Date(report.fundingPosition.to).toISOString():'無有效同週期樣本'}`,
    `未平倉量：${report.oi ? `${quantityText(report.oi.oiCcy)} ${report.base}（僅快照，不單獨判定方向）` : '資料未提供'}`,
    '', '判定條件：', ...report.rules.map(rule => `- [${rule.pass ? '通過' : '未通過'}] ${rule.label}`)
  ];
  lines.push('', '交易品質篩選：',...report.gates.map(g=>`- [${g.pass?'通過':'未通過'}] ${g.label}`));
  if (report.plan) lines.push('', '條件式方案（確認前不進場）：', `進場區：${money(report.plan.entryLow)}–${money(report.plan.entryHigh)}`, `觸發：${report.plan.trigger}`, `止損：${money(report.plan.stop)}｜結構目標：${money(report.plan.target)}｜扣費後 R:R：${money(report.plan.rr)}`, `失效：${report.plan.invalidation}`, '提醒：請用風控頁依你的帳戶與單筆風險上限重新計算張數。');
  else lines.push('', '等待所有篩選條件通過；不能只因價格突破就進場。');
  lines.push('', '此為規則型市場分析與風險管理輔助，不構成投資建議或獲利保證。');
  return lines.join('\n');
}

function renderTradeReport() {
  const report = calculateDirectionReport();
  if (!report) { invalidateReport('已收盤 K 線不足、缺漏或過期；暫停方案。'); return; }
  state.report = report;
  const className = reportClass(report.direction);
  $('report-badge').className = `decision-badge ${className}`; $('report-badge').textContent = report.status;
  $('report-title').textContent = report.status; $('report-title').className = `report-title ${className}`;
  $('report-subtitle').textContent = report.subtitle; $('report-time').textContent = new Date(report.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('report-reasons').innerHTML = report.rules.map(rule => `<div class="report-item ${rule.pass ? 'positive' : 'negative'}"><span>${escapeHtml(rule.label)}</span><span>${rule.pass ? '通過' : '未通過'}</span></div>`).join('');
  $('evidence-gates').innerHTML = report.gates.map(g=>`<div class="report-item ${g.pass?'positive':'negative'}"><span>${escapeHtml(g.label)}</span><span>${g.pass?'通過':'等待'}</span></div>`).join('');
  setText('signal-score',`${report.score}/100`,className); setText('signal-bias',report.status,className);
  $('signal-description').textContent='規則符合度，不是勝率。以完整報告及交易品質篩選為準。';
  $('trend-pill').textContent=report.status;
  $('signal-rules').textContent=`1H ADX ${money(report.h1.adx)}｜15m 量能 ${money(report.m15.volumeRatio)}×｜${report.gates.filter(g=>g.pass).length}/5 項品質篩選通過`;
  if (report.plan) {
    const plan = report.plan;
    $('report-plan').innerHTML = [
      ['進場區', `${money(plan.entryLow)} – ${money(plan.entryHigh)} USDT`], ['觸發條件', plan.trigger], ['止損／失效', `${money(plan.stop)}｜${plan.invalidation}`], ['最近結構目標', money(plan.target)], ['扣費後 R:R（最不利進場價）', `1 : ${plan.rr.toFixed(2)}`]
    ].map(([label, value]) => `<div class="plan-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('') + `<p class="plan-note">${plan.withinZone ? '現價位於回踩區：仍須等待 15m 收盤確認。' : '現價不在計畫區：不要追價，等待價格回到區間並完成確認。'}</p>`;
  } else {
    $('report-plan').textContent = '目前不建立多／空單計畫。先等待上方品質篩選與多週期方向一致，再人工確認 15m 進場觸發。';
  }
  const oiText = report.oi ? `${quantityText(report.oi.oiCcy)} ${report.base}${Number.isFinite(report.oi.changePct) ? `｜${money(report.oi.minutes,1)} 分鐘變化 ${signed(report.oi.changePct, '%')}` : '｜需累積約 1 小時對照'}` : '未提供';
  const data = [
    ['現價／標記價', `${money(report.last)}／${money(report.mark)}`], ['24H 漲跌', signed(report.ticker.change, '%')], ['資金費率（預估）', fundingPercent(report.fundingRate)],
    ['4H EMA20／50', `${money(report.h4.ema20)}／${money(report.h4.ema50)}`], ['4H RSI', money(report.h4.rsi)], ['1H EMA20／50', `${money(report.h1.ema20)}／${money(report.h1.ema50)}`],
    ['1H RSI／ATR', `${money(report.h1.rsi)}／${money(report.h1.atr)}`], ['15m RSI／量能比', `${money(report.m15.rsi)}／${money(report.m15.volumeRatio)}×`], ['未平倉量', oiText],
    ['買賣價差', report.spreadBps === null ? '未提供' : `${money(report.spreadBps, 2)} bps`], ['1H 區間', `${money(report.h1.swingLow)} – ${money(report.h1.swingHigh)}`], ['資料狀態', report.stale ? '過期／無效' : '有效（僅使用已收盤 K）'],
    ['1H ADX(14)',money(report.h1.adx)],['最近支撐／壓力',`${money(report.support)}／${money(report.resistance)}`],
    ['費率歷史位置',report.fundingPosition?`第 ${money(report.fundingPosition.percentile,1)} 百分位／${report.fundingPosition.count} 筆・${report.fundingPosition.hours}h 結算`:'資料不足'],
    ['結構目標扣費後 R:R',report.candidate?money(report.candidate.rr):'尚無方向'],['來回費用＋滑價假設',`${report.costPercent}%（不含資金費）`],
    ['分析版本','multi-v4・尚未回測驗證']
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
  const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = `${state.report.instrument}-report-${taipeiDate()}.txt`; link.click(); URL.revokeObjectURL(link.href);
}

function setText(id, value, className = '') { const element = $(id); element.textContent = value; element.classList.remove('positive','negative','neutral'); if(className) element.classList.add(className); }

function invalidateReport(reason) {
  state.report=null; state.healthy=false;
  for (const id of ['report-title','report-badge','signal-bias','trend-pill']) setText(id,'資料無效／停止給單','neutral');
  $('report-subtitle').textContent=reason; $('report-plan').textContent='無有效交易方案。';
  for(const id of ['report-data','report-reasons','evidence-gates','signal-rules']) $(id).textContent='等待重新取得有效資料。';
  $('signal-description').textContent=reason; setText('signal-score','—','neutral');
}

function drawChart() {
  const canvas = $('price-chart');
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  const width = rect.width, height = rect.height, padding = { left: 6, right: 92, top: 14, bottom: 16 };
  const values = state.candles.map(c => c.close);
  if (!values.length || !width) return;
  const points = [...values, ...state.ema20, ...state.ema50];
  const min = Math.min(...points), max = Math.max(...points), range = Math.max(max - min, Math.abs(max)*.000001, 1e-12);
  const x = index => padding.left + index / (values.length - 1) * (width - padding.left - padding.right);
  const y = value => padding.top + (max - value) / range * (height - padding.top - padding.bottom);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(167,190,224,.12)'; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) { const lineY = padding.top + i / 3 * (height - padding.top - padding.bottom); ctx.beginPath(); ctx.moveTo(padding.left, lineY); ctx.lineTo(width - padding.right, lineY); ctx.stroke(); ctx.fillStyle = '#8094b2'; ctx.font = '11px system-ui'; ctx.fillText(money(max - i / 3 * range), width - padding.right + 7, lineY + 4); }
  const line = (data, color, lineWidth) => { ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.beginPath(); data.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value))); ctx.stroke(); };
  line(values, '#62a7ff', 2.1); line(state.ema20, '#39ddc1', 1.3); line(state.ema50, '#f8c76d', 1.3);
}


function renderMarket(ticker, mark, funding, instrument) {
  const last = Number(ticker.last); state.last = last;
  const change = ((last / Number(ticker.open24h)) - 1) * 100;
  state.mark = Number(mark.markPx); state.markTs=Number(mark.ts);
  state.funding = { rate: funding.fundingRate===''?NaN:Number(funding.fundingRate), ts:Number(funding.ts), nextFundingTime: Number(funding.nextFundingTime), fundingTime: Number(funding.fundingTime) };
  state.ticker = { bid: Number(ticker.bidPx), ask: Number(ticker.askPx), ts: Number(ticker.ts), change };
  state.meta=instrument;state.contractValue = Number(instrument.ctVal);
  for(const id of ['risk-entry','risk-stop','position-entry','position-stop','journal-entry','journal-exit'])$(id).step=instrument.tickSz;
  for(const id of ['position-size','journal-size'])$(id).step='any';
  if(Number(instrument.lever)>0){$('risk-leverage').max=instrument.lever;$('risk-leverage').value=Math.min(Number($('risk-leverage').value),Number(instrument.lever));}
  setText('last-price', `$${money(last)}`);
  setText('change-24h', signed(change, '%'), change >= 0 ? 'positive' : 'negative');
  setText('mark-price', `$${money(state.mark)}`);
  const rate = state.funding.rate * 100;
  setText('funding-rate', fundingPercent(state.funding.rate), rate > 0 ? 'negative' : rate < 0 ? 'positive' : 'neutral');
  $('next-funding').textContent = `下一次結算：${new Date(Number(funding.fundingTime)).toLocaleString('zh-TW', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}`;
  $('contract-size').textContent = `每張 ${state.contractValue} ${state.base}｜最小 ${instrument.minSz} 張｜步長 ${instrument.lotSz}`;
  $('last-updated').textContent = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (!$('risk-entry').value) $('risk-entry').value = ticker.last;
  updatePosition();
}

function renderCandles(data) {
  state.candles = parseCandles(data).filter(c=>c.confirmed);
  const closes = state.candles.map(c => c.close); state.ema20 = ema(closes, 20); state.ema50 = ema(closes, 50);
  const valueRsi = rsi(closes), valueAtr = atr(state.candles);
  setText('rsi-value', money(valueRsi)); $('rsi-state').textContent = valueRsi > 70 ? '可能過熱，避免追多' : valueRsi < 30 ? '可能超賣，避免追空' : '尚在中性區間';
  setText('atr-value', `$${money(valueAtr)}`);
  drawChart();
}

async function loadMarket() {
  if(state.loading) return;
  const requestId=++state.requestId, instrument=INSTRUMENT;
  state.loading=true;
  setConnection('', '更新市場資料中');
  try {
    const [tickerData, markData, fundingData, candleData, candle15mData, candle4hData, instrumentData, openInterestData, history] = await Promise.all([
      getJson(`/market/ticker?instId=${instrument}`),
      getJson(`/public/mark-price?instType=SWAP&instId=${instrument}`),
      getJson(`/public/funding-rate?instId=${instrument}`),
      getJson(`/market/candles?instId=${instrument}&bar=1H&limit=200`),
      getJson(`/market/candles?instId=${instrument}&bar=15m&limit=200`),
      getJson(`/market/candles?instId=${instrument}&bar=4H&limit=200`),
      getJson(`/public/instruments?instType=SWAP&instId=${instrument}`),
      getJson(`/public/open-interest?instType=SWAP&instId=${instrument}`).catch(() => []),
      Date.now()-state.historyFetchedAt<300000 ? Promise.resolve(null) : getJson(`/public/funding-rate-history?instId=${instrument}&limit=100`).catch(()=>[])
    ]);
    if(requestId!==state.requestId || instrument!==INSTRUMENT)return;
    if(!OkxContracts.valid(instrumentData[0]) || instrumentData[0].instId!==instrument || [tickerData[0],markData[0],fundingData[0]].some(row=>row?.instId!==instrument))throw new Error('合約資料不符或已停止交易');
    if (![tickerData[0]?.last,markData[0]?.markPx,tickerData[0]?.bidPx,tickerData[0]?.askPx].every(v=>Number.isFinite(Number(v))&&Number(v)>0)) throw new Error('必要價格資料缺失');
    if(openInterestData[0]?.instId!==instrument)openInterestData.length=0;
    if(history?.some(row=>row.instId!==instrument))history.length=0;
    if (history!==null) { state.fundingHistory=history; state.historyFetchedAt=history.length?Date.now():0; }
    renderMarket(tickerData[0], markData[0], fundingData[0], instrumentData[0]);
    renderCandles(candleData); state.candles15m = parseCandles(candle15mData); state.candles4h = parseCandles(candle4hData);
    state.openInterest = updateOpenInterest(openInterestData[0]); state.healthy=true; renderTradeReport();
    setConnection(state.report&&!state.report.stale?'online':'offline',state.report&&!state.report.stale?'OKX 公開資料已連線':'資料過期／不完整，停止給單');
  } catch (error) {
    if(requestId!==state.requestId)return;
    state.meta=null;
    console.error(error); setConnection('offline', '無法取得 OKX 資料'); invalidateReport('更新失敗，已撤下舊方案；請恢復連線後重試。');
  } finally {if(requestId===state.requestId)state.loading=false;}
}

function updatePosition() {
  const side = $('position-side').value, entry = Number($('position-entry').value), size = Number($('position-size').value), stop = Number($('position-stop').value), current = state.last;
  if (!(entry > 0 && size > 0 && stop > 0 && current > 0) || !state.ticker || Date.now()-state.ticker.ts>90000) { $('position-results').innerHTML = '<p>請輸入此幣種的持倉資料，並等待有效行情。</p>'; return; }
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
  if (!(equity > 0 && riskPercent > 0 && entry > 0 && stop > 0 && distance > 0 && leverage > 0 && feePercent>=0) || !OkxContracts.valid(state.meta) || state.meta.instId!==INSTRUMENT) { $('risk-results').textContent='請等待有效合約規格，並確認輸入數值。';return; }
  const rawRisk = equity * riskPercent / 100;
  const sizing=OkxContracts.size(rawRisk,entry,stop,feePercent,state.meta);
  if(!sizing){$('risk-results').textContent=`此風險預算不足以符合 ${INSTRUMENT} 最小 ${state.meta.minSz} 張；不建議加大風險以湊單。`;return;}
  const contracts=sizing.contracts,roundedQuantity=sizing.quantity;
  const notional = roundedQuantity * entry, margin = notional / leverage;
  $('risk-results').innerHTML = `<div class="result-grid">
    <div><span>風險上限</span><strong>$${money(rawRisk)}</strong></div>
    <div><span>進場到止損距離</span><strong>$${money(distance)}</strong></div>
    <div><span>${INSTRUMENT} 數量</span><strong>${quantityText(roundedQuantity)} ${state.base}</strong></div>
    <div><span>向下取整張數</span><strong>${quantityText(contracts)} 張</strong></div>
    <div><span>名目價值</span><strong>$${money(notional)}</strong></div>
    <div><span>${leverage}× 下估計保證金</span><strong>$${money(margin)}</strong></div>
    <p class="result-note">每張 ${state.contractValue} ${state.base}；最小 ${state.meta.minSz} 張、步長 ${state.meta.lotSz} 張；費用／滑價緩衝 ${feePercent}%。${margin>equity?'估計保證金高於帳戶權益，請縮小倉位。':''} 實際保證金、強平價及帳戶可用合約須在 OKX 確認。</p>
  </div>`;
  $('position-entry').value = entry; $('position-stop').value = stop; $('position-size').value = Number(roundedQuantity.toPrecision(12)); updatePosition();
}

function journal() { try { const rows=JSON.parse(localStorage.getItem(journalStorageKey()));return Array.isArray(rows)?rows:[]; } catch { return []; } }
function saveJournal(entries) { localStorage.setItem(journalStorageKey(), JSON.stringify(entries)); }
function renderJournal() {
  const entries = journal(), body = $('journal-rows');
  if (!entries.length) body.innerHTML = '<tr><td colspan="6" class="empty-row">尚無紀錄</td></tr>';
  else body.innerHTML = entries.map(entry => `<tr><td>${entry.date}</td><td class="${entry.side === 'long' ? 'positive' : 'negative'}">${entry.side === 'long' ? '多' : '空'}</td><td>${money(entry.entry)} / ${money(entry.exit)}</td><td>${quantityText(entry.size)}</td><td class="${entry.pnl >= 0 ? 'positive' : 'negative'}">${signed(entry.pnl)}</td><td><button class="icon-button" data-delete="${entry.id}" title="刪除">刪除</button></td></tr>`).join('');
  const total = entries.reduce((sum, entry) => sum + entry.pnl, 0), wins = entries.filter(entry => entry.pnl > 0), losses = entries.filter(entry => entry.pnl < 0), grossWin = wins.reduce((sum, entry) => sum + entry.pnl, 0), grossLoss = Math.abs(losses.reduce((sum, entry) => sum + entry.pnl, 0));
  const profitFactor = grossLoss ? grossWin / grossLoss : wins.length ? Infinity : 0;
  $('journal-stats').innerHTML = [['交易筆數', entries.length], ['勝率', entries.length ? `${money(wins.length / entries.length * 100)}%` : '--'], ['估計總盈虧', signed(total, ' USDT')], ['獲利因子', profitFactor === Infinity ? '∞' : money(profitFactor)]].map(([label, value], i) => `<div><span>${label}</span><strong class="${i === 2 ? (total >= 0 ? 'positive' : 'negative') : ''}">${value}</strong></div>`).join('');
}

function addJournalEntry(event) {
  event.preventDefault();
  const side = $('journal-side').value, entry = Number($('journal-entry').value), exit = Number($('journal-exit').value), size = Number($('journal-size').value);
  if (!(entry > 0 && exit > 0 && size > 0)) return;
  const record = { instrument:INSTRUMENT, base:state.base, id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), date: $('journal-date').value, side, entry, exit, size, reason: $('journal-reason').value.trim(), notes: $('journal-notes').value.trim(), pnl: (exit - entry) * size * (side === 'long' ? 1 : -1) };
  const entries = journal(); entries.unshift(record); saveJournal(entries); event.target.reset(); $('journal-date').value = taipeiDate(); renderJournal();
}

function exportJournal() {
  const entries = journal(); if (!entries.length) { alert('目前沒有可匯出的交易紀錄。'); return; }
  const headers = ['instrument','quantity_currency','date', 'side', 'entry', 'exit', 'quantity', 'estimated_pnl_usdt', 'reason', 'notes'];
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const content = '\uFEFF' + [headers.join(','), ...entries.map(row => headers.map(header => quote(header==='instrument'?INSTRUMENT:header==='quantity_currency'?state.base:row[header === 'quantity' ? 'size' : header === 'estimated_pnl_usdt' ? 'pnl' : header])).join(','))].join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); link.download = `${INSTRUMENT}-journal-${taipeiDate()}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

function setupChecklist() {
  document.querySelectorAll('[data-check]').forEach(box => { box.checked=false; box.addEventListener('change',renderChecklist); }); renderChecklist();
}
function renderChecklist() { const done = [...document.querySelectorAll('[data-check]')].filter(box => box.checked).length; $('check-status').textContent = `完成 ${done} / 4 項${done === 4 ? ' · 可進行最後風險確認' : ''}`; }
function setupTabs() { document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab)); document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === tab.dataset.tab)); })); }

function init() {
  $('journal-date').value = taipeiDate();
  setupTabs(); setupChecklist(); renderJournal();
  $('refresh-market').addEventListener('click', loadMarket); $('copy-report').addEventListener('click', copyTradeReport); $('download-report').addEventListener('click', downloadTradeReport); $('position-form').addEventListener('submit', event => { event.preventDefault(); updatePosition(); }); ['position-side', 'position-entry', 'position-size', 'position-stop'].forEach(id => $(id).addEventListener('input', updatePosition));
  $('risk-form').addEventListener('submit', calculateRisk); $('journal-form').addEventListener('submit', addJournalEntry); $('export-journal').addEventListener('click', exportJournal); $('journal-rows').addEventListener('click', event => { const id = event.target.dataset.delete; if (id) { saveJournal(journal().filter(item => item.id !== id)); renderJournal(); } });
  updateInstrumentLabels();
  $('instrument-select').addEventListener('change',event=>switchInstrument(event.target.value));
  $('instrument-search').addEventListener('input',renderInstrumentOptions);
  $('reload-instruments').addEventListener('click',loadInstruments);
  window.addEventListener('resize', drawChart); loadInstruments();loadMarket(); setInterval(loadMarket, 30000);
  $('analysis-cost').addEventListener('input',()=>{if(state.healthy)renderTradeReport();});
  setInterval(()=>{if(state.report && (Date.now()-state.report.createdAt>90000 || Date.now()-state.ticker.ts>90000)) {invalidateReport('報告超過 90 秒有效期限，等待更新。');setConnection('offline','報告已過期');}},1000);
  window.addEventListener('offline',()=>{invalidateReport('裝置離線，已撤下方案。');setConnection('offline','裝置離線');});
  if ('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
