import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../data/recommendation-config.json", import.meta.url), "utf8"));
const snapshotDirectory = new URL("../data/model-snapshots/", import.meta.url);
mkdirSync(snapshotDirectory, { recursive: true });

const snapshots = readdirSync(snapshotDirectory)
  .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .sort()
  .map(name => JSON.parse(readFileSync(new URL(name, snapshotDirectory), "utf8")));
const policy = config.evaluationPolicy;

function netReturn(entryPrice, exitPrice) {
  const slippage = policy.slippagePctEachSide / 100;
  const commission = policy.commissionPctEachSide / 100;
  const tax = policy.sellTaxPct / 100;
  const entryCost = entryPrice * (1 + slippage) * (1 + commission);
  const exitProceeds = exitPrice * (1 - slippage) * (1 - commission - tax);
  return (exitProceeds / entryCost - 1) * 100;
}

function wilsonInterval(wins, total, z = 1.96) {
  if (!total) return { low: null, high: null };
  const p = wins / total;
  const denominator = 1 + z ** 2 / total;
  const centre = (p + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator;
  return { low: Math.max(0, centre - margin) * 100, high: Math.min(1, centre + margin) * 100 };
}

const trades = [];
for (let signalIndex = 0; signalIndex < snapshots.length; signalIndex += 1) {
  const signal = snapshots[signalIndex];
  const future = snapshots.slice(signalIndex + 1, signalIndex + 1 + policy.holdingTradingDays);
  if (future.length < policy.holdingTradingDays) continue;

  for (const recommendation of signal.recommendations) {
    const entryBar = future[0].marketBars[recommendation.code];
    if (!entryBar?.open) continue;
    const stopPrice = entryBar.open * (1 + policy.stopLossPct / 100);
    const targetPrice = entryBar.open * (1 + policy.takeProfitPct / 100);
    let exitPrice = future.at(-1).marketBars[recommendation.code]?.close ?? null;
    let exitDate = future.at(-1).dataAsOf;
    let exitReason = "持有期到期";

    for (const day of future) {
      const bar = day.marketBars[recommendation.code];
      if (!bar) continue;
      if (bar.low <= stopPrice) {
        exitPrice = stopPrice;
        exitDate = day.dataAsOf;
        exitReason = bar.high >= targetPrice ? "同日觸及停損與停利，採不利停損" : "停損";
        break;
      }
      if (bar.high >= targetPrice) {
        exitPrice = targetPrice;
        exitDate = day.dataAsOf;
        exitReason = "停利";
        break;
      }
    }
    if (!exitPrice) continue;
    const returnPct = netReturn(entryBar.open, exitPrice);
    trades.push({
      signalDate: signal.dataAsOf,
      entryDate: future[0].dataAsOf,
      exitDate,
      code: recommendation.code,
      name: recommendation.name,
      rank: recommendation.rank,
      score: recommendation.totalScore,
      entryPrice: entryBar.open,
      exitPrice: Number(exitPrice.toFixed(2)),
      exitReason,
      netReturnPct: Number(returnPct.toFixed(2)),
      win: returnPct > 0
    });
  }
}

const wins = trades.filter(trade => trade.win).length;
const losses = trades.length - wins;
const grossProfit = trades.filter(trade => trade.netReturnPct > 0).reduce((total, trade) => total + trade.netReturnPct, 0);
const grossLoss = Math.abs(trades.filter(trade => trade.netReturnPct < 0).reduce((total, trade) => total + trade.netReturnPct, 0));
const winRatePct = trades.length ? wins / trades.length * 100 : null;
const averageReturnPct = trades.length ? trades.reduce((total, trade) => total + trade.netReturnPct, 0) / trades.length : null;
const interval = wilsonInterval(wins, trades.length);
const sampleSufficient = trades.length >= policy.minimumCompletedTrades;
const targetObserved = sampleSufficient && winRatePct >= policy.targetWinRatePct;
const targetStatisticallySupported = targetObserved && interval.low >= policy.targetWinRatePct;

const output = {
  generatedAt: new Date().toISOString(),
  modelVersion: policy.modelVersion,
  policy,
  snapshotCount: snapshots.length,
  firstSnapshotDate: snapshots[0]?.dataAsOf ?? null,
  latestSnapshotDate: snapshots.at(-1)?.dataAsOf ?? null,
  completedSignalDates: new Set(trades.map(trade => trade.signalDate)).size,
  status: sampleSufficient ? "樣本已達最低門檻" : "樣本累積中，尚未完成勝率驗證",
  sampleSufficient,
  targetObserved,
  targetStatisticallySupported,
  metrics: {
    completedTrades: trades.length,
    wins,
    losses,
    winRatePct: winRatePct == null ? null : Number(winRatePct.toFixed(2)),
    winRate95Pct: { low: interval.low == null ? null : Number(interval.low.toFixed(2)), high: interval.high == null ? null : Number(interval.high.toFixed(2)) },
    averageNetReturnPct: averageReturnPct == null ? null : Number(averageReturnPct.toFixed(2)),
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? null : 0
  },
  caveats: [
    "只使用模型快照建立後實際向前出現的行情，不回填過去訊號。",
    "進場採訊號後下一交易日開盤，並計入雙邊滑價、手續費與賣出證交稅。",
    "樣本未達最低交易數時不得宣稱勝率；達標後仍須同時檢查95%信賴區間、平均報酬與Profit Factor。",
    "財報與產業熱度歷史公告版本尚未完整，因此本驗證只適用於快照啟用日之後。"
  ],
  trades
};

writeFileSync(new URL("../data/model-performance.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Model performance: ${snapshots.length} snapshots, ${trades.length} completed trades, status: ${output.status}`);
