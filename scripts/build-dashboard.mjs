import { readFileSync, writeFileSync } from "node:fs";

const sources = JSON.parse(readFileSync(new URL("../data/sources.json", import.meta.url)));
const transcripts = JSON.parse(readFileSync(new URL("../data/transcripts.json", import.meta.url)));
const transcriptById = new Map(transcripts.map(item => [item.videoId, item]));

const stockDictionary = [
  ["2330", "台積電"], ["2317", "鴻海"], ["2327", "國巨"], ["2408", "南亞科"],
  ["2303", "聯電"], ["2313", "華通"], ["3105", "穩懋"], ["3491", "昇達科"],
  ["2345", "智邦"], ["2454", "聯發科"], ["3034", "聯詠"], ["3037", "欣興"],
  ["3711", "日月光"], ["8299", "群聯"], ["1503", "士電"], ["2404", "漢唐"],
  ["5536", "聖暉"], ["6788", "華景電"], ["6139", "亞翔"], ["6196", "帆宣"],
  ["6274", "台燿"], ["2467", "志聖"], ["2059", "川湖"], ["6285", "啟碁"],
  ["6488", "環球晶"], ["5347", "世界先進"], ["2376", "技嘉"], ["2377", "微星"],
  ["3374", "精材"], ["2492", "華新科"], ["3481", "群創"], ["8358", "金居"],
  ["1519", "華城"]
];

const themeDefinitions = [
  { name: "AI 需求仍是科技股主軸", groups: [{ label: "AI", terms: ["AI", "人工智慧"] }], summary: "多支影片把 AI 需求連結至半導體、伺服器、光通訊或終端應用，但對估值與追價風險看法不一。" },
  { name: "SpaceX 與低軌衛星供應鏈", groups: [{ label: "衛星題材", terms: ["SpaceX", "低軌衛星"] }], summary: "SpaceX 上市與低軌衛星題材被反覆討論，焦點落在台灣 PCB、射頻與化合物半導體供應鏈。" },
  { name: "反彈行情仍需風險控管", groups: [
    { label: "反彈", terms: ["反彈", "回升", "V轉"] },
    { label: "風險控管", terms: ["風險", "別急追", "不要追", "追價", "停損"] }
  ], summary: "同一段討論同時出現反彈訊號與風險提醒，顯示分析者並未把反彈直接視為趨勢確認。" },
  { name: "月線作為權值股判斷基準", groups: [{ label: "月線", terms: ["月線"] }], summary: "分析者多次用月線判斷台積電、鴻海、聯發科等權值股是否轉強或仍在整理。" },
  { name: "記憶體／被動元件短線升溫", groups: [{ label: "族群", terms: ["記憶體", "被動元件"] }], summary: "記憶體或被動元件在盤勢劇烈波動中成為短線焦點；此處不把被動 ETF 的討論計入被動元件。" }
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesTerm(text, term) {
  if (/^[a-z0-9]+$/i.test(term)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`, "i").test(text);
  }
  return text.toLowerCase().includes(term.toLowerCase());
}

function contextEvidence(transcript, anchorIndex, radius, matchedTerms) {
  const from = Math.max(0, anchorIndex - radius);
  const to = Math.min(transcript.segments.length, anchorIndex + radius + 1);
  const context = transcript.segments.slice(from, to);
  return {
    segmentId: transcript.segments[anchorIndex].id,
    contextSegmentIds: context.map(segment => segment.id),
    quote: context.map(segment => segment.text).join(" "),
    timestampSec: transcript.segments[anchorIndex].startSec,
    matchedTerms: [...new Set(matchedTerms)]
  };
}

function findThemeEvidence(transcript, definition) {
  if (transcript?.status !== "verified") return null;
  const proximityRadius = definition.groups.length > 1 ? 6 : 0;
  for (let index = 0; index < transcript.segments.length; index += 1) {
    const from = Math.max(0, index - proximityRadius);
    const to = Math.min(transcript.segments.length, index + proximityRadius + 1);
    const nearbyText = transcript.segments.slice(from, to).map(segment => segment.text).join(" ");
    const groupMatches = definition.groups.map(group => group.terms.filter(term => includesTerm(nearbyText, term)));
    if (groupMatches.every(matches => matches.length > 0)) {
      const anchorMatches = definition.groups.flatMap(group => group.terms).filter(term => includesTerm(transcript.segments[index].text, term));
      if (anchorMatches.length > 0) return contextEvidence(transcript, index, Math.max(2, proximityRadius), groupMatches.flat());
    }
  }
  return null;
}

function matchingSegmentIndexes(transcript, terms) {
  if (transcript?.status !== "verified") return [];
  return transcript.segments.flatMap((segment, index) => terms.some(term => includesTerm(segment.text, term)) ? [index] : []);
}

const stocks = stockDictionary.map(([ticker, name]) => {
  const evidence = [];
  let mentionCount = 0;
  for (const source of sources) {
    const transcript = transcriptById.get(source.id);
    const indexes = matchingSegmentIndexes(transcript, [name]);
    const count = transcript?.status === "verified" ? (transcript.text.match(new RegExp(escapeRegExp(name), "g")) || []).length : 0;
    mentionCount += count;
    if (indexes.length) evidence.push({ videoId: source.id, ...contextEvidence(transcript, indexes[0], 1, [name]) });
  }
  return { ticker, name, videoCount: evidence.length, mentionCount, evidence };
}).filter(stock => stock.videoCount > 0).sort((a,b) => b.videoCount - a.videoCount || b.mentionCount - a.mentionCount);

const themes = themeDefinitions.map(definition => {
  const evidence = [];
  for (const source of sources) {
    const transcript = transcriptById.get(source.id);
    const match = findThemeEvidence(transcript, definition);
    if (match) evidence.push({ videoId: source.id, ...match });
  }
  return {
    name: definition.name,
    criteria: definition.groups.map(group => group.label),
    summary: definition.summary,
    videoCount: evidence.length,
    videoIds: evidence.map(item => item.videoId),
    evidence
  };
}).filter(theme => theme.videoCount >= 2).sort((a,b) => b.videoCount - a.videoCount);

const summaries = {
  "1A7VYBGJn70": "聚焦台股急跌後反彈、記憶體與被動族群，以及大型權值股的技術位置。",
  "mJRUFvk_ra4": "討論台股反彈後的底部判斷與季線附近個股。",
  "1O9eawPBHws": "從 SpaceX IPO 延伸至低軌衛星商機、估值風險與台灣供應鏈。",
  "Jxz5TPAtRtA": "分析台股劇烈震盪、記憶體與被動元件反撲，以及相關個股。",
  "9ChWtle1ViA": "晨間市場整理，涵蓋 SpaceX、國巨、嘉晶、CPO 與智邦。",
  "i5LKgjLJLY4": "專訪穩懋董事長，討論 AI 光通訊、化合物半導體與低軌衛星布局。",
  "aWpjnL3XsTQ": "以技術分析拆解鴻海與聯詠的盤整及底部訊號。",
  "ezYHprRn6hM": "討論國巨、聯發科、被動元件、IC 設計與 CPO 題材。",
  "3PVZxjgx3jo": "用月線與價格型態評估鴻海、台積電、聯發科等權值股回檔。"
};

const videos = sources.map(source => {
  const transcript = transcriptById.get(source.id) || { status: "unavailable", charCount: 0, source: "未執行" };
  const videoStocks = stocks.filter(stock => stock.evidence.some(item => item.videoId === source.id)).map(stock => ({ticker: stock.ticker, name: stock.name}));
  const evidence = stocks.flatMap(stock => stock.evidence.filter(item => item.videoId === source.id).map(item => ({ quote: item.quote, timestampSec: item.timestampSec, stock: stock.name }))).slice(0, 4);
  return {
    id: source.id, title: source.title, url: source.url, channel: source.channel,
    publishedAt: source.publishedAt, duration: source.duration, dateEvidence: source.dateEvidence,
    summary: summaries[source.id], stocks: videoStocks, evidence,
    transcript: { status: transcript.status, source: transcript.source, charCount: transcript.charCount, sha256: transcript.sha256, retrievedAt: transcript.retrievedAt, error: transcript.error }
  };
});

const verified = videos.filter(video => video.transcript.status === "verified");
const allEvidence = [...stocks.flatMap(stock => stock.evidence), ...themes.flatMap(theme => theme.evidence)];
const evidenceTraceable = evidence => {
  const transcript = transcriptById.get(evidence.videoId);
  if (!transcript || !evidence.contextSegmentIds?.includes(evidence.segmentId)) return false;
  const segments = new Map(transcript.segments.map(segment => [segment.id, segment.text]));
  return evidence.contextSegmentIds.every(id => segments.has(id)) &&
    evidence.contextSegmentIds.map(id => segments.get(id)).join(" ") === evidence.quote &&
    evidence.matchedTerms?.every(term => includesTerm(evidence.quote, term));
};
const checks = [
  { name: "7 日內素材", passed: videos.length > 0 && videos.every(v => v.publishedAt.slice(0,10) >= "2026-06-07" && v.publishedAt.slice(0,10) <= "2026-06-13"), detail: `${videos.length} 支影片均落在 2026-06-07 至 2026-06-13` },
  { name: "逐字稿非空", passed: verified.length > 0 && verified.every(v => v.transcript.charCount >= 100 && v.transcript.sha256), detail: `${verified.length} 份通過，${videos.length-verified.length} 份字幕不可得` },
  { name: "分析結果", passed: stocks.length > 0 && themes.length > 0, detail: `${stocks.length} 檔個股、${themes.length} 個跨影片主題` },
  { name: "分析可回查", passed: allEvidence.length > 0 && allEvidence.every(evidenceTraceable), detail: "每項證據均保留連續字幕上下文、錨點及命中詞" },
  { name: "主題去重與語意", passed: themes.every(theme => theme.videoCount === new Set(theme.videoIds).size) && allEvidence.every(evidence => !evidence.matchedTerms.includes("被動")), detail: "每支影片每個主題只計一次，且不以模糊的「被動」判定被動元件" },
  { name: "失敗資料隔離", passed: videos.filter(v=>v.transcript.status!=="verified").every(v=>v.evidence.length===0), detail: "無逐字稿影片未參與個股與主題抽取" }
];

const dashboard = {
  generatedAt: new Date().toISOString(),
  window: { timezone: "Asia/Taipei", from: "2026-06-07", to: "2026-06-13" },
  videos, themes, stocks,
  validation: {
    passed: checks.every(check => check.passed), checks,
    warnings: videos.filter(v => v.transcript.status !== "verified").map(v => `${v.title}：字幕不可取得，未納入工作2。`)
  }
};

writeFileSync(new URL("../data/dashboard.json", import.meta.url), `${JSON.stringify(dashboard, null, 2)}\n`);
console.log(`Built dashboard with ${videos.length} videos, ${verified.length} transcripts, ${stocks.length} stocks, ${themes.length} themes.`);
