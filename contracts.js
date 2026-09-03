(function(root){
  function valid(i) {
    return !!i && /^[A-Z0-9]+-USDT-SWAP$/.test(i.instId) && i.instType==='SWAP' && i.settleCcy==='USDT' && i.ctType==='linear' && i.state==='live' && i.ruleType!=='pre_market' &&
      i.ctValCcy===i.instId.split('-')[0] && [i.ctVal,i.lotSz,i.minSz,i.tickSz].every(x=>Number.isFinite(Number(x))&&Number(x)>0) &&
      (i.ctMult==='' || i.ctMult===undefined || Number(i.ctMult)===1);
  }
  function decimals(step) {
    const [n,e='0']=String(step).toLowerCase().split('e');
    return Math.min(16,Math.max(0,(n.split('.')[1]||'').length-Number(e)));
  }
  function size(risk,entry,stop,fee,meta) {
    if(!valid(meta) || ![risk,entry,stop,fee].every(Number.isFinite) || risk<=0 || entry<=0 || stop<=0 || fee<0 || entry===stop) return null;
    const unit=Number(meta.ctVal),lot=Number(meta.lotSz),cost=Math.abs(entry-stop)+entry*fee/100;
    let steps=Math.floor(risk/cost/unit/lot);
    let contracts=Number((steps*lot).toFixed(decimals(meta.lotSz)));
    if(contracts*unit*cost>risk) {steps--;contracts=Number((steps*lot).toFixed(decimals(meta.lotSz)));}
    if(contracts<Number(meta.minSz) || contracts<=0 || !Number.isFinite(contracts)) return null;
    return {contracts,quantity:contracts*unit,risk:contracts*unit*cost};
  }
  const api={valid,decimals,size};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.OkxContracts=api;
})(globalThis);
