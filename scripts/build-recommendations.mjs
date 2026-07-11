import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../data/recommendation-config.json", import.meta.url), "utf8"));
let previousOutput = null;
try {
  previousOutput = JSON.parse(readFileSync(new URL("../data/recommendations.json", import.meta.url), "utf8"));
} catch {
  // The first run has no prior snapshot to compare against.
}
const focusById = new Map(config.focuses.map(focus => [focus.id, focus]));
const overrideByCode = new Map(config.focusOverrides.map(item => [item.code, item]));
const TWSE_OPEN = "https://openapi.twse.com.tw/v1";
const TWSE_RWD = "https://www.twse.com.tw/rwd/zh";

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
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
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

async function fetchTradingDates(latestDate) {
  const payload = await fetchJson("https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?range=6mo&interval=1d");
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error("Trading calendar is unavailable");
  return result.timestamp.map(timestamp => new Date(timestamp * 1000).toISOString().slice(0, 10))
    .filter(date => date <= latestDate).slice(-config.universe.historyTradingDays);
}

function parseMarketDay(payload, date) {
  const table = payload.tables?.find(item => item.fields?.includes("證券代號") && item.fields?.includes("收盤價"));
  if (!table) return [];
  return table.data.map(row => ({
    code: String(row[0]).trim(), date,
    volume: number(row[2]), tradingValue: number(row[4]),
    open: number(row[5]), high: number(row[6]), low: number(row[7]), close: number(row[8])
  })).filter(row => /^\d{4}$/.test(row.code) && row.close != null);
}

async function fetchAllMarketHistory(tradingDates) {
  const histories = new Map();
  for (let index = 0; index < tradingDates.length; index += 1) {
    const date = tradingDates[index];
    const payload = await fetchJson(`${TWSE_RWD}/afterTrading/MI_INDEX?date=${date.replaceAll("-", "")}&type=ALLBUT0999&response=json`);
    for (const row of parseMarketDay(payload, date)) {
      if (!histories.has(row.code)) histories.set(row.code, []);
      histories.get(row.code).push(row);
    }
    if ((index + 1) % 10 === 0 || index === tradingDates.length - 1) console.log(`Fetched TWSE market days ${index + 1}/${tradingDates.length}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return histories;
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
  const tradingValues = rows.map(row => row.tradingValue);
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
  const recent20 = rows.slice(-20);
  const low20 = recent20.length ? Math.min(...recent20.map(row => row.low)) : null;
  const high20 = recent20.length ? Math.max(...recent20.map(row => row.high)) : null;
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
    atr14: atrValue, low20, high20,
    atrPct: atrValue && close ? atrValue / close * 100 : null,
    volumeRatio5to20: sma(volumes, 5) && sma(volumes, 20) ? sma(volumes, 5) / sma(volumes, 20) : null,
    return5d: returnAt(5), return20d: returnAt(20), return60d: returnAt(60),
    drawdown60d: high60 ? (close / high60 - 1) * 100 : null,
    obv20Change: obv.length > 20 ? obv.at(-1) - obv.at(-21) : null,
    averageVolume5: sma(volumes, 5), averageVolume20: sma(volumes, 20), averageTradingValue20: sma(tradingValues, 20), historyDays: rows.length
  };
}

function scoreTechnical(metric) {
  if (!metric.close || metric.historyDays < config.universe.minimumHistoryDays) return null;
  let score = 0;
  score += metric.close > metric.ma20 ? 4 : 0;
  score += metric.ma20 > metric.ma60 ? 4 : 0;
  score += metric.ma5 > metric.ma20 ? 4 : 0;
  score += metric.rsi14 != null && metric.rsi14 >= 50 && metric.rsi14 <= 70 ? 4 : metric.rsi14 != null && metric.rsi14 >= 40 && metric.rsi14 <= 75 ? 2 : 0;
  score += metric.macdHistogram > 0 ? 2 : 0;
  score += metric.stochasticK > metric.stochasticD && metric.stochasticK < 85 ? 2 : 0;
  score += scale(metric.return20d, -10, 20) * 4;
  score += scale(metric.return60d, -15, 40) * 2;
  score += metric.volumeRatio5to20 > 1.1 && metric.return5d > 0 ? 4 : metric.volumeRatio5to20 > 0.9 ? 2 : 1;
  score += metric.atrPct != null && metric.atrPct <= 3 ? 3 : metric.atrPct != null && metric.atrPct <= 5 ? 2 : metric.atrPct != null && metric.atrPct <= 8 ? 1 : 0;
  score += metric.drawdown60d != null && metric.drawdown60d >= -10 ? 2 : metric.drawdown60d != null && metric.drawdown60d >= -20 ? 1 : 0;
  return round(score);
}

function firstNumber(row, keys) {
  for (const key of keys) {
    const value = number(row?.[key]);
    if (value != null) return value;
  }
  return null;
}

function financialMetrics(revenue, income, balance, valuation, industryCode) {
  const isFinancial = industryCode === "17";
  const sales = firstNumber(income, ["營業收入", "淨收益", "收益合計"]);
  const assets = firstNumber(balance, ["資產總額", "資產總計"]);
  const liabilities = firstNumber(balance, ["負債總額", "負債總計"]);
  const equity = firstNumber(balance, ["權益總額", "權益總計"]);
  const netIncome = firstNumber(income, ["本期淨利（淨損）", "本期稅後淨利（淨損）", "繼續營業單位本期淨利（淨損）"]);
  return {
    isFinancial,
    revenueMonth: revenue?.["資料年月"] ?? null,
    revenueYoY: number(revenue?.["營業收入-去年同月增減(%)"]),
    revenueCumulativeYoY: number(revenue?.["累計營業收入-前期比較增減(%)"]),
    grossMargin: sales ? number(income?.["營業毛利（毛損）"]) / sales * 100 : null,
    operatingMargin: sales ? number(income?.["營業利益（損失）"]) / sales * 100 : null,
    netMargin: sales && netIncome != null ? netIncome / sales * 100 : null,
    roa: assets && netIncome != null ? netIncome * 4 / assets * 100 : null,
    roe: equity && netIncome != null ? netIncome * 4 / equity * 100 : null,
    eps: number(income?.["基本每股盈餘（元）"]),
    currentRatio: number(balance?.["流動負債"]) ? number(balance?.["流動資產"]) / number(balance?.["流動負債"]) : null,
    debtRatio: assets && liabilities != null ? liabilities / assets * 100 : null,
    pe: number(valuation?.PEratio), pb: number(valuation?.PBratio), dividendYield: number(valuation?.DividendYield),
    fiscalPeriod: income ? `${income["年度"]}Q${income["季別"]}` : null
  };
}

function scoreFundamental(metric) {
  const growthComplete = metric.revenueYoY != null && metric.revenueCumulativeYoY != null;
  if (!growthComplete) return null;
  let score = 0;
  score += scale(metric.revenueYoY, -10, 30) * 6;
  score += scale(metric.revenueCumulativeYoY, -5, 25) * 4;
  if (metric.isFinancial) {
    if (metric.roe == null || metric.roa == null || metric.eps == null) return null;
    score += scale(metric.roe, 3, 15) * 6;
    score += scale(metric.roa, 0.3, 1.5) * 4;
    score += scale(metric.eps, 0, 3) * 3;
    score += scale(metric.dividendYield, 0, 5) * 2;
  } else {
    if (metric.grossMargin == null || metric.operatingMargin == null || metric.netMargin == null || metric.currentRatio == null || metric.debtRatio == null) return null;
    score += scale(metric.grossMargin, 10, 55) * 3;
    score += scale(metric.operatingMargin, 3, 30) * 4;
    score += scale(metric.netMargin, 2, 25) * 3;
    score += scale(metric.currentRatio, 0.8, 2) * 3;
    score += scale(75 - metric.debtRatio, 5, 45) * 2;
  }
  score += metric.pe > 0 && metric.pe <= 20 ? 3 : metric.pe <= 30 ? 2.5 : metric.pe <= 40 ? 1.5 : metric.pe <= 60 ? 0.5 : 0;
  score += metric.pb > 0 && metric.pb <= 3 ? 2 : metric.pb <= 6 ? 1.5 : metric.pb <= 10 ? 0.75 : 0.25;
  return round(score);
}

function parseInstitutionDay(payload) {
  if (payload.stat !== "OK" || !Array.isArray(payload.data)) return new Map();
  return new Map(payload.data.filter(row => /^\d{4}$/.test(String(row[0]).trim())).map(row => [String(row[0]).trim(), {
    foreign: number(row[4]) ?? 0,
    trust: number(row[10]) ?? 0,
    dealer: number(row[11]) ?? 0,
    total: number(row[18]) ?? 0
  }]));
}

async function fetchAllInstitutionDays(tradingDates) {
  const days = [];
  for (const date of tradingDates.slice(-20)) {
    const payload = await fetchJson(`${TWSE_RWD}/fund/T86?date=${date.replaceAll("-", "")}&selectType=ALLBUT0999&response=json`);
    days.push({ date, map: parseInstitutionDay(payload) });
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return days;
}

function institutionalMetrics(code, dailyMaps, averageVolume20) {
  const rows = institutionalHistory(code, dailyMaps);
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

function institutionalHistory(code, dailyMaps) {
  return dailyMaps.map(({ date, map }) => ({ date, ...(map.get(code) ?? { foreign: 0, trust: 0, dealer: 0, total: 0 }) }));
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
  if (stock.technical.return60d > 45) flags.push("近 60 日漲幅超過 45%，不宜追價");
  if (stock.technical.drawdown60d < -20) flags.push("距 60 日高點回落超過 20%");
  if (stock.fundamental.pe > 60) flags.push("本益比高於 60 倍");
  if (stock.fundamental.revenueYoY < 0) flags.push("最新月營收年減");
  if (stock.institutional.total20 < 0) flags.push("近 20 個交易日三大法人合計賣超");
  if (stock.technical.historyDays < 60) flags.push("歷史行情不足 60 個交易日");
  return flags;
}

function recommendationReasons(stock) {
  const financialDetail = stock.fundamental.isFinancial
    ? `月營收年增 ${round(stock.fundamental.revenueYoY)}%，年化 ROE ${round(stock.fundamental.roe)}%`
    : `月營收年增 ${round(stock.fundamental.revenueYoY)}%，營益率 ${round(stock.fundamental.operatingMargin)}%`;
  const entries = [
    ["技術", stock.scores.technical, `${round(stock.technical.return20d)}% 月報酬，RSI ${round(stock.technical.rsi14)}`],
    ["財務", stock.scores.fundamental, financialDetail],
    ["法人", stock.institutional.total20 > 0 ? stock.scores.institutional : -1, `20 日合計買超 ${Math.round(stock.institutional.total20 / 1000).toLocaleString("en-US")} 張`],
    ["美股", stock.scores.usIndustry, `${stock.usIndustry.map(item => item.symbol).join("、")} 產業連動`]
  ].sort((a, b) => b[1] - a[1]);
  return entries.filter(([, score]) => score >= 0).slice(0, 3).map(([label, score, detail]) => `${label} ${score} 分：${detail}`);
}

function decisionFor(stock) {
  const rules = config.decisionRules;
  const blockingRisks = stock.riskFlags.filter(risk =>
    rules.blockingRiskPatterns.some(pattern => risk.includes(pattern))
  );
  if (stock.scores.total >= rules.buyMinScore && blockingRisks.length === 0) {
    return { level: "buy", label: rules.buyLabel, reason: `總分達 ${rules.buyMinScore} 分，且無重大風險旗標` };
  }
  if (stock.scores.total >= rules.buyMinScore) {
    return { level: "blocked", label: rules.blockedLabel, reason: blockingRisks.join("；") };
  }
  if (stock.scores.total >= rules.watchMinScore) {
    return { level: "watch", label: rules.watchLabel, reason: `總分未達買進門檻 ${rules.buyMinScore} 分` };
  }
  return { level: "avoid", label: rules.avoidLabel, reason: `總分低於觀察門檻 ${rules.watchMinScore} 分` };
}

function entryPlanFor(stock) {
  const { close, ma20, ma60, atr14, high20 } = stock.technical;
  if (![close, ma20, ma60, atr14, high20].every(Number.isFinite) || atr14 <= 0) return null;

  const trendSupport = Math.max(ma20, ma60);
  const lowerSupport = Math.min(ma20, ma60);
  const zoneLow = Math.max(lowerSupport, trendSupport - atr14 * 0.75);
  const zoneHigh = Math.max(zoneLow, trendSupport + atr14 * 0.25);
  const breakoutPrice = Math.max(zoneHigh, high20 + atr14 * 0.25);
  const invalidationPrice = Math.max(0.01, Math.min(lowerSupport, zoneLow) - atr14 * 1.5);
  const overheated = stock.technical.rsi14 > 75 || stock.riskFlags.some(risk => risk.includes("不宜追價"));

  let status = "等待回測";
  if (!overheated && close >= zoneLow && close <= zoneHigh) status = "接近分批區";
  else if (!overheated && close < zoneLow) status = "等待站回支撐";
  else if (close > zoneHigh) status = "等待拉回";

  return {
    method: "MA20／MA60 趨勢支撐 + ATR14 波動 + 20日高點突破",
    zoneLow: round(zoneLow),
    zoneHigh: round(zoneHigh),
    breakoutPrice: round(breakoutPrice),
    invalidationPrice: round(invalidationPrice),
    status,
    rationale: `優先等待 ${round(zoneLow)}–${round(zoneHigh)} 元量縮止穩；若未回測，須放量突破 ${round(breakoutPrice)} 元再評估。跌破 ${round(invalidationPrice)} 元視為模型失效。`
  };
}

const statementKinds = ["ci", "basi", "bd", "fh", "ins", "mim"];
const [market, companyRows, valuationRows, revenueRows, incomeGroups, balanceGroups] = await Promise.all([
  fetchJson(`${TWSE_OPEN}/exchangeReport/STOCK_DAY_ALL`),
  fetchJson(`${TWSE_OPEN}/opendata/t187ap03_L`),
  fetchJson(`${TWSE_OPEN}/exchangeReport/BWIBBU_ALL`),
  fetchJson(`${TWSE_OPEN}/opendata/t187ap05_L`),
  Promise.all(statementKinds.map(kind => fetchJson(`${TWSE_OPEN}/opendata/t187ap06_L_${kind}`))),
  Promise.all(statementKinds.map(kind => fetchJson(`${TWSE_OPEN}/opendata/t187ap07_L_${kind}`)))
]);

const marketByCode = new Map(market.map(row => [row.Code, row]));
const valuationByCode = new Map(valuationRows.map(row => [row.Code, row]));
const revenueByCode = new Map(revenueRows.map(row => [row["公司代號"], row]));
const incomeRows = incomeGroups.flat();
const balanceRows = balanceGroups.flat();
const incomeByCode = new Map(incomeRows.map(row => [row["公司代號"], row]));
const balanceByCode = new Map(balanceRows.map(row => [row["公司代號"], row]));
const latestRocDate = market.find(row => /^\d{4}$/.test(row.Code))?.Date;
if (!latestRocDate) throw new Error("TWSE latest trading date is unavailable");
const latestDate = rocDateToIso(latestRocDate);

const universe = companyRows.filter(company => /^\d{4}$/.test(company["公司代號"])).map(company => {
  const code = company["公司代號"];
  const industryCode = company["產業別"];
  const profile = config.industryProfiles[industryCode] ?? { name: `產業代碼 ${industryCode}`, usLeaders: ["SPY"] };
  const override = overrideByCode.get(code);
  const focusId = override?.focusId ?? profile.focusId ?? `industry-${industryCode}`;
  return {
    code,
    name: company["公司簡稱"]?.trim() || marketByCode.get(code)?.Name?.trim() || code,
    industryCode,
    industryName: profile.name,
    focusId,
    focusName: focusById.get(focusId)?.name ?? profile.name,
    usLeaders: override?.usLeaders ?? profile.usLeaders ?? ["SPY"]
  };
});

const tradingDates = await fetchTradingDates(latestDate);
const histories = await fetchAllMarketHistory(tradingDates);
const institutionalDays = await fetchAllInstitutionDays(tradingDates);

const usSymbols = [...new Set(universe.flatMap(candidate => candidate.usLeaders))];
const usMetrics = new Map();
for (let index = 0; index < usSymbols.length; index += 5) {
  const batch = usSymbols.slice(index, index + 5);
  const results = await Promise.all(batch.map(fetchUsMetric));
  results.filter(Boolean).forEach(metric => usMetrics.set(metric.symbol, metric));
}

const allStocks = universe.map(candidate => {
  const marketRow = marketByCode.get(candidate.code);
  const history = histories.get(candidate.code) ?? [];
  const technical = technicalMetrics(history);
  const fundamental = financialMetrics(
    revenueByCode.get(candidate.code), incomeByCode.get(candidate.code),
    balanceByCode.get(candidate.code), valuationByCode.get(candidate.code), candidate.industryCode
  );
  const institutional = institutionalMetrics(candidate.code, institutionalDays, technical.averageVolume20);
  const usIndustry = candidate.usLeaders.map(symbol => usMetrics.get(symbol)).filter(Boolean);
  const scores = {
    technical: scoreTechnical(technical),
    fundamental: scoreFundamental(fundamental),
    institutional: scoreInstitutional(institutional),
    usIndustry: round(average(usIndustry.map(metric => metric.score)) ?? 0),
    industryHeat: focusById.get(candidate.focusId)?.heatScore ?? 0
  };
  const exclusionReasons = [];
  const latestPrice = number(marketRow?.ClosingPrice);
  if (latestPrice == null || latestPrice < config.universe.minimumPrice) exclusionReasons.push(`股價低於 ${config.universe.minimumPrice} 元或無成交價`);
  if (technical.historyDays < config.universe.minimumHistoryDays) exclusionReasons.push(`日K不足 ${config.universe.minimumHistoryDays} 日`);
  if (technical.averageVolume5 == null || technical.averageVolume5 < config.universe.minimumAverageVolume5) exclusionReasons.push(`最近5個交易日平均成交量低於 ${Math.round(config.universe.minimumAverageVolume5 / 1000).toLocaleString("en-US")} 張`);
  if (technical.averageTradingValue20 == null || technical.averageTradingValue20 < config.universe.minimumAverageTradingValue20) exclusionReasons.push("20日平均成交金額低於流動性門檻");
  if (scores.fundamental == null) exclusionReasons.push("可比較財務資料不足");
  if (institutional.days < config.universe.minimumInstitutionDays) exclusionReasons.push(`法人資料不足 ${config.universe.minimumInstitutionDays} 日`);
  if (!usIndustry.length) exclusionReasons.push("美股產業代理資料不足");
  const eligible = exclusionReasons.length === 0;
  const total = eligible ? round(sum(Object.values(scores))) : null;
  const stock = {
    code: candidate.code,
    name: candidate.name,
    industryCode: candidate.industryCode,
    industryName: candidate.industryName,
    focusId: candidate.focusId,
    focusName: candidate.focusName,
    latestDate,
    latestPrice,
    scores: { ...scores, total }, technical, fundamental, institutional, usIndustry,
    eligible,
    exclusionReasons
  };
  stock.riskFlags = riskFlags(stock);
  stock.entryPlan = eligible ? entryPlanFor(stock) : null;
  stock.reasons = eligible ? recommendationReasons(stock) : [];
  stock.decision = eligible ? decisionFor(stock) : { level: "excluded", label: "資料或流動性不足", reason: exclusionReasons.join("；") };
  return stock;
});

const scored = allStocks.filter(stock => stock.eligible).sort((a, b) => b.scores.total - a.scores.total);
const excluded = allStocks.filter(stock => !stock.eligible).sort((a, b) => a.code.localeCompare(b.code));
const previousCandidates = new Map((previousOutput?.candidates ?? []).map((stock, index) => [stock.code, {
  rank: stock.currentRank ?? index + 1,
  score: stock.scores?.total ?? null
}]));
const previousTop12 = (previousOutput?.candidates ?? []).slice(0, 12);

scored.forEach((stock, index) => {
  const prior = previousCandidates.get(stock.code);
  stock.currentRank = index + 1;
  stock.previousRank = prior?.rank ?? null;
  stock.rankChange = prior ? prior.rank - stock.currentRank : null;
  stock.scoreChange = prior && Number.isFinite(prior.score) ? round(stock.scores.total - prior.score) : null;
  stock.movement = !prior ? "new" : stock.rankChange > 0 ? "up" : stock.rankChange < 0 ? "down" : "unchanged";
});

const currentByCode = new Map(allStocks.map(stock => [stock.code, stock]));
const currentTop12Codes = new Set(scored.slice(0, 12).map(stock => stock.code));
const previousTop12Codes = new Set(previousTop12.map(stock => stock.code));
const newTop12 = scored.slice(0, 12).filter(stock => !previousTop12Codes.has(stock.code)).map(stock => ({
  code: stock.code, name: stock.name, currentRank: stock.currentRank,
  previousRank: stock.previousRank, scoreChange: stock.scoreChange
}));
const droppedTop12 = previousTop12.filter(stock => !currentTop12Codes.has(stock.code)).map(stock => {
  const current = currentByCode.get(stock.code);
  const previousRank = previousCandidates.get(stock.code)?.rank ?? null;
  if (current?.eligible) return {
    code: current.code, name: current.name, previousRank, currentRank: current.currentRank,
    previousScore: stock.scores?.total ?? null, currentScore: current.scores.total,
    scoreChange: round(current.scores.total - (stock.scores?.total ?? current.scores.total)),
    reason: `排名降至第 ${current.currentRank} 名`
  };
  return {
    code: stock.code, name: current?.name ?? stock.name, previousRank, currentRank: null,
    previousScore: stock.scores?.total ?? null, currentScore: null, scoreChange: null,
    reason: current?.exclusionReasons?.join("；") || "本期不在上市有效候選池"
  };
});

const recommendations = [];
const focusCounts = new Map();
for (const stock of scored.filter(stock => stock.eligible)) {
  if ((focusCounts.get(stock.focusId) ?? 0) >= 2) continue;
  recommendations.push({ ...stock, rank: recommendations.length + 1 });
  focusCounts.set(stock.focusId, (focusCounts.get(stock.focusId) ?? 0) + 1);
  if (recommendations.length === 3) break;
}
if (recommendations.length !== 3) throw new Error(`Expected 3 recommendations, got ${recommendations.length}`);

const generatedAt = new Date().toISOString();
const output = {
  generatedAt,
  dataAsOf: latestDate,
  comparison: {
    available: Boolean(previousOutput),
    previousDataAsOf: previousOutput?.dataAsOf ?? null,
    previousGeneratedAt: previousOutput?.generatedAt ?? null,
    newTop12,
    droppedTop12
  },
  focusWindow: config.focusWindow,
  scope: "臺灣證券交易所全部上市公司普通股",
  disclaimer: "本模型為研究與風險排序工具，不保證報酬，也不構成個人化投資建議。",
  weights: config.weights,
  decisionRules: config.decisionRules,
  focuses: config.focuses,
  universeStats: {
    listedCompanies: companyRows.filter(company => /^\d{4}$/.test(company["公司代號"])).length,
    scanned: universe.length,
    validScores: scored.length,
    excluded: excluded.length,
    priceMinimum: config.universe.minimumPrice,
    averageVolume5Minimum: config.universe.minimumAverageVolume5,
    averageTradingValue20Minimum: config.universe.minimumAverageTradingValue20,
    historyDays: tradingDates.length
  },
  recommendations,
  candidates: scored,
  excluded: excluded.map(stock => ({
    code: stock.code, name: stock.name, industryName: stock.industryName,
    latestPrice: stock.latestPrice,
    previousRank: previousCandidates.get(stock.code)?.rank ?? null,
    previousScore: previousCandidates.get(stock.code)?.score ?? null,
    exclusionReasons: stock.exclusionReasons
  })),
  methodology: {
    technical: ["MA5/20/60", "RSI14", "MACD", "KD", "ATR14", "5/20/60日報酬", "量比", "OBV", "60日回撤"],
    fundamental: ["月營收年增", "累計營收年增", "毛利率", "營益率", "淨利率", "流動比", "負債比", "本益比", "股價淨值比"],
    institutional: ["外資20日", "投信20日", "自營商20日", "三大法人5日", "法人買超天數"],
    entryPlan: "以MA20／MA60趨勢支撐、ATR14波動及20日高點計算模型進場區間、突破追蹤價與失效價",
    usIndustry: "以對應美股產業龍頭20日報酬與均線趨勢作為景氣代理",
    selection: "掃描全部上市公司普通股；最近5個交易日平均成交量至少1,000張，且股價、成交金額、歷史行情、財務、法人與美股代理資料均須通過門檻，否則保留排除原因，不列入有效排名。總分排序後同一產業最多選入2檔。"
  },
  sources: {
    twseMarket: "https://openapi.twse.com.tw/",
    twseHistory: "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX",
    twseInstitutional: "https://www.twse.com.tw/rwd/zh/fund/T86",
    usMarket: "https://query1.finance.yahoo.com/v8/finance/chart/"
  }
};

writeFileSync(new URL("../data/recommendations.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
const technicalHistory = {
  generatedAt,
  dataAsOf: latestDate,
  tradingDays: tradingDates.length,
  stocks: Object.fromEntries(scored.map(stock => [stock.code, (histories.get(stock.code) ?? []).slice(-config.universe.historyTradingDays).map(row => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume
  }))])),
  institutional: Object.fromEntries(scored.map(stock => [stock.code, institutionalHistory(stock.code, institutionalDays)]))
};
writeFileSync(new URL("../data/technical-history.json", import.meta.url), `${JSON.stringify(technicalHistory)}\n`);
console.log(`Built ${recommendations.length} recommendations as of ${latestDate}: ${recommendations.map(stock => `${stock.code} ${stock.name} ${stock.scores.total}`).join(", ")}`);
