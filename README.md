# 台股市場共識雷達

蒐集台北時間 2026-06-07 至 2026-06-13 的台灣財經 YouTube 影片，擷取可用字幕，交叉整理共通主題與台股公司提及，並以 Dashboard 呈現證據。

## 執行

```powershell
npm.cmd install
npm.cmd run transcripts
npm.cmd run build:data
npm.cmd run build:site
npm.cmd run validate
npm.cmd start
```

開啟 `http://127.0.0.1:4173`。

`docs/` 是可直接發布到 GitHub Pages 的靜態網站版本。

## 資料與驗證

- `data/sources.json`：影片 URL、頻道、日期與日期證據。
- `data/transcripts.json`：完整逐字稿、segment、字數、SHA-256 與失敗原因。
- `data/dashboard.json`：Dashboard 使用的個股、主題及原文證據。
- `scripts/validate-data.mjs`：確認素材、日期、逐字稿、分析與證據都有實際產出。

## 分析規則

- 英文關鍵字使用完整詞比對，例如 `AI` 不會命中 `xAI`。
- 「被動元件」只接受完整詞，不以「被動」推論，避免把被動 ETF 算入元件族群。
- 跨影片主題至少需由 2 支不同影片支持；複合主題的必要訊號必須出現在相近字幕段落。
- 每項證據保留命中詞、字幕錨點及連續上下文，可由時間連結回查原影片。

逐字稿不可取得的影片會保留在素材清單，但不會參與股票或主題分析。個股提及不等於推薦，本工具不構成投資建議。
