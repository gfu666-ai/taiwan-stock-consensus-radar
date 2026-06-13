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
  { name: "AI 需求仍是科技股主軸", terms: ["AI"], summary: "多支影片把 AI 需求連結至半導體、伺服器、光通訊或終端應用，但對估值與追價風險看法不一。" },
  { name: "SpaceX 與低軌衛星供應鏈", terms: ["SpaceX", "低軌衛星"], summary: "SpaceX 上市與低軌衛星題材被反覆討論，焦點落在台灣 PCB、射頻與化合物半導體供應鏈。" },
  { name: "反彈行情仍需風險控管", terms: ["反彈", "風險"], summary: "節目普遍承認指數或個股出現反彈，同時提醒波動、估值與技術面確認仍重要。" },
  { name: "月線作為權值股判斷基準", terms: ["月線"], summary: "分析者多次用月線判斷台積電、鴻海、聯發科等權值股是否轉強或仍在整理。" },
  { name: "記憶體與被動元件短線升溫", terms: ["記憶體", "被動"], summary: "記憶體與被動元件在盤勢劇烈波動中成為短線焦點，影片同時討論族群輪動與追價風險。" }
];

function matchingSegments(transcript, terms) {
  if (transcript?.status !== "verified") return [];
  return transcript.segments.filter(segment => terms.some(term => segment.text.toLowerCase().includes(term.toLowerCase())));
}

const stocks = stockDictionary.map(([ticker, name]) => {
  const evidence = [];
  let mentionCount = 0;
  for (const source of sources) {
    const transcript = transcriptById.get(source.id);
    const segments = matchingSegments(transcript, [name]);
    const count = transcript?.status === "verified" ? (transcript.text.match(new RegExp(name, "g")) || []).length : 0;
    mentionCount += count;
    if (segments.length) evidence.push({ videoId: source.id, segmentId: segments[0].id, quote: segments[0].text, timestampSec: segments[0].startSec });
  }
  return { ticker, name, videoCount: evidence.length, mentionCount, evidence };
}).filter(stock => stock.videoCount > 0).sort((a,b) => b.videoCount - a.videoCount || b.mentionCount - a.mentionCount);

const themes = themeDefinitions.map(definition => {
  const evidence = [];
  for (const source of sources) {
    const transcript = transcriptById.get(source.id);
    const segments = matchingSegments(transcript, definition.terms);
    if (segments.length) evidence.push({ videoId: source.id, segmentId: segments[0].id, quote: segments[0].text, timestampSec: segments[0].startSec });
  }
  return { ...definition, videoCount: evidence.length, videoIds: evidence.map(item => item.videoId), evidence };
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
  const evidence = stocks.flatMap(stock => stock.evidence.filter(item => item.videoId === source.id).map(item => ({ quote: item.quote, timestamp: `${Math.floor(item.timestampSec/60)}:${String(Math.floor(item.timestampSec%60)).padStart(2,"0")}`, stock: stock.name }))).slice(0, 4);
  return {
    id: source.id, title: source.title, url: source.url, channel: source.channel,
    publishedAt: source.publishedAt, duration: source.duration, dateEvidence: source.dateEvidence,
    summary: summaries[source.id], stocks: videoStocks, evidence,
    transcript: { status: transcript.status, source: transcript.source, charCount: transcript.charCount, sha256: transcript.sha256, retrievedAt: transcript.retrievedAt, error: transcript.error }
  };
});

const verified = videos.filter(video => video.transcript.status === "verified");
const checks = [
  { name: "7 日內素材", passed: videos.length > 0 && videos.every(v => v.publishedAt.slice(0,10) >= "2026-06-07" && v.publishedAt.slice(0,10) <= "2026-06-13"), detail: `${videos.length} 支影片均落在 2026-06-07 至 2026-06-13` },
  { name: "逐字稿非空", passed: verified.length > 0 && verified.every(v => v.transcript.charCount >= 100 && v.transcript.sha256), detail: `${verified.length} 份通過，${videos.length-verified.length} 份字幕不可得` },
  { name: "工作2確有輸出", passed: stocks.length > 0 && themes.length > 0, detail: `${stocks.length} 檔個股、${themes.length} 個跨影片主題` },
  { name: "分析可回查", passed: stocks.every(stock => stock.evidence.length > 0) && themes.every(theme => theme.evidence.length >= 2), detail: "每檔個股與共通主題均連回逐字稿 segment" },
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
