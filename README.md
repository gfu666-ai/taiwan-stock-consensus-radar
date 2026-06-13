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

逐字稿不可取得的影片會保留在素材清單，但不會參與股票或主題分析。個股提及不等於推薦，本工具不構成投資建議。
