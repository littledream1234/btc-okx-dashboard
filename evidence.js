/* Pure, testable evidence calculations. Heuristic filters, not measured win probabilities. */
(function (root) {
  const finite = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
  function completed(candles, interval, now = Date.now()) {
    const rows = candles.filter(c => c.confirmed).slice().sort((a, b) => a.time - b.time);
    if (rows.length < 100) return null;
    if (rows.some((c, i) => ![c.time,c.open,c.high,c.low,c.close,c.volume,c.quoteVolume].every(finite) ||
      c.low <= 0 || c.low > Math.min(c.open,c.close) || c.high < Math.max(c.open,c.close) ||
      c.volume < 0 || c.quoteVolume < 0 || c.time + interval > now + 5000 ||
      (i > 0 && c.time - rows[i-1].time !== interval))) return null;
    if (now - (rows.at(-1).time + interval) > interval + 90000) return null;
    return rows;
  }
  function adx(rows, period = 14) {
    if (rows.length < period * 2 + 1) return null;
    let tr = 0, plus = 0, minus = 0, value = null;
    const dx = [];
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i], p = rows[i-1], up = c.high-p.high, down = p.low-c.low;
      const t = Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
      const a = up > down && up > 0 ? up : 0, b = down > up && down > 0 ? down : 0;
      if (i <= period) { tr += t; plus += a; minus += b; }
      else { tr = tr-tr/period+t; plus = plus-plus/period+a; minus = minus-minus/period+b; }
      if (i >= period) {
        const d = plus+minus > 0 && tr > 0 ? 100*Math.abs(plus-minus)/(plus+minus) : 0;
        dx.push(d);
        if (dx.length === period) value = dx.reduce((s,x)=>s+x,0)/period;
        else if (dx.length > period) value = (value*(period-1)+d)/period;
      }
    }
    return value;
  }
  function relativeVolume(rows) {
    const baseline = rows.slice(-21,-1).map(c=>c.quoteVolume);
    const mean = baseline.reduce((s,x)=>s+x,0)/baseline.length;
    return mean > 0 ? rows.at(-1).quoteVolume/mean : null;
  }
  function pivots(rows) {
    const levels = [];
    for (let i = 2; i < rows.length-2; i++) {
      const c = rows[i], neighbours = [rows[i-2],rows[i-1],rows[i+1],rows[i+2]];
      if (neighbours.every(p=>c.high>p.high)) levels.push(c.high);
      if (neighbours.every(p=>c.low<p.low)) levels.push(c.low);
    }
    return [...new Set(levels)].sort((a,b)=>a-b);
  }
  function fundingPosition(history, funding, now = Date.now()) {
    const interval = funding.nextFundingTime-funding.fundingTime;
    if (!(interval > 0) || !finite(funding.rate)) return null;
    const rows = history.filter(r=>finite(r.realizedRate) && finite(r.fundingTime) && Number(r.fundingTime)<=now)
      .slice().sort((a,b)=>Number(a.fundingTime)-Number(b.fundingTime));
    const samples = rows.filter((r,i)=>i>0 && Number(r.fundingTime)-Number(rows[i-1].fundingTime)===interval);
    if (samples.length < 20 || now-Number(rows.at(-1).fundingTime)>interval+90000) return null;
    const below = samples.filter(r=>Number(r.realizedRate)<funding.rate).length;
    const equal = samples.filter(r=>Number(r.realizedRate)===funding.rate).length;
    return { percentile:100*(below+equal*.5)/samples.length, count:samples.length,
      hours:interval/3600000, from:Number(samples[0].fundingTime), to:Number(samples.at(-1).fundingTime) };
  }
  function oiChange(series, current) {
    if (!(current.oiCcy>0) || !finite(current.ts)) return null;
    const baseline = series.filter(p=>p.oiCcy>0 && Math.abs(current.ts-p.ts-3600000)<=300000)
      .sort((a,b)=>Math.abs(current.ts-a.ts-3600000)-Math.abs(current.ts-b.ts-3600000))[0];
    return baseline ? { changePct:(current.oiCcy/baseline.oiCcy-1)*100, minutes:(current.ts-baseline.ts)/60000 } : null;
  }
  function structurePlan(direction, h1, levels, costPercent, last) {
    const long = direction==='long';
    const entryLow = h1.ema20-h1.atr*(long?.2:.1), entryHigh=h1.ema20+h1.atr*(long?.1:.2);
    const entry=long?entryHigh:entryLow;
    const stop=long?Math.min(h1.swingLow,entryLow-h1.atr*.35):Math.max(h1.swingHigh,entryHigh+h1.atr*.35);
    const target=long?levels.find(x=>x>entry):levels.slice().reverse().find(x=>x<entry);
    const risk=Math.abs(entry-stop), cost=entry*costPercent/100;
    const rr=target && risk>0 ? (Math.abs(target-entry)-cost)/(risk+cost) : null;
    return {entryLow,entryHigh,entry,stop,target:target??null,risk,rr,costPercent,
      withinZone:last>=entryLow && last<=entryHigh, eligible:Number.isFinite(rr)&&rr>=2&&stop>0};
  }
  const api={completed,adx,relativeVolume,pivots,fundingPosition,oiChange,structurePlan};
  if (typeof module==='object' && module.exports) module.exports=api;
  else root.BtcEvidence=api;
})(typeof globalThis==='object'?globalThis:this);
