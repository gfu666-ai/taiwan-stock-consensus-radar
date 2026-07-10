import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../data/recommendation-config.json", import.meta.url), "utf8"));
const focusById = new Map(config.focuses.map(focus => [focus.id, focus]));
const TWSE_OPEN = "https://openapi.twse.com.tw/v1";
const FINMIND = "https://api.finmindtrade.com/api/v4/data";

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const number = value => {
  const parsed = Number(String(value ?? "").replaceAll(",", "").replaceAll("--", ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const scale = (value, low, high) => value == null ? 0 : clamp((value - low) / (high - low), 0, 1);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sum = values => values.reduce((total, value) => total + (value ?? 0), 0);

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "taiwan-stock-recommendation-research/1.0" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`Fetch failed: ${url}: ${lastError?.message}`);
}

function rocDateToIso(value) {
  const digits = String(value).replaceAll("/", "");
  const yearLength = digits.length - 4;
  const year = Number(digits.slice(0, yearLength)) + 1911;
  return `${year}-${digits.slice(yearLength, yearLength + 2)}-${digits.slice(-2)}`;
}

async function fetchStockHistory(code, latestDate) {
  const end = new Date(`${latestDate}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 190);
  const startDate = start.toISOString().slice(0, 10);
  const url = `${FINMIND}?dataset=TaiwanStockPrice&data_id=${code}&start_date=${startDate}&end_date=${latestDate}`;
  const payload = await fetchJson(url);
  return (payload.data ?? []).map(row => ({
    date: row.date,
    volume: number(row.Trading_Volume),
    open: number(row.open), high: number(row.max), low: number(row.min), close: number(row.close)
  })).filter(row => row.close != null).sort((a, b) => a.date.localeCompare(b.date));
}

function sma(values, period) {
  return values.length >= period ? average(values.slice(-period)) : null;
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let gains = average(changes.slice(0, period).map(change => Math.max(change, 0)));
  let losses = average(changes.slice(0, period).map(change => Math.max(-change, 0)));
  for (const change of changes.slice(period)) {
    gains = (gains * (period - 1) + Math.max(change, 0)) / period;
    losses = (losses * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function atr(rows, period = 14) {
  if (rows.length <= period) return null;
  const ranges = rows.slice(1).map((row, index) => Math.max(
    row.high - row.low,
    Math.abs(row.high - rows[index].close),
    Math.abs(row.low - rows[index].close)
  ));
  return average(ranges.slice(-period));
}

function stochastic(rows, period = 14) {
  if (rows.length < period) return { k: null, d: null };
  const kValues = [];
  for (let end = period; end <= rows.length; end += 1) {
    const window = rows.slice(end - period, end);
    const lowest = Math.min(...window.map(row => row.low));
    const highest = Math.max(...window.map(row => row.high));
    kValues.push(highest === lowest ? 50 : (window.at(-1).close - lowest) / (highest - lowest) * 100);
  }
  return { k: kValues.at(-1), d: average(kValues.slice(-3)) };
}

function technicalMetrics(rows) {
  const closes = rows.map(row => row.close);
  const volumes = rows.map(row => row.volume);
  const close = closes.at(-1);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macd = ema12.map((value, index) => value - ema26[index]);
  const signal = emaSeries(macd, 9);
  const stoch = stochastic(rows);
  const atrValue = atr(rows);
  const high60 = rows.length ? Math.max(...rows.slice(-60).map(row => row.high)) : null;
  const returnAt = days => closes.length > days ? (close / closes.at(-days - 1) - 1) * 100 : null;
  const obv = rows.slice(1).reduce((values, row, index) => {
    const direction = Math.sign(row.close - rows[index].close);
    values.push(values.at(-1) + direction * row.volume);
    return values;
  }, [0]);
  return {
    close, ma5, ma20, ma60, rsi14: rsi(closes),
    macdHistogram: macd.length ? macd.at(-1) - signal.at(-1) : null,
    stochasticK: stoch.k, stochasticD: stoch.d,
    atrPct: atrValue && close ? atrValue / close * 100 : null,
    volumeRatio5to20: sma(volumes, 5) && sma(volumes, 20) ? sma(volumes, 5) / sma(volumes, 20) : null,
    return5d: returnAt(5), return20d: returnAt(20), return60d: returnAt(60),
    drawdown60d: high60 ? (close / high60 - 1) * 100 : null,
    obv20Change: obv.length > 20 ? obv.at(-1) - obv.at(-21) : null,
    averageVolume20: sma(volumes, 20), historyDays: rows.length
  };
}

function scoreTechnical(metric) {
  let score = 0;
  score += metric.close > metric.ma20 ? 4 : 0;
  score += metric.ma20 > metric.ma60 ? 4 : 0;
  score += metric.ma5 > metric.ma20 ? 4 : 0;
  score += metric.rsi14 >= 50 && metric.rsi14 <= 70 ? 4 : metric.rsi14 >= 40 && metric.rsi14 <= 75 ? 2 : 0;
  score += metric.macdHistogram > 0 ? 2 : 0;
  score += metric.stochasticK > metric.stochasticD && metric.stochasticK < 85 ? 2 : 0;
  score += scale(metric.return20d, -10, 20) * 4;
  score += scale(metric.return60d, -15, 40) * 2;
  score += metric.volumeRatio5to20 > 1.1 && metric.return5d > 0 ? 4 : metric.volumeRatio5to20 > 0.9 ? 2 : 1;
  score += metric.atrPct <= 3 ? 3 : metric.atrPct <= 5 ? 2 : metric.atrPct <= 8 ? 1 : 0;
  score += metric.drawdown60d >= -10 ? 2 : metric.drawdown60d >= -20 ? 1 : 0;
  return round(score);
}

function financialMetrics(revenue, income, balance, valuation) {
  const sales = number(income?.["營業收入"]);
  const assets = number(balance?.["資產總額"]);
  return {
    revenueMonth: revenue?.["資料年月"] ?? null,
    revenueYoY: number(revenue?.["營業收入-去年同月增減(%)"]),
    revenueCumulativeYoY: number(revenue?.["累計營業收入-前期比較增減(%)"]),
    grossMargin: sales ? number(income?.["營業毛利（毛損）"]) / sales * 100 : null,
    operatingMargin: sales ? number(income?.["營業利益（損失）"]) / sales * 100 : null,
    netMargin: sales ? number(income?.["本期淨利（淨損）"]) / sales * 100 : null,
    eps: number(income?.["基本每股盈餘（元）"]),
    currentRatio: number(balance?.["流動負債"]) ? number(balance?.["流動資產"]) / number(balance?.["流動負債"]) : null,
    debtRatio: assets ? number(balance?.["負債總額"]) / assets * 100 : null,
    pe: number(valuation?.PEratio), pb: number(valuation?.PBratio), dividendYield: number(valuation?.DividendYield),
    fiscalPeriod: income ? `${income["年度"]}Q${income["季別"]}` : null
  };
}

function scoreFundamental(metric) {
  let score = 0;
  score += scale(metric.revenueYoY, -10, 30) * 6;
  score += scale(metric.revenueCumulativeYoY, -5, 25) * 4;
  score += scale(metric.grossMargin, 10, 55) * 3;
  score += scale(metric.operatingMargin, 3, 30) * 4;
  score += scale(metric.netMargin, 2, 25) * 3;
  score += scale(metric.currentRatio, 0.8, 2) * 3;
  score += scale(metric.debtRatio == null ? null : 75 - metric.debtRatio, 5, 45) * 2;
  score += metric.pe > 0 && metric.pe <= 20 ? 3 : metric.pe <= 30 ? 2.5 : metric.pe <= 40 ? 1.5 : metric.pe <= 60 ? 0.5 : 0;
  score += metric.pb > 0 && metric.pb <= 3 ? 2 : metric.pb <= 6 ? 1.5 : metric.pb <= 10 ? 0.75 : 0.25;
  return round(score);
}

async function fetchInstitutionHistory(code, latestDate) {
  const end = new Date(`${latestDate}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 45);
  const startDate = start.toISOString().slice(0, 10);
  const url = `${FINMIND}?dataset=TaiwanStockInstitutionalInvestorsBuySellWide&data_id=${code}&start_date=${startDate}&end_date=${latestDate}`;
  const payload = await fetchJson(url);
  return (payload.data ?? []).map(row => {
    const foreign = (number(row.Foreign_Investor_buy) ?? 0) - (number(row.Foreign_Investor_sell) ?? 0);
    const trust = (number(row.Investment_Trust_buy) ?? 0) - (number(row.Investment_Trust_sell) ?? 0);
    const dealer = ["Dealer", "Dealer_self", "Dealer_Hedging"].reduce((total, prefix) =>
      total + (number(row[`${prefix}_buy`]) ?? 0) - (number(row[`${prefix}_sell`]) ?? 0), 0);
    return { date: row.date, foreign, trust, dealer, total: foreign + trust + dealer };
  }).sort((a, b) => a.date.localeCompare(b.date)).slice(-20);
}

function institutionalMetrics(rows, averageVolume20) {
  const recent5 = rows.slice(-5);
  const volumeBase = averageVolume20 || 1;
  return {
    days: rows.length,
    foreign20: sum(rows.map(row => row.foreign)),
    trust20: sum(rows.map(row => row.trust)),
    dealer20: sum(rows.map(row => row.dealer)),
    total20: sum(rows.map(row => row.total)),
    total5: sum(recent5.map(row => row.total)),
    positiveDays: rows.filter(row => row.total > 0).length,
    foreignToVolume: sum(rows.map(row => row.foreign)) / (volumeBase * Math.max(rows.length, 1)),
    trustToVolume: sum(rows.map(row => row.trust)) / (volumeBase * Math.max(rows.length, 1)),
    dealerToVolume: sum(rows.map(row => row.dealer)) / (volumeBase * Math.max(rows.length, 1)),
    total5ToVolume: sum(recent5.map(row => row.total)) / (volumeBase * Math.max(recent5.length, 1))
  };
}

function scoreInstitutional(metric) {
  let score = 0;
  score += scale(metric.foreignToVolume, -0.3, 0.3) * 8;
  score += scale(metric.trustToVolume, -0.12, 0.12) * 5;
  score += scale(metric.dealerToVolume, -0.12, 0.12) * 3;
  score += scale(metric.total5ToVolume, -0.25, 0.25) * 2;
  score += metric.days ? metric.positiveDays / metric.days * 2 : 0;
  return round(score);
}

async function fetchUsMetric(symbol) {
  const payload = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=6mo&interval=1d`);
  const result = payload.chart?.result?.[0];
  if (!result) return null;
  const quote = result.indicators.quote[0];
  const closes = quote.close.filter(value => value != null);
  const close = closes.at(-1);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const return20d = closes.length > 20 ? (close / closes.at(-21) - 1) * 100 : null;
  const score = scale(return20d, -10, 20) * 5 + (close > ma20 ? 2.5 : 0) + (ma20 > ma60 ? 2.5 : 0);
  return { symbol, close: round(close), return20d: round(return20d), aboveMa20: close > ma20, ma20AboveMa60: ma20 > ma60, score: round(score) };
}

function riskFlags(stock) {
  const flags = [];
  if (stock.technical.rsi14 > 75) flags.push("RSI 超過 75，短線過熱");
  if (stock.technical.drawdown60d < -20) flags.push("距 60 日高點回落超過 20%");
  if (stock.fundamental.pe > 60) flags.push("本益比高於 60 倍");
  if (stock.fundamental.revenueYoY < 0) flags.push("最新月營收年減");
  if (stock.institutional.total20 < 0) flags.push("近 20 個交易日三大法人合計賣超");
  if (stock.technical.historyDays < 60) flags.push("歷史行情不足 60 個交易日");
  return flags;
}

function recommendationReasons(stock) {
  const entries = [
    ["技術", stock.scores.technical, `${round(stock.technical.return20d)}% 月報酬，RSI ${round(stock.technical.rsi14)}`],
    ["財務", stock.scores.fundamental, `月營收年增 ${round(stock.fundamental.revenueYoY)}%，營益率 ${round(stock.fundamental.operatingMargin)}%`],
    ["法人", stock.institutional.total20 > 0 ? stock.scores.institutional : -1, `20 日合計買超 ${Math.round(stock.institutional.total20 / 1000).toLocaleString("en-US")} 張`],
    ["美股", stock.scores.usIndustry, `${stock.usIndustry.map(item => item.symbol).join("、")} 產業連動`]
  ].sort((a, b) => b[1] - a[1]);
  return entries.filter(([, score]) => score >= 0).slice(0, 3).map(([label, score, detail]) => `${label} ${score} 分：${detail}`);
}

const [market, valuationRows, revenueRows, incomeRows, balanceRows] = await Promise.all([
  fetchJson(`${TWSE_OPEN}/exchangeReport/STOCK_DAY_ALL`),
  fetchJson(`${TWSE_OPEN}/exchangeReport/BWIBBU_ALL`),
  fetchJson(`${TWSE_OPEN}/opendata/t187ap05_L`),
  fetchJson(`${TWSE_OPEN}/opendata/t187ap06_L_ci`),
  fetchJson(`${TWSE_OPEN}/opendata/t187ap07_L_ci`)
]);

const marketByCode = new Map(market.map(row => [row.Code, row]));
const valuationByCode = new Map(valuationRows.map(row => [row.Code, row]));
const revenueByCode = new Map(revenueRows.map(row => [row["公司代號"], row]));
const incomeByCode = new Map(incomeRows.map(row => [row["公司代號"], row]));
const balanceByCode = new Map(balanceRows.map(row => [row["公司代號"], row]));
const latestRocDate = market.find(row => /^\d{4}$/.test(row.Code))?.Date;
if (!latestRocDate) throw new Error("TWSE latest trading date is unavailable");
const latestDate = rocDateToIso(latestRocDate);

const histories = new Map();
for (let index = 0; index < config.candidates.length; index += 4) {
  const batch = config.candidates.slice(index, index + 4);
  const results = await Promise.all(batch.map(async candidate => [candidate.code, await fetchStockHistory(candidate.code, latestDate)]));
  results.forEach(([code, rows]) => histories.set(code, rows));
  console.log(`Fetched TWSE history ${Math.min(index + 4, config.candidates.length)}/${config.candidates.length}`);
}

const institutions = new Map();
for (let index = 0; index < config.candidates.length; index += 4) {
  const batch = config.candidates.slice(index, index + 4);
  const results = await Promise.all(batch.map(async candidate => [candidate.code, await fetchInstitutionHistory(candidate.code, latestDate)]));
  results.forEach(([code, rows]) => institutions.set(code, rows));
}

const usSymbols = [...new Set(config.candidates.flatMap(candidate => candidate.usLeaders))];
const usMetrics = new Map();
for (let index = 0; index < usSymbols.length; index += 5) {
  const batch = usSymbols.slice(index, index + 5);
  const results = await Promise.all(batch.map(fetchUsMetric));
  results.filter(Boolean).forEach(metric => usMetrics.set(metric.symbol, metric));
}

const scored = config.candidates.map(candidate => {
  const marketRow = marketByCode.get(candidate.code);
  const history = histories.get(candidate.code) ?? [];
  const technical = technicalMetrics(history);
  const fundamental = financialMetrics(
    revenueByCode.get(candidate.code), incomeByCode.get(candidate.code),
    balanceByCode.get(candidate.code), valuationByCode.get(candidate.code)
  );
  const institutional = institutionalMetrics(institutions.get(candidate.code) ?? [], technical.averageVolume20);
  const usIndustry = candidate.usLeaders.map(symbol => usMetrics.get(symbol)).filter(Boolean);
  const scores = {
    technical: scoreTechnical(technical),
    fundamental: scoreFundamental(fundamental),
    institutional: scoreInstitutional(institutional),
    usIndustry: round(average(usIndustry.map(metric => metric.score)) ?? 0),
    industryHeat: focusById.get(candidate.focusId)?.heatScore ?? 0
  };
  const total = round(sum(Object.values(scores)));
  const stock = {
    code: candidate.code,
    name: marketRow?.Name?.trim() ?? candidate.code,
    focusId: candidate.focusId,
    focusName: focusById.get(candidate.focusId)?.name,
    latestDate,
    latestPrice: number(marketRow?.ClosingPrice),
    scores: { ...scores, total }, technical, fundamental, institutional, usIndustry
  };
  stock.riskFlags = riskFlags(stock);
  stock.reasons = recommendationReasons(stock);
  stock.eligible = technical.historyDays >= 60 && fundamental.revenueYoY != null && fundamental.operatingMargin != null;
  return stock;
}).sort((a, b) => b.scores.total - a.scores.total);

const recommendations = [];
const focusCounts = new Map();
for (const stock of scored.filter(stock => stock.eligible)) {
  if ((focusCounts.get(stock.focusId) ?? 0) >= 2) continue;
  recommendations.push({ ...stock, rank: recommendations.length + 1 });
  focusCounts.set(stock.focusId, (focusCounts.get(stock.focusId) ?? 0) + 1);
  if (recommendations.length === 3) break;
}
if (recommendations.length !== 3) throw new Error(`Expected 3 recommendations, got ${recommendations.length}`);

const output = {
  generatedAt: new Date().toISOString(),
  dataAsOf: latestDate,
  focusWindow: config.focusWindow,
  scope: "臺灣證券交易所上市普通股候選池",
  disclaimer: "本模型為研究與風險排序工具，不保證報酬，也不構成個人化投資建議。",
  weights: config.weights,
  focuses: config.focuses,
  recommendations,
  candidates: scored,
  methodology: {
    technical: ["MA5/20/60", "RSI14", "MACD", "KD", "ATR14", "5/20/60日報酬", "量比", "OBV", "60日回撤"],
    fundamental: ["月營收年增", "累計營收年增", "毛利率", "營益率", "淨利率", "流動比", "負債比", "本益比", "股價淨值比"],
    institutional: ["外資20日", "投信20日", "自營商20日", "三大法人5日", "法人買超天數"],
    usIndustry: "以對應美股產業龍頭20日報酬與均線趨勢作為景氣代理",
    selection: "總分排序後，同一產業最多選入2檔；行情不足60日或財務欄位不足者不列入前三名。"
  },
  sources: {
    twseMarket: "https://openapi.twse.com.tw/",
    taiwanHistoryAndInstitutional: "https://api.finmindtrade.com/api/v4/data",
    usMarket: "https://query1.finance.yahoo.com/v8/finance/chart/"
  }
};

writeFileSync(new URL("../data/recommendations.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Built ${recommendations.length} recommendations as of ${latestDate}: ${recommendations.map(stock => `${stock.code} ${stock.name} ${stock.scores.total}`).join(", ")}`);
