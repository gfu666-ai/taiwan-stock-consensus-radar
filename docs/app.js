const data = await fetch("./data/dashboard.json").then(r => r.json());
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

$("updated").textContent = data.generatedAt ? `更新 ${new Date(data.generatedAt).toLocaleString("zh-TW")}` : "尚未產生資料";
$("summary").innerHTML = [
  [data.videos.length,"影片"],
  [data.videos.filter(v=>v.transcript?.status==="verified").length,"有效逐字稿"],
  [data.themes.length,"共通主題"],
  [data.stocks.length,"辨識個股"]
].map(([n,l])=>`<div class="metric"><strong>${n}</strong><span>${l}</span></div>`).join("");

const valid = data.validation.passed;
$("validationBadge").className = `badge ${valid?"pass":"fail"}`;
$("validationBadge").textContent = valid ? "驗證通過" : "驗證未通過";
$("checks").innerHTML = data.validation.checks.map(c=>`<article class="check ${c.passed?"pass":"fail"}"><strong>${c.passed?"通過":"未通過"} · ${esc(c.name)}</strong><small>${esc(c.detail)}</small></article>`).join("") || `<article class="check fail"><strong>尚無檢驗結果</strong></article>`;
$("warnings").innerHTML = data.validation.warnings?.length ? `<div class="warnings">${data.validation.warnings.map(esc).join("<br>")}</div>` : "";

$("themes").innerHTML = data.themes.map(t=>`<article class="theme"><span class="count">${t.videoCount}</span><strong>${esc(t.name)}</strong><p>${esc(t.summary)}</p><small>來源：${t.videoIds.map(esc).join("、")}</small></article>`).join("") || `<p>尚無跨影片主題。</p>`;
const maxMentions = Math.max(1,...data.stocks.map(s=>s.videoCount));
$("stocks").innerHTML = data.stocks.map(s=>`<div class="stock-row"><span class="ticker">${esc(s.ticker||"未確認")}</span><div><strong>${esc(s.name)}</strong><div class="bar"><span style="width:${s.videoCount/maxMentions*100}%"></span></div><small>${s.videoCount} 支影片提及 · ${s.mentionCount} 次文字命中</small></div><button data-stock="${esc(s.name)}">查看證據</button></div>`).join("") || `<p>尚無通過證據檢驗的個股。</p>`;

const statuses = ["全部",...new Set(data.videos.map(v=>v.transcript?.status||"missing"))];
$("filters").innerHTML = statuses.map((s,i)=>`<button class="${i===0?"active":""}" data-filter="${s}">${s}</button>`).join("");
function renderVideos(filter="全部", stock="") {
  const rows = data.videos.filter(v => (filter==="全部" || v.transcript?.status===filter) && (!stock || v.stocks?.some(s=>s.name===stock)));
  $("videos").innerHTML = rows.map(v=>`<article class="video"><span class="video-meta">${esc(v.channel)} · ${esc(v.publishedAt)}</span><h3><a href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(v.title)}</a></h3><p>${esc(v.summary)}</p><div class="transcript"><details><summary>逐字稿證據 · ${esc(v.transcript?.status||"missing")}</summary><p>${esc(v.transcript?.charCount||0)} 字 · ${esc(v.transcript?.source||"無來源")}</p>${(v.evidence||[]).map(e=>`<p class="quote">${esc(e.quote)} <small>${esc(e.timestamp||"")}</small></p>`).join("")}</details></div></article>`).join("") || `<p>沒有符合條件的影片。</p>`;
}
renderVideos();
$("filters").addEventListener("click",e=>{if(!e.target.dataset.filter)return;document.querySelectorAll("#filters button").forEach(b=>b.classList.remove("active"));e.target.classList.add("active");renderVideos(e.target.dataset.filter);});
$("stocks").addEventListener("click",e=>{if(e.target.dataset.stock){renderVideos("全部",e.target.dataset.stock);$("videos").scrollIntoView({behavior:"smooth"});}});
