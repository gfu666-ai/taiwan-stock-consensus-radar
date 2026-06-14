import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../data/dashboard.json", import.meta.url)));
const transcripts = JSON.parse(readFileSync(new URL("../data/transcripts.json", import.meta.url)));
const transcriptById = new Map(transcripts.map(transcript => [transcript.videoId, transcript]));
const inRange = date => date >= data.window.from && date <= data.window.to;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesTerm(text, term) {
  if (/^[a-z0-9]+$/i.test(term)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`, "i").test(text);
  }
  return text.toLowerCase().includes(term.toLowerCase());
}

function evidenceValid(evidence) {
  const transcript = transcriptById.get(evidence.videoId);
  if (!transcript || !evidence.contextSegmentIds?.includes(evidence.segmentId)) return false;
  const segments = new Map(transcript.segments.map(segment => [segment.id, segment.text]));
  const quote = evidence.contextSegmentIds.map(id => segments.get(id));
  return quote.every(Boolean) &&
    quote.join(" ") === evidence.quote &&
    evidence.matchedTerms?.length > 0 &&
    evidence.matchedTerms.every(term => includesTerm(evidence.quote, term));
}

const allEvidence = [...data.stocks.flatMap(stock => stock.evidence), ...data.themes.flatMap(theme => theme.evidence)];
const checks = [
  ["影片素材", data.videos.length > 0, `${data.videos.length} 支影片`],
  ["網址與日期", data.videos.length > 0 && data.videos.every(video => /^https:\/\/(www\.)?youtube\.com\//.test(video.url) && inRange(video.publishedAt.slice(0, 10))), "URL 格式與日期範圍"],
  ["逐字稿產出", data.videos.some(video => video.transcript?.status === "verified" && video.transcript.charCount > 200), "至少一份有效逐字稿"],
  ["分析產出", data.themes.length > 0 && data.stocks.length > 0, `${data.themes.length} 主題、${data.stocks.length} 個股`],
  ["原文上下文", allEvidence.length > 0 && allEvidence.every(evidenceValid), "證據、連續字幕、錨點與命中詞一致"],
  ["主題來源去重", data.themes.every(theme => theme.videoCount >= 2 && theme.videoCount === new Set(theme.videoIds).size && theme.evidence.length === theme.videoCount), "每支影片每個主題只計一次"],
  ["模糊詞排除", allEvidence.every(evidence => !evidence.matchedTerms.includes("被動")), "未以「被動」誤判被動 ETF 為被動元件"],
  ["字幕失敗隔離", data.videos.filter(video => video.transcript?.status !== "verified").every(video => video.evidence.length === 0 && video.stocks.length === 0), "無有效字幕的影片未參與分析"]
];

const failures = checks.filter(([, passed]) => !passed);
for (const [name, passed, detail] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
if (failures.length) process.exitCode = 1;
