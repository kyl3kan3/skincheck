// SkinCheck client.
// Renders whatever score fields the API response actually contains —
// it normalizes both documented YouCam response shapes:
//   A) data.results.output: [{ type, ui_score, raw_score, mask_urls }]
//   B) data.score_info: { <concern>: { ui_score, raw_score, output_mask_name },
//                          all: { score }, skin_age: <int> }
//      (HD concerns may nest per-zone score objects; the "whole" zone is
//       preferred, otherwise zones are flattened as "concern · zone".)

const $ = (id) => document.getElementById(id);
const photoInput = $("photo-input");
const previewBox = $("preview-box");
const previewImg = $("preview");
const analyzeBtn = $("analyze-btn");
const statusEl = $("status");
const resultsEl = $("results");
const metricsEl = $("metrics");
const summaryEl = $("summary");
const nextStepsEl = $("next-steps");
const mockBanner = $("mock-banner");

let photoDataUrl = null;

// ---- photo handling -------------------------------------------------------

photoInput.addEventListener("change", async () => {
  const file = photoInput.files && photoInput.files[0];
  if (!file) return;
  setStatus("");
  try {
    photoDataUrl = await downscaleToDataUrl(file, 1600);
    previewImg.src = photoDataUrl;
    previewBox.hidden = false;
    analyzeBtn.disabled = false;
  } catch {
    setStatus("Could not read that photo. Try another one.", true);
  }
});

// Downscale so the base64 body stays small; 1600px long side is well
// inside the SD limits (long side <= 4096, short side >= 480).
function downscaleToDataUrl(file, maxSide) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale === 1 && /image\/(jpeg|png)/.test(file.type)) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ---- API call -------------------------------------------------------------

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
}

analyzeBtn.addEventListener("click", async () => {
  if (!photoDataUrl) return;
  analyzeBtn.disabled = true;
  resultsEl.hidden = true;
  setStatus("Analyzing your photo… this can take up to a minute.");
  try {
    let resp = await postSkin({ image: photoDataUrl });
    // The function returns early with a task_id if the task is still
    // running; keep polling with it (no extra API unit is consumed).
    let guard = 0;
    while (resp && resp.data && resp.data.task_status === "running" && resp.task_id && guard < 20) {
      guard += 1;
      setStatus("Still analyzing…");
      await new Promise((r) => setTimeout(r, 3000));
      resp = await postSkin({ task_id: resp.task_id });
    }
    if (!resp || !resp.data || resp.data.task_status !== "success") {
      const detail = (resp && (resp.error || resp.data?.error)) || "the analysis did not complete";
      throw new Error(detail);
    }
    renderResults(resp);
  } catch (err) {
    setStatus(`Something went wrong: ${err.message}. Check the photo is a clear, front-facing face and try again.`, true);
  } finally {
    analyzeBtn.disabled = false;
  }
});

async function postSkin(payload) {
  const res = await fetch("/api/skin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && json.error) || `Request failed (HTTP ${res.status})`);
  return json;
}

$("again-btn").addEventListener("click", () => {
  resultsEl.hidden = true;
  photoInput.value = "";
  photoDataUrl = null;
  previewBox.hidden = true;
  analyzeBtn.disabled = true;
  setStatus("");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---- result normalization -------------------------------------------------

// Returns { metrics: [{key, label, ui, raw, maskUrl}], overall, skinAge }
function normalize(resp) {
  const data = resp.data || {};
  const metrics = [];
  const seen = new Set();
  let overall = null;
  let skinAge = null;

  const push = (key, label, entry, maskUrl) => {
    if (!entry || typeof entry !== "object") return;
    const ui = typeof entry.ui_score === "number" ? entry.ui_score : null;
    const raw = typeof entry.raw_score === "number" ? entry.raw_score : null;
    const score = ui !== null ? ui : raw;
    if (score === null || seen.has(key)) return;
    seen.add(key);
    metrics.push({ key, label, ui: score, raw, maskUrl: maskUrl || null });
  };

  // Shape B first: score_info carries `all` and `skin_age` when present.
  const info = data.score_info || null;
  if (info && typeof info === "object") {
    for (const [key, value] of Object.entries(info)) {
      if (key === "all") {
        if (value && typeof value.score === "number") overall = value.score;
        continue;
      }
      if (key === "skin_age") {
        if (typeof value === "number") skinAge = value;
        continue;
      }
      if (value && typeof value === "object" && ("ui_score" in value || "raw_score" in value)) {
        push(key, prettyName(key), value, null);
      } else if (value && typeof value === "object") {
        // Nested per-zone scores (HD): prefer "whole", else flatten zones.
        if (value.whole) push(key, prettyName(key), value.whole, null);
        else for (const [zone, zEntry] of Object.entries(value)) {
          push(`${key}:${zone}`, `${prettyName(key)} · ${prettyName(zone)}`, zEntry, null);
        }
      }
    }
  }

  // Shape A: results.output array. Alongside the per-concern entries, the
  // live API appends three pseudo-entries (verified in the Oct 30 live
  // test): { type: "all", score } carries the overall score,
  // { type: "skin_age", score } the estimated skin age, and
  // { type: "resize_image", mask_urls } the resized input image.
  const output = data.results && Array.isArray(data.results.output) ? data.results.output : [];
  for (const item of output) {
    if (!item || !item.type) continue;
    if (item.type === "all") {
      if (typeof item.score === "number") overall = item.score;
      continue;
    }
    if (item.type === "skin_age") {
      if (typeof item.score === "number") skinAge = item.score;
      continue;
    }
    if (item.type === "resize_image") continue;
    const maskUrl = Array.isArray(item.mask_urls) && item.mask_urls.length ? item.mask_urls[0] : null;
    push(item.type, prettyName(item.type), item, maskUrl);
  }

  // Some responses may carry the summary fields at the top level of data.
  if (overall === null && data.results && typeof data.results.all?.score === "number") overall = data.results.all.score;
  if (skinAge === null && typeof data.skin_age === "number") skinAge = data.skin_age;

  metrics.sort((a, b) => a.ui - b.ui);
  return { metrics, overall, skinAge };
}

function prettyName(key) {
  return key.replace(/^hd_/, "").replace(/_v2$/, "").replace(/_/g, " ");
}

// ---- rendering ------------------------------------------------------------

function renderResults(resp) {
  const { metrics, overall, skinAge } = normalize(resp);
  mockBanner.hidden = !resp.mock;
  summaryEl.innerHTML = "";
  metricsEl.innerHTML = "";
  nextStepsEl.innerHTML = "";

  if (overall !== null || skinAge !== null) {
    if (overall !== null) summaryEl.appendChild(statEl(Math.round(overall), "Overall skin score"));
    if (skinAge !== null) summaryEl.appendChild(statEl(skinAge, "Estimated skin age"));
  } else {
    summaryEl.hidden = true;
  }

  if (!metrics.length) {
    metricsEl.innerHTML = "<p>No score fields came back in the response.</p>";
  }
  for (const m of metrics) {
    const row = document.createElement("div");
    row.className = "metric";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = m.label;
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `${Math.round(m.ui)} / 100`;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.style.width = `${Math.max(0, Math.min(100, m.ui))}%`;
    bar.appendChild(fill);
    row.append(name, score, bar);
    if (m.maskUrl) {
      const link = document.createElement("a");
      link.className = "mask";
      link.href = m.maskUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "View detection overlay";
      row.appendChild(link);
    }
    metricsEl.appendChild(row);
  }

  for (const step of nextSteps(metrics)) {
    const li = document.createElement("li");
    const strong = document.createElement("span");
    strong.className = "concern";
    strong.textContent = `${step.label}: `;
    li.append(strong, document.createTextNode(step.text));
    nextStepsEl.appendChild(li);
  }

  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: "smooth" });
}

function statEl(value, label) {
  const div = document.createElement("div");
  div.className = "stat";
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = value;
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = label;
  div.append(num, lbl);
  return div;
}

// ---- routine check: rule-based next steps ---------------------------------
// General information only. No medical claims, no product efficacy claims.

const SUGGESTIONS = {
  moisture: "Skin that reads dry often benefits from a gentle, fragrance-free moisturizer applied after washing, plus drinking water regularly through the day.",
  wrinkle: "Daily broad-spectrum sunscreen and consistent sleep are common habits people use to support skin's appearance over time.",
  pore: "Gentle cleansing once or twice a day, and avoiding heavy products that feel like they sit on the skin, are common first steps for visible pores.",
  texture: "A gentle exfoliant once or twice a week is a common routine step for rough texture. Harsh scrubs can irritate, so gentle is the usual advice.",
  acne: "Keeping the routine simple and avoiding picking or squeezing are common basics. For breakouts that persist, a dermatologist can advise in person.",
  oiliness: "A gentle cleanser and a lightweight, oil-free moisturizer are common choices when skin reads oily.",
  redness: "Fragrance-free, gentle products and daily sun protection are common ways people reduce the triggers that make redness more visible.",
  age_spot: "Daily sunscreen is the most commonly recommended habit for visible spots, since sun exposure can make them more noticeable.",
  spot: "Daily sunscreen is the most commonly recommended habit for visible spots, since sun exposure can make them more noticeable.",
  radiance: "Regular sleep, hydration, and consistent gentle cleansing are common habits linked with brighter-looking skin.",
  firmness: "Sun protection and consistent moisturizing are commonly cited habits for supporting how firm skin looks over time.",
  dark_circle: "Sleep, hydration, and sun protection are common first checks when the under-eye area looks dark in photos.",
  eye_bag: "Sleep and going easy on salty food late in the day are common habits people try for morning under-eye puffiness.",
  droopy_upper_eyelid: "Eyelid appearance is an area where an in-person professional can give the most relevant guidance.",
  droopy_lower_eyelid: "Eyelid appearance is an area where an in-person professional can give the most relevant guidance.",
};

function suggestionFor(key) {
  const base = key.split(":")[0].replace(/^hd_/, "").replace(/_v2$/, "");
  return SUGGESTIONS[key] || SUGGESTIONS[base] ||
    "Consistent gentle cleansing, moisturizing, and daily sun protection are the common basics for this area. A dermatologist can advise on anything specific.";
}

// Metrics arrive sorted lowest first; the lowest scores are the concerns.
function nextSteps(metrics) {
  return metrics.slice(0, 3).map((m) => ({ label: m.label, text: suggestionFor(m.key) }));
}
