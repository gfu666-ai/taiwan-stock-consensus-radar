import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../data/recommendations.json", import.meta.url), "utf8"));
const history = JSON.parse(readFileSync(new URL("../data/technical-history.json", import.meta.url), "utf8"));
const performance = JSON.parse(readFileSync(new URL("../data/model-performance.json", import.meta.url), "utf8"));
const weights = data.weights;
const maxima = {
  technical: weights.technical,
  fundamental: weights.fundamental,
  institutional: weights.institutional,
  usIndustry: weights.usIndustry,
  industryHeat: weights.industryHeat
};
const componentsValid = stock => Object.entries(maxima).every(([key, maximum]) =>
  Number.isFinite(stock.scores[key]) && stock.scores[key] >= 0 && stock.scores[key] <= maximum
);
const totalMatches = stock => Math.abs(
  stock.scores.total - Object.keys(maxima).reduce((total, key) => total + stock.scores[key], 0)
) < 0.06;
const decisionValid = stock => {
  const rules = data.decisionRules;
  if (!stock.decision?.level || !stock.decision.label) return false;
  if (stock.decision.level === "buy") return stock.scores.total >= rules.buyMinScore && stock.riskFlags.every(risk => !rules.blockingRiskPatterns.some(pattern => risk.includes(pattern)));
  if (stock.decision.level === "blocked") return stock.scores.total >= rules.buyMinScore;
  if (stock.decision.level === "watch") return stock.scores.total >= rules.watchMinScore && stock.scores.total < rules.buyMinScore;
  return stock.decision.level === "avoid" && stock.scores.total < rules.watchMinScore;
};
const entryPlanValid = stock => {
  const plan = stock.entryPlan;
  return plan && [plan.zoneLow, plan.zoneHigh, plan.breakoutPrice, plan.invalidationPrice].every(Number.isFinite)
    && plan.invalidationPrice < plan.zoneLow
    && plan.zoneLow <= plan.zoneHigh
    && plan.zoneHigh <= plan.breakoutPrice
    && typeof plan.status === "string"
    && typeof plan.rationale === "string";
};
const comparisonValid = stock => Number.isInteger(stock.currentRank)
  && stock.currentRank > 0
  && ["new", "up", "down", "unchanged"].includes(stock.movement)
  && (stock.previousRank == null || Number.isInteger(stock.previousRank))
  && (stock.rankChange == null || Number.isInteger(stock.rankChange))
  && (stock.scoreChange == null || Number.isFinite(stock.scoreChange));
const rankingChangesValid = comparison => {
  if (!Array.isArray(comparison?.newTop12) || !Array.isArray(comparison?.droppedTop12)) return false;
  const newCodes = comparison.newTop12.map(stock => stock.code);
  const droppedCodes = comparison.droppedTop12.map(stock => stock.code);
  return new Set(newCodes).size === newCodes.length
    && new Set(droppedCodes).size === droppedCodes.length
    && comparison.droppedTop12.every(stock => Number.isInteger(stock.previousRank) && stock.previousRank >= 1 && stock.previousRank <= 12);
};
const capitalConcentrationValid = stock => {
  const metric = stock.capitalConcentration;
  return metric && Number.isFinite(metric.score) && metric.score >= 0 && metric.score <= 100
    && [metric.components.volume, metric.components.institutional, metric.components.priceVolume, metric.components.trend].every(Number.isFinite)
    && metric.components.volume <= 30 && metric.components.institutional <= 30
    && metric.components.priceVolume <= 25 && metric.components.trend <= 15
    && typeof metric.label === "string" && typeof metric.dominantSource === "string";
};

const checks = [
  ["技術圖資料", data.candidates.every(stock => history.stocks[stock.code]?.length >= 60) && data.recommendations.every(stock => history.stocks[stock.code]?.length >= 60), "所有有效評分與推薦股均有至少60日日K可供下鑽"],
  ["法人趨勢圖資料", data.candidates.every(stock => history.institutional?.[stock.code]?.length >= 15 && history.institutional[stock.code].every(row => row.date && [row.foreign, row.trust].every(Number.isFinite))), "所有有效評分股票均有至少15日外資與投信買賣超"],
  ["全市場掃描", data.universeStats.scanned >= 800 && data.universeStats.scanned === data.universeStats.listedCompanies && data.universeStats.scanned === data.universeStats.validScores + data.universeStats.excluded, `${data.universeStats.scanned} 檔上市公司均有有效分數或排除原因`],
  ["全市場有效評分", data.universeStats.validScores >= 100, `${data.universeStats.validScores} 檔通過資料與流動性門檻`],
  ["近一週成交量門檻", data.universeStats.averageVolume5Minimum === 1000000 && data.candidates.every(stock => stock.technical.averageVolume5 >= data.universeStats.averageVolume5Minimum), "所有有效評分股票最近5日平均成交量至少1,000張"],
  ["推薦數量", data.recommendations.length === 3, "固定輸出 3 檔"],
  ["上市股票代碼", data.recommendations.every(stock => /^\d{4}$/.test(stock.code) && stock.latestPrice > 0), "皆為四位數上市股票且有最新成交價"],
  ["推薦去重", new Set(data.recommendations.map(stock => stock.code)).size === 3, "三檔股票不重複"],
  ["權重合計", Object.values(weights).reduce((total, value) => total + value, 0) === 100, "技術、財務、法人、美股與產業合計 100%"],
  ["買進門檻", data.decisionRules.buyMinScore > data.decisionRules.watchMinScore && data.candidates.every(decisionValid), `總分 ${data.decisionRules.buyMinScore} 分以上且無重大風險才顯示買進`],
  ["模型進場計畫", data.candidates.every(entryPlanValid), "所有有效評分股票均有合理排序的進場區間、突破價與失效價"],
  ["候選排名比較", data.candidates.every((stock, index) => comparisonValid(stock) && stock.currentRank === index + 1) && rankingChangesValid(data.comparison), "保留上期排名、本期排名、升降、分數變化及前12名進出紀錄"],
  ["資金集中訊號", data.candidates.every(capitalConcentrationValid) && data.capitalConcentrationRanking.length === 20 && data.capitalConcentrationRanking.every((stock, index) => stock.capitalRank === index + 1), "所有有效候選股均有0至100分資金集中訊號，並輸出前20名"],
  ["分數邊界", data.candidates.every(stock => componentsValid(stock) && totalMatches(stock)), "分項未超過權重且總分可重算"],
  ["資料完整", data.recommendations.every(stock => stock.eligible && stock.technical.historyDays >= 60 && stock.institutional.days >= 15), "推薦股具至少 60 日日K與 15 日法人資料"],
  ["財務資料", data.recommendations.every(stock => stock.fundamental.revenueYoY != null && (stock.fundamental.isFinancial ? stock.fundamental.roe != null : stock.fundamental.operatingMargin != null) && stock.fundamental.debtRatio != null), "推薦股具營收、獲利與資產負債資料"],
  ["美股映射", data.recommendations.every(stock => stock.usIndustry.length >= 2), "每檔至少對應 2 檔美國產業龍頭"],
  ["產業分散", data.focuses.every(focus => data.recommendations.filter(stock => stock.focusId === focus.id).length <= 2), "單一產業最多 2 檔"],
  ["風險揭露", data.recommendations.every(stock => Array.isArray(stock.riskFlags)) && /不保證報酬/.test(data.disclaimer), "保留個股風險旗標與非保證聲明"]
  ,["模型快照稽核", data.modelAudit?.immutableSnapshot === true && performance.modelVersion === data.modelAudit.modelVersion && performance.snapshotCount >= 1, "保存不可覆寫的每日模型快照並輸出向前驗證狀態"]
  ,["勝率誠實揭露", performance.sampleSufficient || (performance.targetObserved === false && performance.targetStatisticallySupported === false), "樣本不足時不得宣稱達成目標勝率"]
];

const failures = checks.filter(([, passed]) => !passed);
for (const [name, passed, detail] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
if (failures.length) process.exitCode = 1;
