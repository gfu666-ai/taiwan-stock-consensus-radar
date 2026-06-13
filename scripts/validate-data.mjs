import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(new URL("../data/dashboard.json", import.meta.url)));
const transcripts = JSON.parse(readFileSync(new URL("../data/transcripts.json", import.meta.url)));
const segmentIndex = new Map(transcripts.flatMap(t => t.segments.map(s => [s.id, s.text])));
const inRange = d => d >= data.window.from && d <= data.window.to;
const evidenceValid = item => segmentIndex.get(item.segmentId)?.includes(item.quote);
const checks = [
  ["影片素材", data.videos.length > 0, `${data.videos.length} 支影片`],
  ["網址與日期", data.videos.length > 0 && data.videos.every(v => /^https:\/\/(www\.)?youtube\.com\//.test(v.url) && inRange(v.publishedAt.slice(0,10))), "URL 格式與日期範圍"],
  ["逐字稿產出", data.videos.some(v => v.transcript?.status === "verified" && v.transcript.charCount > 200), "至少一份有效逐字稿"],
  ["分析產出", data.themes.length > 0 && data.stocks.length > 0, `${data.themes.length} 主題、${data.stocks.length} 個股`],
  ["原文證據", data.stocks.length > 0 && data.stocks.every(s => s.evidence?.length > 0 && s.evidence.every(evidenceValid)) && data.themes.every(t => t.evidence?.length >= 2 && t.evidence.every(evidenceValid)), "每項分析可回查實際逐字稿 segment"]
];
const failures = checks.filter(([,ok])=>!ok);
for (const [name,ok,detail] of checks) console.log(`${ok?"PASS":"FAIL"} ${name}: ${detail}`);
if (failures.length) process.exitCode = 1;
