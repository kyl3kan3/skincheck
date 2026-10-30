// SkinCheck — POST /api/skin
//
// Forwards a face photo to the Perfect Corp YouCam AI Skin Analysis API
// (V2 flow, documented in ../../api-notes.md):
//   1. POST /s2s/v2.0/file/skin-analysis   -> file_id + pre-signed PUT URL
//   2. PUT  raw image bytes to the pre-signed URL
//   3. POST /s2s/v2.0/task/skin-analysis   -> task_id
//   4. GET  /s2s/v2.0/task/skin-analysis/<task_id>  (poll until success/error)
//
// Auth: `Authorization: Bearer <YOUCAM_API_KEY>` (V2 has no separate auth
// call and no secret; YOUCAM_API_SECRET is accepted in env for forward
// compatibility but is not sent anywhere by the V2 flow).
//
// Request body (JSON):
//   { "image": "<base64 or data URL>", "contentType": "image/jpeg",
//     "dst_actions": ["wrinkle", "pore", ...] }        // start a new task
//   { "task_id": "<id from a previous response>" }     // keep polling
//
// Response: the YouCam task result JSON, normalized so `data.results.output`
// is an array of { type, ui_score, raw_score, mask_urls }, plus
// `data.score_info` when the API provides it, plus `task_id` while running.
//
// Mock mode: if MOCK_SKIN=1 or YOUCAM_API_KEY is not set, returns a
// clearly labeled mock response in the documented response shape so the
// UI can be built and demoed before a key exists.

const API_BASE = process.env.YOUCAM_API_BASE || "https://yce-api-01.makeupar.com";
const FEATURE = "skin-analysis";

// SD concerns only — SD and HD dst_actions must never be mixed in one call.
const ALLOWED_ACTIONS = new Set([
  "wrinkle", "pore", "texture", "acne", "moisture", "oiliness", "redness",
  "age_spot", "radiance", "firmness", "eye_bag", "dark_circle_v2",
  "droopy_upper_eyelid", "droopy_lower_eyelid",
]);
const DEFAULT_ACTIONS = [
  "wrinkle", "pore", "texture", "acne", "moisture", "oiliness", "redness",
  "age_spot", "radiance", "firmness", "eye_bag", "dark_circle_v2",
];

const POLL_INTERVAL_MS = 3000;
const POLL_BUDGET_MS = 45000; // stay inside the serverless time limit

function mockResponse() {
  // Shaped from the documented SD sample in api-notes.md. Scores invented
  // for demo purposes only; the UI labels them as demo data.
  const scores = {
    wrinkle:        { raw_score: 36.09, ui_score: 60 },
    moisture:       { raw_score: 48.69, ui_score: 70 },
    oiliness:       { raw_score: 60.74, ui_score: 72 },
    redness:        { raw_score: 72.01, ui_score: 77 },
    radiance:       { raw_score: 76.57, ui_score: 79 },
    eye_bag:        { raw_score: 76.67, ui_score: 79 },
    dark_circle_v2: { raw_score: 80.19, ui_score: 76 },
    texture:        { raw_score: 80.09, ui_score: 76 },
    age_spot:       { raw_score: 83.23, ui_score: 77 },
    pore:           { raw_score: 88.38, ui_score: 84 },
    firmness:       { raw_score: 89.66, ui_score: 85 },
    acne:           { raw_score: 92.29, ui_score: 88 },
  };
  const score_info = {};
  for (const [type, s] of Object.entries(scores)) {
    score_info[type] = { ...s, output_mask_name: `${type}_output.png` };
  }
  score_info.all = { score: 75.76 };
  score_info.skin_age = 37;

  return {
    status: 200,
    mock: true,
    data: {
      task_status: "success",
      results: {
        output: Object.entries(scores).map(([type, s]) => ({
          type,
          ui_score: s.ui_score,
          raw_score: s.raw_score,
          mask_urls: [],
        })),
      },
      score_info,
    },
  };
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${process.env.YOUCAM_API_KEY}`, ...extra };
}

async function fetchWithRetry(url, options, timeoutMs) {
  // One retry on network-level failure: this sandbox's egress proxy was
  // observed stalling POSTs intermittently (a bare fetch hung the full
  // 300s undici default). Explicit timeouts make a stall fail fast and
  // the retry usually lands on a healthy connection.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function youcam(path, options) {
  const res = await fetchWithRetry(`${API_BASE}${path}`, options, 30000);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { status: res.status, error: text }; }
  if (!res.ok) {
    const err = new Error(json.error || `YouCam API error (HTTP ${res.status})`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function getTask(taskId) {
  return youcam(`/s2s/v2.0/task/${FEATURE}/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: authHeaders({ "Content-Type": "application/json" }),
  });
}

async function pollTask(taskId) {
  const deadline = Date.now() + POLL_BUDGET_MS;
  for (;;) {
    const result = await getTask(taskId);
    const status = result?.data?.task_status;
    if (status === "success" || status === "error") {
      return { ...result, task_id: taskId };
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      // Still running: hand the task_id back so the client can re-POST
      // with { task_id } and keep polling without spending another unit.
      return { status: 200, data: { task_status: status || "running" }, task_id: taskId };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function startTask(imageBuffer, contentType, dstActions) {
  // Step 1: declare the file.
  const fileName = `skincheck.${contentType === "image/png" ? "png" : "jpg"}`;
  const fileRes = await youcam(`/s2s/v2.0/file/${FEATURE}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      files: [{ content_type: contentType, file_name: fileName, file_size: imageBuffer.length }],
    }),
  });
  const file = fileRes?.data?.files?.[0];
  const uploadReq = file?.requests?.[0];
  if (!file?.file_id || !uploadReq?.url) {
    throw new Error("YouCam File API did not return a file_id and upload URL");
  }

  // Step 2: PUT the raw bytes to the pre-signed URL.
  const putRes = await fetchWithRetry(uploadReq.url, {
    method: uploadReq.method || "PUT",
    headers: uploadReq.headers || { "Content-Type": contentType },
    body: imageBuffer,
  }, 60000);
  if (!putRes.ok) throw new Error(`Image upload to YouCam storage failed (HTTP ${putRes.status})`);

  // Step 3: create the task.
  const taskRes = await youcam(`/s2s/v2.0/task/${FEATURE}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      src_file_id: file.file_id,
      dst_actions: dstActions,
      miniserver_args: { enable_mask_overlay: false },
      format: "json",
    }),
  });
  const taskId = taskRes?.data?.task_id;
  if (!taskId) throw new Error("YouCam Task API did not return a task_id");
  return taskId;
}

function decodeImage(image, contentType) {
  if (typeof image !== "string" || !image) return null;
  let b64 = image;
  let type = contentType;
  const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (m) { type = m[1]; b64 = m[2]; }
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length) return null;
  return { buffer, contentType: type || "image/jpeg" };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const mock = process.env.MOCK_SKIN === "1" || !process.env.YOUCAM_API_KEY;
  if (mock) {
    res.status(200).json(mockResponse());
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (body.task_id) {
      res.status(200).json(await pollTask(String(body.task_id)));
      return;
    }

    const decoded = decodeImage(body.image, body.contentType);
    if (!decoded) {
      res.status(400).json({ error: "Missing or undecodable image (base64 expected)" });
      return;
    }
    if (decoded.buffer.length > 10 * 1024 * 1024) {
      res.status(400).json({ error: "Image exceeds the YouCam 10MB limit" });
      return;
    }

    let dstActions = DEFAULT_ACTIONS;
    if (Array.isArray(body.dst_actions) && body.dst_actions.length) {
      const filtered = body.dst_actions.filter((a) => ALLOWED_ACTIONS.has(a));
      if (filtered.length) dstActions = filtered;
    }

    const taskId = await startTask(decoded.buffer, decoded.contentType, dstActions);
    res.status(200).json(await pollTask(taskId));
  } catch (err) {
    res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502)
      .json({ error: err.message || "Skin analysis failed", detail: err.payload || undefined });
  }
};
