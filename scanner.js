/* One-shot, user-started market screening. Uses the same decision engine as the detail view. */
const scanner={running:false,controller:null,results:[],total:0,done:0,phase:'尚未掃描',cost:null};
function scanEligible(row,now=Date.now()) {
  return !row.error && row.report?.plan && ['long','short'].includes(row.report.direction) &&
    !row.report.stale && Number.isFinite(row.expiresAt) && now<row.expiresAt;
}
function scanStatus(row,now=Date.now()) {
  if(row.error)return '資料不足／失敗';
  if(now>=row.expiresAt)return '已過期，請重新掃描';
  return scanEligible(row,now)?(row.report.direction==='long'?'偏多・可規劃':'偏空・可規劃'):'等待／未通過';
}
function renderScanner() {
  const now=Date.now(),candidates=scanner.results.filter(row=>scanEligible(row,now));
  const errors=scanner.results.filter(row=>row.error).length,expired=scanner.results.filter(row=>!row.error&&now>=row.expiresAt).length;
  $('scan-progress').textContent=`${scanner.phase}｜已掃 ${scanner.done} / ${scanner.total}｜有效候選 ${candidates.length}｜資料不足／失敗 ${errors}｜過期 ${expired}`;
  $('start-scan').disabled=scanner.running;$('stop-scan').disabled=!scanner.running;$('scan-scope').disabled=scanner.running;
  const direction=$('scan-direction').value,only=$('scan-only').checked;
  const rows=scanner.results.filter(row=>(!only||scanEligible(row,now))&&(direction==='all'||row.report?.direction===direction));
  rows.sort((a,b)=>Number(!!scanEligible(b,now))-Number(!!scanEligible(a,now))||(b.report?.score||0)-(a.report?.score||0)||a.instrument.localeCompare(b.instrument));
  const container=$('scan-results'),active=document.activeElement,focusSymbol=container.contains(active)?active?.dataset.scanSymbol:null;
  container.replaceChildren(...rows.map(row=>{
    const report=row.report,card=document.createElement('article');card.className='scan-card';
    const eligible=!!scanEligible(row,now),status=scanStatus(row,now);
    const heading=document.createElement('h3');heading.textContent=`${row.instrument}｜${status}`;
    heading.className=eligible?reportClass(report.direction):'neutral';card.append(heading);
    const summary=document.createElement('p');
    summary.textContent=report?`ADX ${money(report.h1.adx,2)}｜15m 量能 ${money(report.m15.volumeRatio,2)}×｜價差 ${money(report.spreadBps,2)} bps｜扣費 R:R ${money(report.candidate?.rr,2)}｜規則 ${report.score}/100（不是勝率）`:'無法完成本合約評估，不能視為可交易。';card.append(summary);
    const note=document.createElement('p');note.className='scan-note';
    note.textContent=row.error || (eligible?`${report.plan.withinZone?'價格在規劃區內':'尚未回到規劃區'}；仍須人工確認 15m 觸發、新聞與帳戶風控。`:(now>=row.expiresAt?'此結果超過資料有效期限，已撤出候選名單。':report.subtitle));card.append(note);
    const time=document.createElement('p');time.className='scan-note';time.textContent=`評估：${new Date(row.checkedAt).toLocaleTimeString('zh-TW')}｜費用＋滑價假設 ${scanner.cost}%（不含資金費）`;card.append(time);
    const button=document.createElement('button');button.type='button';button.className='button secondary';button.dataset.scanSymbol=row.instrument;button.textContent='查看並重新分析';card.append(button);
    return card;
  }));
  if(!rows.length){const p=document.createElement('p');p.className='scan-empty';p.textContent=scanner.running?'掃描中，目前沒有符合此篩選的有效候選。':scanner.done?'本次結果沒有符合此篩選的有效候選。可取消「只看可規劃」查看原因；未掃描、失敗及過期不等於不具交易機會。':'按「開始掃描」取得結果；不會在背景自動掃描或下單。';container.append(p);}
  if(focusSymbol)container.querySelector(`[data-scan-symbol="${focusSymbol}"]`)?.focus({preventScroll:true});
}
function stopScanner(reason='已停止（保留仍有效的部分結果）') {
  scanner.controller?.abort();scanner.phase=reason;renderScanner();
}
function scanPause(ms,signal) {
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
  });
}
async function scanContract(meta,cost,signal) {
  const instrument=meta.instId;
  const [tickers,marks,fundings,c1,c15,c4,history]=await Promise.all([
    getJson(`/market/ticker?instId=${instrument}`,signal),
    getJson(`/public/mark-price?instType=SWAP&instId=${instrument}`,signal),
    getJson(`/public/funding-rate?instId=${instrument}`,signal),
    getJson(`/market/candles?instId=${instrument}&bar=1H&limit=200`,signal),
    getJson(`/market/candles?instId=${instrument}&bar=15m&limit=200`,signal),
    getJson(`/market/candles?instId=${instrument}&bar=4H&limit=200`,signal),
    getJson(`/public/funding-rate-history?instId=${instrument}&limit=100`,signal)
  ]);
  const ticker=tickers[0],mark=marks[0],funding=fundings[0];
  if(!OkxContracts.valid(meta)||[ticker,mark,funding].some(row=>row?.instId!==instrument)||history.some(row=>row.instId!==instrument))throw new Error('資料幣種或合約規格不符');
  if(![ticker.last,ticker.bidPx,ticker.askPx,mark.markPx].every(v=>Number.isFinite(Number(v))&&Number(v)>0))throw new Error('價格資料缺失');
  const market={base:meta.ctValCcy,last:Number(ticker.last),mark:Number(mark.markPx),markTs:Number(mark.ts),
    ticker:{bid:Number(ticker.bidPx),ask:Number(ticker.askPx),ts:Number(ticker.ts),change:(Number(ticker.last)/Number(ticker.open24h)-1)*100},
    funding:{rate:funding.fundingRate===''?NaN:Number(funding.fundingRate),ts:Number(funding.ts),fundingTime:Number(funding.fundingTime),nextFundingTime:Number(funding.nextFundingTime)},
    candles:parseCandles(c1),candles15m:parseCandles(c15),candles4h:parseCandles(c4),fundingHistory:history,historyFetchedAt:Date.now(),healthy:true,openInterest:null};
  const report=calculateDirectionReport(market,instrument,cost);
  if(!report)throw new Error('已收盤 K 線不足、缺漏或過期（各週期至少 100 根）');
  if(report.stale)throw new Error('必要行情資料過期或無效');
  if(!report.fundingPosition)throw new Error('資金費率歷史不足或不同結算週期，無法完成篩選');
  return {instrument,report,checkedAt:Date.now(),expiresAt:Math.min(report.createdAt,market.ticker.ts,market.markTs,market.funding.ts)+90000};
}
async function startScanner() {
  if(scanner.running)return;
  const cost=$('analysis-cost').value===''?NaN:Number($('analysis-cost').value);
  if(!Number.isFinite(cost)||cost<0||cost>5){scanner.phase='請先填寫有效的分析費用／滑價（0–5%）';renderScanner();return;}
  const controller=new AbortController(),signal=controller.signal;
  Object.assign(scanner,{controller,running:true,results:[],done:0,total:0,cost,phase:'讀取合約清單與成交量排序'});renderScanner();
  try {
    const [instruments,tickers]=await Promise.all([getJson('/public/instruments?instType=SWAP',signal),getJson('/market/tickers?instType=SWAP',signal)]);
    if(signal.aborted)return;
    const activity=new Map(tickers.map(t=>[t.instId,Number(t.volCcy24h)*Number(t.last)]));
    const list=instruments.filter(OkxContracts.valid).sort((a,b)=>(Number.isFinite(activity.get(b.instId))?activity.get(b.instId):0)-(Number.isFinite(activity.get(a.instId))?activity.get(a.instId):0)||a.instId.localeCompare(b.instId));
    if(!list.length)throw new Error('未取得可用的 USDT 永續合約清單');
    const scope=$('scan-scope').value,chosen=scope==='all'?list:list.slice(0,Number(scope));
    scanner.total=chosen.length;renderScanner();
    for(const meta of chosen) {
      if(signal.aborted)break;
      scanner.phase=`掃描 ${meta.instId}`;renderScanner();
      try {
        const result=await scanContract(meta,cost,signal);
        if(signal.aborted)break;
        scanner.results.push(result);
      } catch(error) {
        if(signal.aborted)break;
        scanner.results.push({instrument:meta.instId,error:error.message,checkedAt:Date.now(),expiresAt:0});
        if(/429|50011|rate limit/i.test(error.message)){scanner.done++;stopScanner('遇到 API 限流，已停止；稍後再試');break;}
      }
      scanner.done++;renderScanner();
      if(scanner.done<scanner.total)await scanPause(700,signal);
    }
    if(!signal.aborted)scanner.phase='本次掃描完成（不會自動重掃）';
  } catch(error) {
    if(!signal.aborted)scanner.phase=`掃描失敗：${error.message}`;
  } finally {scanner.running=false;renderScanner();}
}
document.addEventListener('DOMContentLoaded',()=>{
  $('start-scan').addEventListener('click',startScanner);$('stop-scan').addEventListener('click',()=>stopScanner());
  $('scan-only').addEventListener('change',renderScanner);$('scan-direction').addEventListener('change',renderScanner);
  $('scan-results').addEventListener('click',event=>{
    const symbol=event.target.closest('[data-scan-symbol]')?.dataset.scanSymbol;if(!symbol)return;
    if(!state.instruments.some(i=>i.instId===symbol)){scanner.phase='合約清單已改變，請重載清單後再選擇';renderScanner();return;}
    if(symbol===INSTRUMENT)loadMarket();else switchInstrument(symbol);
    document.querySelector('[data-tab="overview"]').click();$('trade-report-card').scrollIntoView({behavior:'smooth',block:'start'});
  });
  $('analysis-cost').addEventListener('input',()=>{stopScanner('費用假設已改變，請重新掃描');scanner.results=[];scanner.done=0;scanner.total=0;renderScanner();});
  window.addEventListener('offline',()=>{stopScanner('裝置離線，請恢復連線後重新掃描');scanner.results.forEach(row=>row.expiresAt=0);renderScanner();});
  setInterval(()=>{if(scanner.results.some(row=>!row.error&&Date.now()>=row.expiresAt&&!row.expiredShown)){scanner.results.forEach(row=>{if(Date.now()>=row.expiresAt)row.expiredShown=true;});renderScanner();}},1000);
  renderScanner();
});
