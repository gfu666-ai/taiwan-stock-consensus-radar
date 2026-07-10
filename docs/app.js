const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>\"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
})[character]);

let data;
let recommendations;
try {
  const [dashboardResponse, recommendationResponse] = await Promise.all([
    fetch("./data/dashboard.json"),
    fetch("./data/recommendations.json")
  ]);
  if (!dashboardResponse.ok || !recommendationResponse.ok) {
    throw new Error(`HTTP ${dashboardResponse.status}/${recommendationResponse.status}`);
  }
  [data, recommendations] = await Promise.all([dashboardResponse.json(), recommendationResponse.json()]);
} catch (error) {
  document.body.innerHTML = `<main class="load-error"><h1>資料載入失敗</h1><p>無法讀取 Dashboard 資料（${esc(error.message)}）。請重新整理，或確認 data/dashboard.json 已產生。</p></main>`;
  throw error;
}

const videosById = new Map(data.videos.map(video => [video.id, video]));
const statusLabels = { verified: "字幕已驗證", unavailable: "字幕不可取得", failed: "字幕過短", missing: "尚無字幕" };
const formatTimestamp = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const videoUrlAt = (url, seconds) => {
  const target = new URL(url);
  target.searchParams.set("t", `${Math.floor(seconds)}s`);
  return target.toString();
};

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

$("recommendationMeta").innerHTML = `資料日 <strong>${esc(recommendations.dataAsOf)}</strong> · 全市場掃描 <strong>${formatNumber(recommendations.universeStats.scanned)}</strong> 檔 · 有效評分 <strong>${formatNumber(recommendations.universeStats.validScores)}</strong> 檔 · 排除 <strong>${formatNumber(recommendations.universeStats.excluded)}</strong> 檔<br><span>買進門檻：總分至少 ${formatNumber(recommendations.decisionRules.buyMinScore)} 分且無重大風險旗標。${esc(recommendations.disclaimer)}</span>`;
$("recommendationCards").innerHTML = recommendations.recommendations.map(stock => {
  const scoreRows = Object.entries(scoreLabels).map(([key, label]) => `<div><span>${label}</span><strong>${formatNumber(stock.scores[key])}<small> / ${recommendations.weights[key]}</small></strong></div>`).join("");
  const risks = stock.riskFlags.length ? stock.riskFlags.map(risk => `<li>${esc(risk)}</li>`).join("") : "<li>模型未偵測到預設高風險旗標；仍須自行設定停損與部位上限。</li>";
  return `<article class="recommendation-card"><div class="recommendation-rank">#${stock.rank}</div><p class="eyebrow">${esc(stock.focusName)}</p><div class="recommendation-title"><div><span>${esc(stock.code)}</span><h3>${esc(stock.name)}</h3></div><div class="total-score"><strong>${formatNumber(stock.scores.total)}</strong><span>/ 100</span></div></div><div class="decision-badge decision-${esc(stock.decision.level)}"><strong>${esc(stock.decision.label)}</strong><span>${esc(stock.decision.reason)}</span></div><p class="latest-price">最近交易日 ${esc(stock.latestDate)} · 收盤 ${formatNumber(stock.latestPrice)} 元</p><div class="score-breakdown">${scoreRows}</div><h4>推薦依據</h4><ul>${stock.reasons.map(reason => `<li>${esc(reason)}</li>`).join("")}</ul><h4>風險與反證</h4><ul class="risk-list">${risks}</ul></article>`;
}).join("");

$("modelWeights").innerHTML = Object.entries(scoreLabels).map(([key, label]) => `<div class="weight-row"><span>${label}</span><div><i style="width:${recommendations.weights[key]}%"></i></div><strong>${recommendations.weights[key]}%</strong></div>`).join("");
$("decisionLegend").innerHTML = `<strong>買進判定：</strong><span class="decision-buy">≥ ${formatNumber(recommendations.decisionRules.buyMinScore)} 分且無重大風險：${esc(recommendations.decisionRules.buyLabel)}</span><span class="decision-watch">${formatNumber(recommendations.decisionRules.watchMinScore)}–${formatNumber(recommendations.decisionRules.buyMinScore - 0.01)} 分：${esc(recommendations.decisionRules.watchLabel)}</span><span class="decision-avoid">&lt; ${formatNumber(recommendations.decisionRules.watchMinScore)} 分：${esc(recommendations.decisionRules.avoidLabel)}</span>`;
$("focusCards").innerHTML = recommendations.focuses.map(focus => `<article><p class="eyebrow">熱度 ${focus.heatScore} / 5</p><h3>${esc(focus.name)}</h3><p>${esc(focus.reason)}</p><small>美股代理：${esc(focus.usLeaders.join("、"))}</small><div>${focus.sources.map((source, index) => `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">產業來源 ${index + 1}</a>`).join(" · ")}</div></article>`).join("");

$("candidateRanking").innerHTML = recommendations.candidates.slice(0, 12).map((stock, index) => `<tr><td>${index + 1}</td><td><strong>${esc(stock.code)} ${esc(stock.name)}</strong><small>${esc(stock.focusName)}</small></td><td><strong>${formatNumber(stock.latestPrice)} 元</strong><small>${esc(stock.latestDate)}</small></td><td>${formatNumber(stock.scores.total)}</td><td><span class="table-decision decision-${esc(stock.decision.level)}">${esc(stock.decision.label)}</span></td><td>${formatNumber(stock.scores.technical)}</td><td>${formatNumber(stock.scores.fundamental)}</td><td>${formatNumber(stock.scores.institutional)}</td><td>${formatNumber(stock.technical.return20d)}%</td><td>${formatShares(stock.institutional.total20)}</td></tr>`).join("");

const valid = data.validation.passed;
$("validationBadge").className = `badge ${valid ? "pass" : "fail"}`;
$("validationBadge").textContent = valid ? "驗證通過" : "驗證未通過";
$("checks").innerHTML = data.validation.checks.map(check => `<article class="check ${check.passed ? "pass" : "fail"}"><strong>${check.passed ? "通過" : "未通過"} · ${esc(check.name)}</strong><small>${esc(check.detail)}</small></article>`).join("") || `<article class="check fail"><strong>尚無檢驗結果</strong></article>`;
$("warnings").innerHTML = data.validation.warnings?.length ? `<div class="warnings">${data.validation.warnings.map(esc).join("<br>")}</div>` : "";

$("themes").innerHTML = data.themes.map(theme => {
  const evidence = theme.evidence.map(item => {
    const video = videosById.get(item.videoId);
    if (!video) return "";
    return `<li><a href="${esc(videoUrlAt(video.url, item.timestampSec))}" target="_blank" rel="noopener noreferrer">${esc(video.channel)} · ${esc(formatTimestamp(item.timestampSec))}</a><span>${esc(item.matchedTerms?.join("、") || "關鍵字命中")}</span><p>${esc(item.quote)}</p></li>`;
  }).join("");
  return `<article class="theme"><span class="count">${theme.videoCount}</span><strong>${esc(theme.name)}</strong><p>${esc(theme.summary)}</p><small>判定條件：${esc(theme.criteria?.join(" + ") || "關鍵字命中")}</small><details><summary>查看 ${theme.videoCount} 支影片證據</summary><ul class="evidence-list">${evidence}</ul></details></article>`;
}).join("") || `<p>尚無跨影片主題。</p>`;

const maxMentions = Math.max(1, ...data.stocks.map(stock => stock.videoCount));
$("stocks").innerHTML = data.stocks.map(stock => `<div class="stock-row"><span class="ticker">${esc(stock.ticker || "未確認")}</span><div><strong>${esc(stock.name)}</strong><div class="bar"><span style="width:${stock.videoCount / maxMentions * 100}%"></span></div><small>${stock.videoCount} 支影片提及 · ${stock.mentionCount} 次文字命中</small></div><button data-stock="${esc(stock.name)}">查看證據</button></div>`).join("") || `<p>尚無通過證據檢驗的個股。</p>`;

const statuses = ["全部", ...new Set(data.videos.map(video => video.transcript?.status || "missing"))];
$("filters").innerHTML = statuses.map((status, index) => `<button class="${index === 0 ? "active" : ""}" data-filter="${status}">${status === "全部" ? status : statusLabels[status] || status}</button>`).join("");

function renderVideos(filter = "全部", stock = "") {
  const rows = data.videos.filter(video =>
    (filter === "全部" || video.transcript?.status === filter) &&
    (!stock || video.stocks?.some(item => item.name === stock))
  );
  $("videoContext").innerHTML = stock ? `目前顯示：<strong>${esc(stock)}</strong> 的原文證據 <button id="clearStock" type="button">清除個股篩選</button>` : "";
  $("videos").innerHTML = rows.map(video => {
    const transcriptStatus = video.transcript?.status || "missing";
    const evidence = (video.evidence || []).map(item => `<p class="quote"><a href="${esc(videoUrlAt(video.url, item.timestampSec))}" target="_blank" rel="noopener noreferrer">${esc(item.stock)} · ${esc(formatTimestamp(item.timestampSec))}</a> ${esc(item.quote)}</p>`).join("");
    return `<article class="video"><span class="video-meta">${esc(video.channel)} · ${esc(video.publishedAt)}</span><h3><a href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">${esc(video.title)}</a></h3><p>${esc(video.summary)}</p><div class="transcript"><details><summary>逐字稿證據 · ${esc(statusLabels[transcriptStatus] || transcriptStatus)}</summary><p>${esc(video.transcript?.charCount || 0)} 字 · ${esc(video.transcript?.source || "無來源")}</p>${evidence || `<p class="quote">此影片沒有通過規則的個股證據。</p>`}</details></div></article>`;
  }).join("") || `<p>沒有符合條件的影片。</p>`;
  $("clearStock")?.addEventListener("click", () => renderVideos(filter));
}

renderVideos();
$("filters").addEventListener("click", event => {
  if (!event.target.dataset.filter) return;
  document.querySelectorAll("#filters button").forEach(button => button.classList.remove("active"));
  event.target.classList.add("active");
  renderVideos(event.target.dataset.filter);
});
$("stocks").addEventListener("click", event => {
  if (!event.target.dataset.stock) return;
  renderVideos("全部", event.target.dataset.stock);
  $("videos").scrollIntoView({ behavior: "smooth" });
});
