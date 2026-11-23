const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 8000;
const FRONTEND_DIR = path.join(__dirname, 'frontend');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml'
};

const STATS_FILE = path.join(__dirname, 'operator_stats.json');

function rebuildDailyStatsFromLogs(stats) {
  stats.dailyStats = {};
  if (!stats.logs) return;

  stats.logs.forEach(log => {
    const dStr = log.dateStr || (log.timestamp ? log.timestamp.split('T')[0] : new Date().toISOString().split('T')[0]);
    if (!stats.dailyStats[dStr]) {
      stats.dailyStats[dStr] = {
        dateStr: dStr,
        totalFiles: 0,
        totalPages: 0,
        totalBlanks: 0,
        operators: {}
      };
    }
    const ds = stats.dailyStats[dStr];
    ds.totalFiles += 1;
    ds.totalPages += (log.pageCount || 1);
    ds.totalBlanks += (log.blanksRemoved || 0);

    const opName = log.operatorName || 'Operator';
    if (!ds.operators[opName]) {
      ds.operators[opName] = { files: 0, pages: 0, blanks: 0 };
    }
    ds.operators[opName].files += 1;
    ds.operators[opName].pages += (log.pageCount || 1);
    ds.operators[opName].blanks += (log.blanksRemoved || 0);
  });
}

function getStatsFilePath() {
  if (process.env.VERCEL) {
    return path.join('/tmp', 'operator_stats.json');
  }
  return STATS_FILE;
}

function loadOperatorStats() {
  const todayStr = new Date().toISOString().split('T')[0];
  let stats = {
    totalFilesProcessed: 0,
    totalPagesProcessed: 0,
    totalBlanksRemoved: 0,
    operators: {},
    dailyStats: {},
    logs: []
  };

  const targetPath = getStatsFilePath();
  const sourcePath = fs.existsSync(targetPath) ? targetPath : STATS_FILE;

  if (fs.existsSync(sourcePath)) {
    try {
      const data = fs.readFileSync(sourcePath, 'utf8');
      stats = JSON.parse(data);
      if (!stats.operators) stats.operators = {};
      if (!stats.logs) stats.logs = [];
      if (!stats.dailyStats) stats.dailyStats = {};
    } catch (e) {
      console.error('[Stats Error] Failed to read operator_stats.json:', e);
    }
  }

  // Rebuild dailyStats if missing or out of sync
  rebuildDailyStatsFromLogs(stats);

  // Check daily reset for operators
  let updated = false;
  for (const opKey in stats.operators) {
    const op = stats.operators[opKey];
    if (op.lastResetDate !== todayStr) {
      op.filesProcessedToday = 0;
      op.lastResetDate = todayStr;
      updated = true;
    }
  }

  if (updated) {
    try { fs.writeFileSync(targetPath, JSON.stringify(stats, null, 2)); } catch(e){}
  }

  return stats;
}

function recordProcessedFile(logData) {
  const stats = loadOperatorStats();
  const todayStr = new Date().toISOString().split('T')[0];
  const opName = (logData.operatorName || 'Default Operator').trim();
  const pageCount = parseInt(logData.pageCount || 1, 10);
  const blanksRemoved = parseInt(logData.blanksRemoved || 0, 10);

  if (!stats.operators[opName]) {
    stats.operators[opName] = {
      name: opName,
      filesProcessedToday: 0,
      totalFilesProcessed: 0,
      totalPagesProcessed: 0,
      totalBlanksRemoved: 0,
      lastActive: new Date().toISOString(),
      lastResetDate: todayStr
    };
  }

  const op = stats.operators[opName];
  if (op.lastResetDate !== todayStr) {
    op.filesProcessedToday = 0;
    op.lastResetDate = todayStr;
  }

  op.filesProcessedToday += 1;
  op.totalFilesProcessed += 1;
  op.totalPagesProcessed += pageCount;
  op.totalBlanksRemoved += blanksRemoved;
  op.lastActive = new Date().toISOString();

  stats.totalFilesProcessed += 1;
  stats.totalPagesProcessed += pageCount;
  stats.totalBlanksRemoved += blanksRemoved;

  // Maintain Date-Wise Daily Stats
  if (!stats.dailyStats) stats.dailyStats = {};
  if (!stats.dailyStats[todayStr]) {
    stats.dailyStats[todayStr] = {
      dateStr: todayStr,
      totalFiles: 0,
      totalPages: 0,
      totalBlanks: 0,
      operators: {}
    };
  }
  const ds = stats.dailyStats[todayStr];
  ds.totalFiles += 1;
  ds.totalPages += pageCount;
  ds.totalBlanks += blanksRemoved;

  if (!ds.operators[opName]) {
    ds.operators[opName] = { files: 0, pages: 0, blanks: 0 };
  }
  ds.operators[opName].files += 1;
  ds.operators[opName].pages += pageCount;
  ds.operators[opName].blanks += blanksRemoved;

  const logEntry = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    timestamp: new Date().toISOString(),
    dateStr: todayStr,
    operatorName: opName,
    fileName: path.basename(logData.targetPath || logData.fileName || 'document.pdf'),
    targetPath: logData.targetPath || '',
    pageCount: pageCount,
    blanksRemoved: blanksRemoved,
    saveMode: logData.saveMode || 'auto'
  };

  stats.logs.unshift(logEntry);
  if (stats.logs.length > 2000) stats.logs = stats.logs.slice(0, 2000);

  try {
    fs.writeFileSync(getStatsFilePath(), JSON.stringify(stats, null, 2));
    console.log(`[Operator Stats] Recorded file save for '${opName}'. Today: ${op.filesProcessedToday}, Total: ${op.totalFilesProcessed}`);
  } catch (err) {
    console.error('[Operator Stats Error] Failed to write stats:', err.message);
  }

  return { stats, logEntry };
}

const HOSPITAL_VISION_PROMPT = `You are a medical record digitization expert analyzing one scanned page from a Railway Hospital (e.g., North Central Railway Central Hospital) patient file.

Analyze the image carefully and return ONLY valid JSON with this exact schema:
{
  "is_blank": false,
  "is_medical_media": false,
  "page_type": "ADMISSION_CARD | DISCHARGE_SUMMARY | LAB_REPORT | ECG | XRAY_SCAN | CLINICAL_NOTES | SICK_MEMO | CONSENT_FORM | OTHER",
  "suggested_rotation": 0,
  "scan_clarity": "clear | unclear",
  "clarity_reason": "",
  "patient_details": {
    "category": "Employee | Family | Retired | Unknown",
    "name": "",
    "age": "",
    "gender": "Male | Female | Other | Unknown",
    "cr_no": "",
    "patient_code": "",
    "admission_date": ""
  }
}

CRITICAL RULES:
1. BLANK DETECTION (is_blank):
   - Set is_blank = true ONLY if the page is genuinely blank white paper, has only tiny scanner dust/specks, or is a completely empty/unfilled blank sheet.
   - NEVER mark ECG strips, X-ray films, CT/MRI/USG scans, lab reports, handwritten clinical notes, vital charts, sick memos, consent forms, discharge summaries, or admission cards as blank!
   - If the page is an ECG strip, X-ray, ultrasound, CT/MRI, or imaging scan, set "is_medical_media": true and "is_blank": false.

2. ROTATION (suggested_rotation):
   - Determine the CLOCKWISE rotation in degrees (0, 90, 180, or 270) needed to make the page text/content upright and readable.
   - 0 = already upright, 90 = rotated 90° counter-clockwise (needs 90° clockwise), 180 = upside down, 270 = rotated 90° clockwise (needs 270° clockwise).

3. PAGE TYPE (page_type):
   - "ADMISSION_CARD": Has "ADMISSION CARD" header (front page of a patient's file).
   - "DISCHARGE_SUMMARY": Has "Discharge Summary".
   - "LAB_REPORT": Department of Laboratory Medicine / Hematology / Biochemistry / Serology.
   - "ECG": Electrocardiogram grid/waveform strip.
   - "XRAY_SCAN": X-ray, CT, MRI, USG, or radiology scan/report.
   - "SICK_MEMO": "SICK MEMO" / "बीमारी का मीमो".
   - "CONSENT_FORM": Consent for Anaesthesia / Surgery.
   - "CLINICAL_NOTES": Handwritten doctor notes, prescriptions (Rx), or Vital Chart.
   - "OTHER": Anything else.

4. PATIENT DETAILS (extract whenever visible on ADMISSION_CARD, DISCHARGE_SUMMARY, LAB_REPORT, SICK_MEMO, etc.):
   - "category":
     * "Employee" if EMPLOYEE, EMPLOYEE(GENERAL), SELF, Central Govt Employee, or active duty Sick Memo.
     * "Family" if FAMILY, DEPENDENT, DEPENDANT, SPOUSE, WIFE, HUSBAND, SON, DAUGHTER, FATHER, MOTHER, or dependent relation.
     * "Retired" if RETIRED, RELHS, PENSIONER, PPO, or EX-EMPLOYEE.
     * "Unknown" if unclear or not determinable.
   - "name": Patient's full name (e.g. "DASRATH LAL").
   - "age": Digits only (e.g. "43" from "43 YR/M").
   - "gender": "Male" (M), "Female" (F), "Other" (O), or "Unknown".
   - "cr_no": CR Number (e.g. "991922300044279"). Leave empty if not present.
   - "patient_code": Fallback Patient Code, IPD No, Admission No, or handwritten U-code if CR No is missing or as secondary ID.
   - "admission_date": Admission Date (ADM DATE / D.O.A.) normalized to YYYY-MM-DD (e.g. "21-AUG-2023" -> "2023-08-21"). Leave empty if unclear.

5. SCAN CLARITY (scan_clarity):
   - Set "unclear" if this is an ADMISSION_CARD (or key identity page) whose text is blurry, cut off, heavily smudged, or illegible; otherwise "clear". Provide a brief "clarity_reason" if "unclear".`;

function extractJsonFromText(text) {
  if (!text) throw new Error('Empty AI response');
  let cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }
  return JSON.parse(cleaned);
}

function httpsPostJson(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      },
      timeout: 45000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from AI API: ${e.message}`));
          }
        } else {
          reject(new Error(`AI API HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('AI API request timed out'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callVisionAI(imageBase64, provider = 'gemini', apiKey = '', model = '') {
  const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|webp);base64,/i, '');
  const mimeType = imageBase64.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
  const prov = (provider || 'gemini').toLowerCase().trim();

  if (prov === 'gemini') {
    const mod = model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mod)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const data = await httpsPostJson(url, {
      contents: [{
        parts: [
          { text: HOSPITAL_VISION_PROMPT },
          { inline_data: { mime_type: mimeType, data: cleanBase64 } }
        ]
      }],
      generationConfig: { response_mime_type: 'application/json', temperature: 0 }
    });
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return extractJsonFromText(textOut);
  }

  if (prov === 'openai' || prov === 'groq' || prov === 'openrouter') {
    const endpointMap = {
      openai: 'https://api.openai.com/v1/chat/completions',
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions'
    };
    const defaultModelMap = {
      openai: 'gpt-4o-mini',
      groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
      openrouter: 'google/gemini-2.5-flash'
    };
    const mod = model || defaultModelMap[prov];
    const body = {
      model: mod,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: HOSPITAL_VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${cleanBase64}` } }
        ]
      }]
    };
    if (prov !== 'openrouter') {
      body.response_format = { type: 'json_object' };
    }
    const data = await httpsPostJson(endpointMap[prov], body, {
      Authorization: `Bearer ${apiKey}`
    });
    const textOut = data?.choices?.[0]?.message?.content;
    return extractJsonFromText(textOut);
  }

  if (prov === 'anthropic') {
    const mod = model || 'claude-3-5-sonnet-20241022';
    const data = await httpsPostJson('https://api.anthropic.com/v1/messages', {
      model: mod,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: cleanBase64 } },
          { type: 'text', text: HOSPITAL_VISION_PROMPT }
        ]
      }]
    }, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    });
    const textOut = data?.content?.[0]?.text;
    return extractJsonFromText(textOut);
  }

  throw new Error(`Unsupported AI provider: ${provider}`);
}

function requestHandler(req, res) {
  // CORS Headers to allow requests from Vercel web app or local client
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = req.url.split('?')[0];

  // API Endpoint: GET /api/operator-stats
  if (req.method === 'GET' && reqUrl === '/api/operator-stats') {
    const stats = loadOperatorStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, stats }));
    return;
  }

  // API Endpoint: POST /api/log-processed-file
  if (req.method === 'POST' && reqUrl === '/api/log-processed-file') {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(bodyData);
        const { stats, logEntry } = recordProcessedFile(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, stats, logEntry }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: POST /api/reset-operator-stats
  if (req.method === 'POST' && reqUrl === '/api/reset-operator-stats') {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(bodyData || '{}');
        const stats = loadOperatorStats();
        const todayStr = new Date().toISOString().split('T')[0];
        
        if (payload.resetMode === 'all') {
          stats.totalFilesProcessed = 0;
          stats.totalPagesProcessed = 0;
          stats.totalBlanksRemoved = 0;
          stats.operators = {};
          stats.logs = [];
        } else if (payload.operatorName && stats.operators[payload.operatorName]) {
          stats.operators[payload.operatorName].filesProcessedToday = 0;
        } else {
          for (const opKey in stats.operators) {
            stats.operators[opKey].filesProcessedToday = 0;
            stats.operators[opKey].lastResetDate = todayStr;
          }
        }

        try { fs.writeFileSync(getStatsFilePath(), JSON.stringify(stats, null, 2)); } catch(e){}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, stats }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: POST /api/admin/delete-operator
  if (req.method === 'POST' && reqUrl === '/api/admin/delete-operator') {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(bodyData || '{}');
        const stats = loadOperatorStats();
        if (payload.operatorName && stats.operators[payload.operatorName]) {
          delete stats.operators[payload.operatorName];
          try { fs.writeFileSync(getStatsFilePath(), JSON.stringify(stats, null, 2)); } catch(e){}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, stats }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: Direct Local Disk Auto-Saver
  if (req.method === 'POST' && reqUrl === '/api/save-to-disk') {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(bodyData);
        const { targetPath, pdfBase64, operatorName, pageCount, blanksRemoved } = payload;

        if (!targetPath || !pdfBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing targetPath or pdfBase64 data' }));
          return;
        }

        // Clean and normalize target directory path
        let targetPathClean = (targetPath || "").trim().replace(/^["']+|["']+$|\.lnk$/gi, '');
        targetPathClean = path.normalize(targetPathClean);
        const parentDir = path.dirname(targetPathClean);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        const buffer = Buffer.from(pdfBase64, 'base64');
        fs.writeFileSync(targetPathClean, buffer);

        console.log(`[Auto-Save] Successfully saved PDF file directly to disk: ${targetPathClean}`);
        
        let statsResult = null;
        if (operatorName) {
          statsResult = recordProcessedFile({
            operatorName,
            targetPath: targetPathClean,
            pageCount,
            blanksRemoved,
            saveMode: 'auto'
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          savedPath: targetPathClean,
          stats: statsResult ? statsResult.stats : null
        }));
      } catch (err) {
        console.error('[Auto-Save Error]:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: AI Vision Page Analyzer (Blank, Rotation, Admission Card Boundary & Patient Details)
  if (req.method === 'POST' && reqUrl === '/api/ai-analyze-page') {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(bodyData || '{}');
        const { imageBase64, provider = 'gemini', apiKey = '', model = '' } = payload;

        if (!imageBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing imageBase64' }));
          return;
        }

        const resolvedKey = (apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
        if (!resolvedKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing AI API Key. Please configure it in AI Settings.' }));
          return;
        }

        const analysis = await callVisionAI(imageBase64, provider, resolvedKey, model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, analysis }));
      } catch (err) {
        console.error('[AI Analyze Error]:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Return 404 JSON for any unhandled /api/ endpoints
  if (reqUrl.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
    return;
  }

  let reqPath = reqUrl;
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  // Support /static/ prefix or direct file path
  let filePath = path.join(FRONTEND_DIR, reqPath.replace(/^\/static\//, '/'));
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, reqPath.replace(/^\/static\//, '/'));
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(FRONTEND_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server Error: ' + err.code);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
}

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}/`;
    console.log('='.repeat(60));
    console.log(' ⚡ PDF CleanSpace - Node.js Local Web Server');
    console.log('='.repeat(60));
    console.log(` Server running at: ${url}`);
    console.log(' Direct Local Disk Saver Active: /api/save-to-disk');
    console.log(' Press Ctrl+C to stop the server.');
    console.log('='.repeat(60));

    const startCmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(startCmd, (err) => {
      if (err) {
        console.log(`Open your web browser manually at: ${url}`);
      }
    });
  });
}

module.exports = requestHandler;
module.exports.server = server;
