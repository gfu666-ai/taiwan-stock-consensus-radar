const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>\"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
})[character]);

let data;
let recommendations;
try {
  const [dashboardResponse, recommendationResponse] = await Promise.all([
    fetch("/data/dashboard.json", { cache: "no-store" }),
    fetch("/data/recommendations.json", { cache: "no-store" })
  ]);
  if (!dashboardResponse.ok || !recommendationResponse.ok) {
    throw new Error(`HTTP ${dashboardResponse.status}/${recommendationResponse.status}`);
  }
  [data, recommendations] = await Promise.all([dashboardResponse.json(), recommendationResponse.json()]);
} catch (error) {
  document.body.innerHTML = `<main class="load-error"><h1>資料載入失敗</h1><p>無法讀取 Dashboard 資料（${esc(error.message)}）。請重新整理，或確認 data/dashboard.json 已產生。</p></main>`;
  throw error;
}

$("updated").textContent = data.generatedAt ? `更新 ${new Date(data.generatedAt).toLocaleString("zh-TW")}` : "尚未產生資料";
$("summary").innerHTML = [
  [data.videos.length, "影片"],
  [data.videos.filter(video => video.transcript?.status === "verified").length, "有效逐字稿"],
  [data.themes.length, "共通主題"],
  [data.stocks.length, "辨識個股"],
  [recommendations.recommendations.length, "多因子推薦"]
].map(([number, label]) => `<div class="metric"><strong>${number}</strong><span>${label}</span></div>`).join("");

const scoreLabels = {
  technical: "技術", fundamental: "財務", institutional: "法人",
  usIndustry: "美股連動", industryHeat: "產業熱度"
};
const formatNumber = value => Number(value ?? 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
const formatShares = value => `${formatNumber(value / 1000)} 張`;
const stockByCode = new Map(recommendations.candidates.map(stock => [stock.code, stock]));
let technicalHistoryPromise;
let activeAnalysis = null;
let lastAnalysisTrigger = null;

function movingAverage(values, period) {
  return values.map((_, index) => index + 1 < period ? null : values.slice(index + 1 - period, index + 1).reduce((total, value) => total + value, 0) / period);
}

function chartPanel(title, subtitle, chart, className = "") {
  return `<section class="analysis-chart-card ${className}"><div class="chart-card-heading"><div><h4>${esc(title)}</h4><p>${esc(subtitle)}</p></div></div>${chart}</section>`;
}

function horizontalBarChart(items, { maximum, minimum = 0, suffix = "", valueFormatter = formatNumber } = {}) {
  const width = 760;
  const left = 116;
  const right = 72;
  const rowHeight = 46;
  const height = items.length * rowHeight + 18;
  const values = items.map(item => Number(item.value) || 0);
  const low = minimum == null ? Math.min(0, ...values) : minimum;
  const high = maximum ?? Math.max(1, ...values);
  const span = Math.max(high - low, 1);
  const x = value => left + (value - low) / span * (width - left - right);
  const zeroX = x(Math.max(low, Math.min(high, 0)));
  return `<svg class="analysis-svg interactive-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(items.map(item => `${item.label} ${valueFormatter(item.value)}${item.suffix ?? suffix}`).join("、"))}"><line class="zero-line" x1="${zeroX}" y1="4" x2="${zeroX}" y2="${height - 8}"/>${items.map((item, index) => {
    const value = Number(item.value) || 0;
    const endX = x(value);
    const barX = Math.min(zeroX, endX);
    const barWidth = Math.max(2, Math.abs(endX - zeroX));
    const y = index * rowHeight + 12;
    const display = `${valueFormatter(value)}${item.suffix ?? suffix}`;
    const tip = item.detail || `${item.label}：${display}`;
    return `<text x="${left - 12}" y="${y + 17}" text-anchor="end">${esc(item.label)}</text><rect class="chart-mark" tabindex="0" role="graphics-symbol" aria-label="${esc(tip)}" data-tip="${esc(tip)}" x="${barX}" y="${y}" width="${barWidth}" height="24" rx="3" fill="${item.color || (value >= 0 ? "#16794d" : "#e8513d")}"/><text class="bar-value" x="${value >= 0 ? endX + 7 : endX - 7}" y="${y + 17}" text-anchor="${value >= 0 ? "start" : "end"}">${esc(display)}</text>`;
  }).join("")}</svg>`;
}

function scoreChart(stock) {
  const colors = { technical: "#2878c8", fundamental: "#8f5cc2", institutional: "#16794d", usIndustry: "#e28b16", industryHeat: "#c45135" };
  return horizontalBarChart(Object.entries(scoreLabels).map(([key, label]) => ({
    label,
    value: stock.scores[key] / recommendations.weights[key] * 100,
    suffix: "%",
    color: colors[key],
    detail: `${label}：${formatNumber(stock.scores[key])} / ${recommendations.weights[key]} 分（達成率 ${formatNumber(stock.scores[key] / recommendations.weights[key] * 100)}%）`
  })), { maximum: 100, valueFormatter: value => formatNumber(value) });
}

function institutionalFlowChart(rows, key, label, color) {
  const width = 760;
  const height = 280;
  const left = 56;
  const right = 24;
  const top = 22;
  const bottom = 244;
  const values = rows.map(row => (Number(row[key]) || 0) / 1000);
  const average5 = movingAverage(values, 5);
  const dailyLimit = Math.max(1, ...values.map(Math.abs), ...average5.filter(value => value != null).map(Math.abs)) * 1.12;
  const x = index => left + index * (width - left - right) / Math.max(rows.length - 1, 1);
  const dailyY = value => (top + bottom) / 2 - value / dailyLimit * (bottom - top) / 2;
  const zeroY = dailyY(0);
  const barWidth = Math.max(5, Math.min(20, (width - left - right) / Math.max(rows.length, 1) * 0.58));
  const bars = rows.map((row, index) => {
    const value = values[index];
    const barY = Math.min(zeroY, dailyY(value));
    const barHeight = Math.max(1.5, Math.abs(dailyY(value) - zeroY));
    const tip = `${row.date}｜${label} ${value >= 0 ? "買超" : "賣超"} ${formatNumber(Math.abs(value))} 張${average5[index] == null ? "" : `｜5 日均線 ${formatNumber(average5[index])} 張`}`;
    return `<rect class="chart-mark" tabindex="0" role="graphics-symbol" aria-label="${esc(tip)}" data-tip="${esc(tip)}" x="${x(index) - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="${value >= 0 ? color : "#e8513d"}" opacity=".72"/>`;
  }).join("");
  const linePoints = average5.map((value, index) => value == null ? null : `${x(index)},${dailyY(value)}`).filter(Boolean).join(" ");
  const dateIndexes = [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
  const labels = dateIndexes.map(index => `<text x="${x(index)}" y="270" text-anchor="middle">${esc(rows[index].date.slice(5))}</text>`).join("");
  return `<svg class="analysis-svg interactive-chart flow-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`${label}最近${rows.length}日每日買賣超與5日均線`)}"><line x1="${left}" y1="${zeroY}" x2="${width - right}" y2="${zeroY}" stroke="#b9b6ae"/><text x="${left}" y="14" fill="${color}">柱：每日買賣超</text><text x="${left + 110}" y="14" fill="#2878c8">線：5 日均線</text>${bars}<polyline points="${linePoints}" fill="none" stroke="#2878c8" stroke-width="2.5"/>${average5.map((value, index) => value == null ? "" : `<circle class="chart-mark" tabindex="0" data-tip="${esc(`${rows[index].date}｜${label} 5 日均線 ${formatNumber(value)} 張`)}" cx="${x(index)}" cy="${dailyY(value)}" r="2.8" fill="#2878c8"/>`).join("")}${labels}</svg>`;
}

function dailyTechnicalIndicators(rows) {
  const closes = rows.map(row => row.close);
  const rsiValues = Array(rows.length).fill(null);
  if (closes.length > 14) {
    const changes = closes.slice(1).map((value, index) => value - closes[index]);
    let gains = changes.slice(0, 14).reduce((total, change) => total + Math.max(change, 0), 0) / 14;
    let losses = changes.slice(0, 14).reduce((total, change) => total + Math.max(-change, 0), 0) / 14;
    rsiValues[14] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
    for (let index = 14; index < changes.length; index += 1) {
      const change = changes[index];
      gains = (gains * 13 + Math.max(change, 0)) / 14;
      losses = (losses * 13 + Math.max(-change, 0)) / 14;
      rsiValues[index + 1] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
    }
  }
  const kValues = rows.map((row, index) => {
    if (index < 13) return null;
    const window = rows.slice(index - 13, index + 1);
    const lowest = Math.min(...window.map(item => item.low));
    const highest = Math.max(...window.map(item => item.high));
    return highest === lowest ? 50 : (row.close - lowest) / (highest - lowest) * 100;
  });
  const dValues = kValues.map((value, index) => {
    if (value == null || index < 15) return null;
    return kValues.slice(index - 2, index + 1).reduce((total, item) => total + item, 0) / 3;
  });
  return rows.map((row, index) => ({ date: row.date, rsi14: rsiValues[index], stochasticK: kValues[index], stochasticD: dValues[index] }));
}

function technicalMomentumChart(rows, key, label, color) {
  const points = dailyTechnicalIndicators(rows).filter(row => row[key] != null).slice(-20);
  const values = points.map(row => row[key]);
  const average5 = movingAverage(values, 5);
  const width = 760;
  const height = 280;
  const left = 50;
  const right = 24;
  const top = 28;
  const bottom = 244;
  const x = index => left + index * (width - left - right) / Math.max(points.length - 1, 1);
  const y = value => bottom - Math.max(0, Math.min(100, value)) / 100 * (bottom - top);
  const barWidth = Math.max(5, Math.min(20, (width - left - right) / Math.max(points.length, 1) * .58));
  const bars = points.map((row, index) => {
    const tip = `${row.date}｜${label} ${formatNumber(values[index])}${average5[index] == null ? "" : `｜5 日均線 ${formatNumber(average5[index])}`}`;
    return `<rect class="chart-mark" tabindex="0" role="graphics-symbol" aria-label="${esc(tip)}" data-tip="${esc(tip)}" x="${x(index) - barWidth / 2}" y="${y(values[index])}" width="${barWidth}" height="${bottom - y(values[index])}" fill="${color}" opacity=".72"/>`;
  }).join("");
  const linePoints = average5.map((value, index) => value == null ? null : `${x(index)},${y(value)}`).filter(Boolean).join(" ");
  const dateIndexes = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const dateLabels = dateIndexes.map(index => `<text x="${x(index)}" y="270" text-anchor="middle">${esc(points[index].date.slice(5))}</text>`).join("");
  return `<svg class="analysis-svg interactive-chart momentum-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`${label}最近20日每日柱狀與5日均線`)}"><line x1="${left}" y1="${y(80)}" x2="${width - right}" y2="${y(80)}" stroke="#e8513d55" stroke-dasharray="4 4"/><line x1="${left}" y1="${y(20)}" x2="${width - right}" y2="${y(20)}" stroke="#16794d55" stroke-dasharray="4 4"/><text x="${left}" y="14" fill="${color}">柱：每日 ${esc(label)}</text><text x="${left + 105}" y="14" fill="#2878c8">線：5 日均線</text>${bars}<polyline points="${linePoints}" fill="none" stroke="#2878c8" stroke-width="2.5"/>${dateLabels}</svg>`;
}

function kdChart(rows) {
  const points = dailyTechnicalIndicators(rows).filter(row => row.stochasticK != null && row.stochasticD != null).slice(-20);
  const width = 760;
  const height = 280;
  const left = 50;
  const right = 24;
  const top = 28;
  const bottom = 244;
  const x = index => left + index * (width - left - right) / Math.max(points.length - 1, 1);
  const y = value => bottom - Math.max(0, Math.min(100, value)) / 100 * (bottom - top);
  const barWidth = Math.max(5, Math.min(20, (width - left - right) / Math.max(points.length, 1) * .58));
  const bars = points.map((point, index) => {
    const tip = `${point.date}｜K ${formatNumber(point.stochasticK)}｜D ${formatNumber(point.stochasticD)}`;
    return `<rect class="chart-mark" tabindex="0" role="graphics-symbol" aria-label="${esc(tip)}" data-tip="${esc(tip)}" x="${x(index) - barWidth / 2}" y="${y(point.stochasticK)}" width="${barWidth}" height="${bottom - y(point.stochasticK)}" fill="#2878c8" opacity=".28"/>`;
  }).join("");
  const line = (key, color) => `<polyline points="${points.map((point, index) => `${x(index)},${y(point[key])}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
  const dateIndexes = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const dateLabels = dateIndexes.map(index => `<text x="${x(index)}" y="270" text-anchor="middle">${esc(points[index].date.slice(5))}</text>`).join("");
  return `<svg class="analysis-svg interactive-chart kd-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="KD最近20日K值柱狀、K線與D線"><line x1="${left}" y1="${y(80)}" x2="${width - right}" y2="${y(80)}" stroke="#e8513d55" stroke-dasharray="4 4"/><line x1="${left}" y1="${y(20)}" x2="${width - right}" y2="${y(20)}" stroke="#16794d55" stroke-dasharray="4 4"/><text x="${left}" y="14" fill="#2878c8">柱／線：K</text><text x="${left + 80}" y="14" fill="#8f5cc2">線：D</text>${bars}${line("stochasticK", "#2878c8")}${line("stochasticD", "#8f5cc2")}${dateLabels}</svg>`;
}

function emaValues(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  return values.reduce((series, value, index) => {
    series.push(index === 0 ? value : value * multiplier + series[index - 1] * (1 - multiplier));
    return series;
  }, []);
}

function macdChart(rows) {
  const closes = rows.map(row => row.close);
  const ema12 = emaValues(closes, 12);
  const ema26 = emaValues(closes, 26);
  const dif = ema12.map((value, index) => value - ema26[index]);
  const signal = emaValues(dif, 9);
  const points = rows.map((row, index) => ({ date: row.date, dif: dif[index], signal: signal[index], histogram: dif[index] - signal[index] })).slice(-20);
  const width = 760;
  const height = 280;
  const left = 50;
  const right = 24;
  const top = 28;
  const bottom = 244;
  const limit = Math.max(0.01, ...points.flatMap(point => [Math.abs(point.dif), Math.abs(point.signal), Math.abs(point.histogram)])) * 1.12;
  const x = index => left + index * (width - left - right) / Math.max(points.length - 1, 1);
  const y = value => (top + bottom) / 2 - value / limit * (bottom - top) / 2;
  const zeroY = y(0);
  const barWidth = Math.max(5, Math.min(20, (width - left - right) / Math.max(points.length, 1) * .58));
  const bars = points.map((point, index) => {
    const barY = Math.min(zeroY, y(point.histogram));
    const tip = `${point.date}｜MACD柱 ${formatNumber(point.histogram)}｜DIF ${formatNumber(point.dif)}｜Signal ${formatNumber(point.signal)}`;
    return `<rect class="chart-mark" tabindex="0" role="graphics-symbol" aria-label="${esc(tip)}" data-tip="${esc(tip)}" x="${x(index) - barWidth / 2}" y="${barY}" width="${barWidth}" height="${Math.max(1.5, Math.abs(y(point.histogram) - zeroY))}" fill="${point.histogram >= 0 ? "#e8513d" : "#16794d"}" opacity=".72"/>`;
  }).join("");
  const line = (key, color) => `<polyline points="${points.map((point, index) => `${x(index)},${y(point[key])}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
  const dateIndexes = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const dateLabels = dateIndexes.map(index => `<text x="${x(index)}" y="270" text-anchor="middle">${esc(points[index].date.slice(5))}</text>`).join("");
  return `<svg class="analysis-svg interactive-chart macd-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="MACD最近20日柱狀、DIF與Signal線"><line x1="${left}" y1="${zeroY}" x2="${width - right}" y2="${zeroY}" stroke="#b9b6ae"/><text x="${left}" y="14" fill="#667078">柱：MACD</text><text x="${left + 75}" y="14" fill="#e28b16">線：DIF</text><text x="${left + 130}" y="14" fill="#2878c8">線：Signal</text>${bars}${line("dif", "#e28b16")}${line("signal", "#2878c8")}${dateLabels}</svg>`;
}

function technicalChart(rows, visibleCount = 40, overlays = new Set(["ma5", "ma20"])) {
  visibleCount = Math.min(visibleCount, rows.length);
  const startIndex = rows.length - visibleCount;
  const visible = rows.slice(startIndex);
  const closes = rows.map(row => row.close);
  const ma5 = movingAverage(closes, 5).slice(startIndex);
  const ma20 = movingAverage(closes, 20).slice(startIndex);
  const ma60 = movingAverage(closes, 60).slice(startIndex);
  const width = 900;
  const left = 54;
  const right = 18;
  const priceTop = 20;
  const priceBottom = 242;
  const volumeTop = 278;
  const volumeBottom = 348;
  const x = index => left + index * (width - left - right) / Math.max(visible.length - 1, 1);
  const prices = visible.flatMap(row => [row.low, row.high]).concat(ma5.filter(value => value != null), ma20.filter(value => value != null));
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const padding = Math.max((maximum - minimum) * 0.08, maximum * 0.005);
  const low = minimum - padding;
  const high = maximum + padding;
  const y = value => priceBottom - (value - low) / Math.max(high - low, 1) * (priceBottom - priceTop);
  const maxVolume = Math.max(...visible.map(row => row.volume), 1);
  const candleWidth = Math.max(3, Math.min(12, (width - left - right) / visible.length * 0.58));
  const candles = visible.map((row, index) => {
    const color = row.close >= row.open ? "#e8513d" : "#16794d";
    const bodyTop = Math.min(y(row.open), y(row.close));
    const bodyHeight = Math.max(1.5, Math.abs(y(row.open) - y(row.close)));
    const tip = `${row.date}｜開 ${formatNumber(row.open)}・高 ${formatNumber(row.high)}・低 ${formatNumber(row.low)}・收 ${formatNumber(row.close)}｜成交量 ${formatShares(row.volume)}`;
    return `<g class="chart-mark candle-mark" tabindex="0" role="graphics-symbol" aria-label="${esc(tip)}" data-tip="${esc(tip)}"><line x1="${x(index)}" y1="${y(row.high)}" x2="${x(index)}" y2="${y(row.low)}" stroke="${color}"/><rect x="${x(index) - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${color}"/><rect x="${x(index) - candleWidth / 2}" y="${volumeBottom - row.volume / maxVolume * (volumeBottom - volumeTop)}" width="${candleWidth}" height="${row.volume / maxVolume * (volumeBottom - volumeTop)}" fill="${color}" opacity=".42"/></g>`;
  }).join("");
  const line = (values, color) => `<polyline points="${values.map((value, index) => value == null ? null : `${x(index)},${y(value)}`).filter(Boolean).join(" ")}" fill="none" stroke="${color}" stroke-width="2"/>`;
  const dateLabels = [0, Math.floor((visible.length - 1) / 2), visible.length - 1].map(index => `<text x="${x(index)}" y="365" text-anchor="middle">${esc(visible[index].date.slice(5))}</text>`).join("");
  const lines = [overlays.has("ma5") ? line(ma5, "#f39c12") : "", overlays.has("ma20") ? line(ma20, "#2878c8") : "", overlays.has("ma60") ? line(ma60, "#8f5cc2") : ""].join("");
  return `<svg class="technical-svg interactive-chart" viewBox="0 0 900 375" role="img" aria-label="近${visibleCount}日K線、均線與成交量"><line x1="${left}" y1="${priceBottom}" x2="${width - right}" y2="${priceBottom}" stroke="#d2d0c9"/><line x1="${left}" y1="${volumeBottom}" x2="${width - right}" y2="${volumeBottom}" stroke="#d2d0c9"/><text x="${left - 8}" y="${y(high) + 5}" text-anchor="end">${formatNumber(high)}</text><text x="${left - 8}" y="${y(low) + 5}" text-anchor="end">${formatNumber(low)}</text>${candles}${lines}${dateLabels}<g class="chart-legend"><text x="${left}" y="14" fill="#f39c12">MA5</text><text x="${left + 48}" y="14" fill="#2878c8">MA20</text><text x="${left + 104}" y="14" fill="#8f5cc2">MA60</text><text x="${left + 164}" y="14" fill="#667078">紅漲／綠跌</text><text x="${left}" y="272" fill="#667078">成交量</text></g></svg>`;
}

function renderAnalysis(stock, rows, institutionalRows = []) {
  const weekAverageVolume = rows.slice(-5).reduce((total, row) => total + row.volume, 0) / Math.min(rows.length, 5);
  const rangeButtons = [20, 40, 60, 80].filter(days => days <= rows.length).map(days => `<button type="button" data-chart-range="${days}" class="${activeAnalysis.range === days ? "active" : ""}">${days} 日</button>`).join("");
  const overlayButtons = [["ma5", "MA5"], ["ma20", "MA20"], ["ma60", "MA60"]].map(([key, label]) => `<button type="button" data-ma-toggle="${key}" class="${activeAnalysis.overlays.has(key) ? "active" : ""}" aria-pressed="${activeAnalysis.overlays.has(key)}">${label}</button>`).join("");
  const momentumOptions = { rsi14: ["RSI14", "#e28b16"], kd: ["KD", "#2878c8"], macd: ["MACD", "#667078"] };
  const momentumButtons = Object.entries(momentumOptions).map(([key, [label]]) => `<button type="button" data-momentum-key="${key}" class="${activeAnalysis.momentumKey === key ? "active" : ""}">${label}</button>`).join("");
  const flowOptions = { total: ["三大法人", "#2878c8"], foreign: ["外資", "#16794d"], trust: ["投信", "#8f5cc2"], dealer: ["自營商", "#e28b16"] };
  const flowButtons = Object.entries(flowOptions).map(([key, [label]]) => `<button type="button" data-flow-key="${key}" class="${activeAnalysis.flowKey === key ? "active" : ""}">${label}</button>`).join("");
  const returns = [
    { label: "5 日報酬", value: stock.technical.return5d, suffix: "%" },
    { label: "20 日報酬", value: stock.technical.return20d, suffix: "%" },
    { label: "60 日報酬", value: stock.technical.return60d, suffix: "%" },
    { label: "60 日回撤", value: stock.technical.drawdown60d, suffix: "%" }
  ];
  const returnLimit = Math.max(10, ...returns.map(item => Math.abs(item.value))) * 1.12;
  const fundamentalGrowth = [
    { label: "月營收年增", value: stock.fundamental.revenueYoY, suffix: "%" },
    { label: "累計營收年增", value: stock.fundamental.revenueCumulativeYoY, suffix: "%" },
    { label: "毛利率", value: stock.fundamental.grossMargin, suffix: "%", color: "#8f5cc2" },
    { label: "營益率", value: stock.fundamental.operatingMargin, suffix: "%", color: "#8f5cc2" },
    { label: "淨利率", value: stock.fundamental.netMargin, suffix: "%", color: "#8f5cc2" },
    { label: "ROE", value: stock.fundamental.roe, suffix: "%", color: "#2878c8" }
  ];
  const fundamentalLimit = Math.max(20, ...fundamentalGrowth.map(item => Math.abs(item.value))) * 1.12;
  const foreign5 = institutionalRows.slice(-5).reduce((total, row) => total + (row.foreign || 0), 0);
  const trust5 = institutionalRows.slice(-5).reduce((total, row) => total + (row.trust || 0), 0);
  const usLeaders = stock.usIndustry.map(item => ({ label: item.symbol, value: item.return20d, suffix: "%", color: item.return20d >= 0 ? "#2878c8" : "#e8513d", detail: `${item.symbol}：20 日報酬 ${formatNumber(item.return20d)}%，連動分數 ${formatNumber(item.score)} / 10` }));
  const usLimit = Math.max(5, ...usLeaders.map(item => Math.abs(item.value))) * 1.12;
  $("analysisBody").innerHTML = `<div class="analysis-summary"><div><span>總分</span><strong>${formatNumber(stock.scores.total)} / 100</strong><small>${esc(stock.decision.label)}</small></div><div><span>最近收盤</span><strong>${formatNumber(stock.latestPrice)} 元</strong><small>${esc(stock.latestDate)}</small></div><div><span>最近一週平均成交量</span><strong>${formatShares(weekAverageVolume)}／日</strong><small>${formatNumber(weekAverageVolume)} 股／日</small></div><div><span>產業焦點</span><strong>${formatNumber(stock.scores.industryHeat)} / 5</strong><small>${esc(stock.focusName)}</small></div></div>
  <div class="analysis-dashboard">
    ${chartPanel("五大因子評分", "滑過長條可查看得分、滿分與達成率", scoreChart(stock), "wide-chart")}
    <section class="analysis-chart-card wide-chart"><div class="chart-card-heading"><div><h4>價格、均線與成交量</h4><p>滑過 K 棒查看每日 OHLCV；可切換期間與均線</p></div><div class="chart-controls"><span>${rangeButtons}</span><span>${overlayButtons}</span></div></div><div class="technical-chart">${technicalChart(rows, activeAnalysis.range, activeAnalysis.overlays)}</div></section>
    ${chartPanel("區間報酬與風險", "正值為上漲，負值為下跌或回撤", horizontalBarChart(returns, { minimum: -returnLimit, maximum: returnLimit }), "")}
    <section class="analysis-chart-card"><div class="chart-card-heading"><div><h4>技術動能</h4><p>最近 20 日技術指標，可切換 RSI／KD／MACD</p></div><div class="chart-controls"><span>${momentumButtons}</span></div></div>${activeAnalysis.momentumKey === "macd" ? macdChart(rows) : activeAnalysis.momentumKey === "kd" ? kdChart(rows) : technicalMomentumChart(rows, activeAnalysis.momentumKey, ...momentumOptions[activeAnalysis.momentumKey])}</section>
    ${chartPanel("財務成長與獲利", `財報期 ${stock.fundamental.fiscalPeriod || "未提供"}；各指標單位為百分比`, horizontalBarChart(fundamentalGrowth, { minimum: -fundamentalLimit, maximum: fundamentalLimit }), "wide-chart")}
    ${chartPanel("估值與財務安全", "數值尺度不同，採各指標獨立刻度顯示", `<div class="gauge-grid">${[
      ["EPS", stock.fundamental.eps, "元", 20], ["本益比", stock.fundamental.pe, "倍", 60], ["股價淨值比", stock.fundamental.pb, "倍", 10], ["殖利率", stock.fundamental.dividendYield, "%", 10], ["流動比", stock.fundamental.currentRatio, "倍", 5], ["負債比", stock.fundamental.debtRatio, "%", 100]
    ].map(([label, value, unit, max]) => `<div class="mini-gauge chart-mark" tabindex="0" data-tip="${esc(`${label}：${formatNumber(value)} ${unit}`)}"><span>${esc(label)}</span><div><i style="--gauge:${Math.max(0, Math.min(100, Number(value || 0) / max * 100))}%"></i></div><strong>${formatNumber(value)} ${unit}</strong></div>`).join("")}</div>`, "wide-chart")}
    ${institutionalRows.length ? `<section class="analysis-chart-card"><div class="chart-card-heading"><div><h4>三大法人買賣超</h4><p>最近 20 日每日柱狀與 5 日均線，可切換法人別</p></div><div class="chart-controls"><span>${flowButtons}</span></div></div>${institutionalFlowChart(institutionalRows, activeAnalysis.flowKey, ...flowOptions[activeAnalysis.flowKey])}</section>` : ""}
    ${chartPanel("美國產業龍頭連動", "比較對應美股近 20 日報酬，滑過可查看連動分數", horizontalBarChart(usLeaders, { minimum: -usLimit, maximum: usLimit }), "")}
    ${institutionalRows.length ? chartPanel("外資買賣超趨勢", `最近 5 日合計 ${formatShares(foreign5)}；每日柱狀與 5 日均線`, institutionalFlowChart(institutionalRows, "foreign", "外資", "#16794d"), "") : ""}
    ${institutionalRows.length ? chartPanel("投信買賣超趨勢", `最近 5 日合計 ${formatShares(trust5)}；每日柱狀與 5 日均線`, institutionalFlowChart(institutionalRows, "trust", "投信", "#8f5cc2"), "") : ""}
  </div><div class="chart-tooltip" role="status" aria-live="polite"></div><p class="chart-note">所有圖表均使用本次全市場評分資料動態產生；最近一週以最近 5 個交易日計算。圖表供研究比較，不代表未來報酬。</p>`;
}

async function openStockAnalysis(code) {
  const stock = stockByCode.get(code);
  if (!stock) return;
  const panel = $("stockAnalysisPanel");
  panel.hidden = false;
  $("analysisTitle").textContent = `${stock.code} ${stock.name} 多因子圖表分析`;
  $("analysisBody").innerHTML = `<div class="analysis-loading" role="status"><span aria-hidden="true"></span><p>正在載入日 K 與法人資料…</p></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  requestAnimationFrame(() => panel.focus({ preventScroll: true }));
  try {
    technicalHistoryPromise ??= fetch("/data/technical-history.json", { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    const history = await technicalHistoryPromise;
    const rows = history.stocks[code];
    const institutionalRows = history.institutional?.[code] ?? [];
    if (!rows?.length) throw new Error("此股票沒有足夠的技術資料");
    activeAnalysis = { code, stock, rows, institutionalRows, range: 40, overlays: new Set(["ma5", "ma20"]), momentumKey: "rsi14", flowKey: "total" };
    renderAnalysis(stock, rows, institutionalRows);
  } catch (error) {
    $("analysisBody").innerHTML = `<p class="analysis-error">技術資料載入失敗：${esc(error.message)}</p>`;
  }
}

$("recommendationMeta").innerHTML = `資料日 <strong>${esc(recommendations.dataAsOf)}</strong> · 全市場掃描 <strong>${formatNumber(recommendations.universeStats.scanned)}</strong> 檔 · 有效評分 <strong>${formatNumber(recommendations.universeStats.validScores)}</strong> 檔 · 排除 <strong>${formatNumber(recommendations.universeStats.excluded)}</strong> 檔<br><span>流動性門檻：最近5個交易日日均量至少 ${formatShares(recommendations.universeStats.averageVolume5Minimum)}／日。買進門檻：總分至少 ${formatNumber(recommendations.decisionRules.buyMinScore)} 分且無重大風險旗標。${esc(recommendations.disclaimer)}</span>`;
$("recommendationCards").innerHTML = recommendations.recommendations.map(stock => {
  const scoreRows = Object.entries(scoreLabels).map(([key, label]) => `<div><span>${label}</span><strong>${formatNumber(stock.scores[key])}<small> / ${recommendations.weights[key]}</small></strong></div>`).join("");
  const risks = stock.riskFlags.length ? stock.riskFlags.map(risk => `<li>${esc(risk)}</li>`).join("") : "<li>模型未偵測到預設高風險旗標；仍須自行設定停損與部位上限。</li>";
  return `<article class="recommendation-card"><div class="recommendation-rank">#${stock.rank}</div><p class="eyebrow">${esc(stock.focusName)}</p><div class="recommendation-title"><div><span>${esc(stock.code)}</span><h3>${esc(stock.name)}</h3></div><div class="total-score"><strong>${formatNumber(stock.scores.total)}</strong><span>/ 100</span></div></div><button class="analysis-trigger" type="button" data-analysis-code="${esc(stock.code)}" aria-label="查看 ${esc(stock.code)} ${esc(stock.name)} 完整動態分析圖">查看完整動態分析圖</button><div class="decision-badge decision-${esc(stock.decision.level)}"><strong>${esc(stock.decision.label)}</strong><span>${esc(stock.decision.reason)}</span></div><p class="latest-price">最近交易日 ${esc(stock.latestDate)} · 收盤 ${formatNumber(stock.latestPrice)} 元</p><div class="score-breakdown">${scoreRows}</div><h4>推薦依據</h4><ul>${stock.reasons.map(reason => `<li>${esc(reason)}</li>`).join("")}</ul><h4>風險與反證</h4><ul class="risk-list">${risks}</ul></article>`;
}).join("");

$("modelWeights").innerHTML = Object.entries(scoreLabels).map(([key, label]) => `<div class="weight-row"><span>${label}</span><div><i style="width:${recommendations.weights[key]}%"></i></div><strong>${recommendations.weights[key]}%</strong></div>`).join("");
$("decisionLegend").innerHTML = `<strong>買進判定：</strong><span class="decision-buy">≥ ${formatNumber(recommendations.decisionRules.buyMinScore)} 分且無重大風險：${esc(recommendations.decisionRules.buyLabel)}</span><span class="decision-watch">${formatNumber(recommendations.decisionRules.watchMinScore)}–${formatNumber(recommendations.decisionRules.buyMinScore - 0.01)} 分：${esc(recommendations.decisionRules.watchLabel)}</span><span class="decision-avoid">&lt; ${formatNumber(recommendations.decisionRules.watchMinScore)} 分：${esc(recommendations.decisionRules.avoidLabel)}</span>`;
$("focusCards").innerHTML = recommendations.focuses.map(focus => `<article><p class="eyebrow">熱度 ${focus.heatScore} / 5</p><h3>${esc(focus.name)}</h3><p>${esc(focus.reason)}</p><small>美股代理：${esc(focus.usLeaders.join("、"))}</small><div>${focus.sources.map((source, index) => `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">產業來源 ${index + 1}</a>`).join(" · ")}</div></article>`).join("");

$("candidateRanking").innerHTML = recommendations.candidates.slice(0, 12).map((stock, index) => `<tr><td>${index + 1}</td><td><button class="stock-link" type="button" data-analysis-code="${esc(stock.code)}" aria-label="查看 ${esc(stock.code)} ${esc(stock.name)} 完整分析"><strong>${esc(stock.code)} ${esc(stock.name)}</strong></button><small>${esc(stock.focusName)}</small></td><td><strong>${formatNumber(stock.latestPrice)} 元</strong><small>${esc(stock.latestDate)}</small></td><td>${formatNumber(stock.scores.total)}</td><td><span class="table-decision decision-${esc(stock.decision.level)}">${esc(stock.decision.label)}</span></td><td>${formatNumber(stock.scores.technical)}</td><td>${formatNumber(stock.scores.fundamental)}</td><td>${formatNumber(stock.scores.institutional)}</td><td>${formatNumber(stock.technical.return20d)}%</td><td>${formatShares(stock.institutional.total20)}</td></tr>`).join("");

document.addEventListener("click", event => {
  const trigger = event.target.closest?.("[data-analysis-code]");
  if (trigger) {
    lastAnalysisTrigger = trigger;
    openStockAnalysis(trigger.dataset.analysisCode);
    return;
  }
  const range = event.target.closest?.("[data-chart-range]");
  if (range && activeAnalysis) {
    activeAnalysis.range = Number(range.dataset.chartRange);
    renderAnalysis(activeAnalysis.stock, activeAnalysis.rows, activeAnalysis.institutionalRows);
    return;
  }
  const overlay = event.target.closest?.("[data-ma-toggle]");
  if (overlay && activeAnalysis) {
    const key = overlay.dataset.maToggle;
    activeAnalysis.overlays.has(key) ? activeAnalysis.overlays.delete(key) : activeAnalysis.overlays.add(key);
    renderAnalysis(activeAnalysis.stock, activeAnalysis.rows, activeAnalysis.institutionalRows);
    return;
  }
  const momentum = event.target.closest?.("[data-momentum-key]");
  if (momentum && activeAnalysis) {
    activeAnalysis.momentumKey = momentum.dataset.momentumKey;
    renderAnalysis(activeAnalysis.stock, activeAnalysis.rows, activeAnalysis.institutionalRows);
    return;
  }
  const flow = event.target.closest?.("[data-flow-key]");
  if (flow && activeAnalysis) {
    activeAnalysis.flowKey = flow.dataset.flowKey;
    renderAnalysis(activeAnalysis.stock, activeAnalysis.rows, activeAnalysis.institutionalRows);
  }
});

const analysisPanel = $("stockAnalysisPanel");
function showChartTooltip(target, event) {
  const tooltip = analysisPanel.querySelector(".chart-tooltip");
  if (!tooltip || !target?.dataset.tip) return;
  tooltip.textContent = target.dataset.tip;
  tooltip.classList.add("visible");
  if (event?.clientX != null) {
    const panelRect = analysisPanel.getBoundingClientRect();
    tooltip.style.left = `${Math.min(panelRect.width - 240, Math.max(12, event.clientX - panelRect.left + 14))}px`;
    tooltip.style.top = `${Math.max(12, event.clientY - panelRect.top - 48)}px`;
  }
}
analysisPanel.addEventListener("pointermove", event => showChartTooltip(event.target.closest?.("[data-tip]"), event));
analysisPanel.addEventListener("pointerleave", () => analysisPanel.querySelector(".chart-tooltip")?.classList.remove("visible"));
analysisPanel.addEventListener("focusin", event => showChartTooltip(event.target.closest?.("[data-tip]")));
analysisPanel.addEventListener("focusout", () => analysisPanel.querySelector(".chart-tooltip")?.classList.remove("visible"));
function closeStockAnalysis() {
  $("stockAnalysisPanel").hidden = true;
  lastAnalysisTrigger?.focus();
}
$("closeAnalysis").addEventListener("click", closeStockAnalysis);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("stockAnalysisPanel").hidden) closeStockAnalysis();
});

const backToTop = $("backToTop");
window.addEventListener("scroll", () => {
  backToTop.hidden = window.scrollY < 640;
}, { passive: true });
backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

const navigationLinks = [...document.querySelectorAll(".nav-links a")];
const observedSections = navigationLinks.map(link => document.querySelector(link.getAttribute("href"))).filter(Boolean);
if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    navigationLinks.forEach(link => link.toggleAttribute("aria-current", link.getAttribute("href") === `#${visible.target.id}`));
  }, { rootMargin: "-20% 0px -65%", threshold: [0, .2, .5] });
  observedSections.forEach(section => sectionObserver.observe(section));
}

const maxMentions = Math.max(1, ...data.stocks.map(stock => stock.videoCount));
$("stocks").innerHTML = data.stocks.map(stock => `<div class="stock-row"><span class="ticker">${esc(stock.ticker || "未確認")}</span><div><strong>${esc(stock.name)}</strong><div class="bar"><span style="width:${stock.videoCount / maxMentions * 100}%"></span></div><small>${stock.videoCount} 支影片提及 · ${stock.mentionCount} 次文字命中</small></div></div>`).join("") || `<p>尚無通過證據檢驗的個股。</p>`;
