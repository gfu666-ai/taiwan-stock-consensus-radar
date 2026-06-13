import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchTranscript } from "youtube-transcript";

const sourcePath = new URL("../data/sources.json", import.meta.url);
const outputPath = new URL("../data/transcripts.json", import.meta.url);
const sources = JSON.parse(readFileSync(sourcePath));
const results = [];

for (const video of sources) {
  try {
    const raw = await fetchTranscript(video.url, { lang: "zh-TW" }).catch(() => fetchTranscript(video.url));
    const segments = raw.map((item, index) => ({
      id: `${video.id}-seg-${String(index + 1).padStart(4, "0")}`,
      startSec: Number(item.offset || 0) / 1000,
      durationSec: Number(item.duration || 0) / 1000,
      text: String(item.text || "").replace(/\s+/g, " ").trim()
    })).filter(item => item.text);
    const text = segments.map(item => item.text).join("\n");
    results.push({
      videoId: video.id,
      status: text.length >= 100 ? "verified" : "failed",
      source: "YouTube captions via youtube-transcript",
      retrievedAt: new Date().toISOString(),
      charCount: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
      text,
      segments,
      error: text.length >= 100 ? null : "Transcript shorter than 100 characters"
    });
  } catch (error) {
    results.push({
      videoId: video.id,
      status: "unavailable",
      source: "YouTube captions via youtube-transcript",
      retrievedAt: new Date().toISOString(),
      charCount: 0,
      sha256: null,
      text: "",
      segments: [],
      error: error instanceof Error ? error.message : String(error)
    });
  }
  console.log(`${video.id}: ${results.at(-1).status} (${results.at(-1).charCount} chars)`);
}

writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
