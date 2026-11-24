const https = require('https');

const HOSPITAL_VISION_PROMPT = `You are a medical record digitization expert analyzing one scanned page from a Railway Hospital (e.g., North Central Railway Central Hospital) patient file.

Analyze the image carefully and return ONLY valid JSON with this exact schema:
{
  "is_blank": false,
  "is_medical_media": false,
  "page_type": "ADMISSION_CARD | DISCHARGE_SUMMARY | LAB_REPORT | ECG | XRAY_SCAN | CLINICAL_NOTES | SICK_MEMO | CONSENT_FORM | OTHER",
  "header_position": "top | right | bottom | left",
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

2. ROTATION (header_position & suggested_rotation):
   - First determine where the TOP of the text/heading is currently pointing in the image:
     * "top": text is normal and upright -> suggested_rotation = 0
     * "left": page is tilted 90° counter-clockwise (top of text is on the LEFT edge) -> suggested_rotation = 90
     * "bottom": page is upside down (top of text is at the BOTTOM edge) -> suggested_rotation = 180
     * "right": page is tilted 90° clockwise (top of text is on the RIGHT edge, like sideways ECGs) -> suggested_rotation = 270
   - Set "header_position" and "suggested_rotation" (0, 90, 180, or 270) consistently.

3. PAGE TYPE (page_type):
   - "ADMISSION_CARD": Any Admission Card / Admission Form / PatientAdmission sheet (typically has "ADMISSION CARD", "CR NO", "IPD NO", "ADM DATE", "CATEGORY").
   - "DISCHARGE_SUMMARY", "LAB_REPORT", "ECG", "XRAY_SCAN", "SICK_MEMO", "CONSENT_FORM", "CLINICAL_NOTES", or "OTHER".

4. PATIENT DETAILS:
   - "category": Check BOTH the top-left header and the "CATEGORY :" / "Patient Category :" line carefully:
     * "Family": If it says FAMILY, DEPENDENT, DEPENDANT, SPOUSE, WIFE, HUSBAND, SON, DAUGHTER, FATHER, MOTHER, CHILD, or any relation (W/O, S/O, D/O, C/O), EVEN IF combined with Employee or Retired/RELHS (e.g. "EMPLOYEE(FAMILY)" or "RELHS(FAMILY)").
     * "Retired": If it says RETIRED, RELHS, PENSIONER, EX-EMPLOYEE, or PPO (and NOT Family/Dependent).
     * "Employee": If it says EMPLOYEE(GENERAL), EMPLOYEE, SELF, or Central Govt Employee (and NOT Family/Dependent or Retired).
     * "Unknown": Only if genuinely unreadable.
   - "name", "age" (digits only), "gender" ("Male"/"Female"/"Other"/"Unknown"), "cr_no", "patient_code" (fallback ID if CR No missing), "admission_date" (YYYY-MM-DD).

5. SCAN CLARITY (scan_clarity):
   - Set "unclear" if this is an ADMISSION_CARD (or key identity page) whose text is blurry, cut off, heavily smudged, or illegible; otherwise "clear".`;

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
    req.on('timeout', () => req.destroy(new Error('AI API request timed out')));
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
    const candidates = [model, 'gemini-3.8-flash', 'gemini-2.5-flash'].filter(Boolean);
    const uniqueModels = [...new Set(candidates)];
    let lastErr = null;
    for (const mod of uniqueModels) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
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
          return extractJsonFromText(data?.candidates?.[0]?.content?.parts?.[0]?.text);
        } catch (err) {
          lastErr = err;
          if (!String(err.message).includes('503') && !String(err.message).includes('429')) break;
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    }
    throw lastErr || new Error('Gemini API call failed');
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
    const body = {
      model: model || defaultModelMap[prov],
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: HOSPITAL_VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${cleanBase64}` } }
        ]
      }]
    };
    if (prov !== 'openrouter') body.response_format = { type: 'json_object' };
    const data = await httpsPostJson(endpointMap[prov], body, { Authorization: `Bearer ${apiKey}` });
    return extractJsonFromText(data?.choices?.[0]?.message?.content);
  }

  if (prov === 'anthropic') {
    const data = await httpsPostJson('https://api.anthropic.com/v1/messages', {
      model: model || 'claude-3-5-sonnet-20241022',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: cleanBase64 } },
          { type: 'text', text: HOSPITAL_VISION_PROMPT }
        ]
      }]
    }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
    return extractJsonFromText(data?.content?.[0]?.text);
  }

  throw new Error(`Unsupported AI provider: ${provider}`);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  let bodyData = '';
  req.on('data', chunk => { bodyData += chunk; });
  req.on('end', async () => {
    try {
      const payload = JSON.parse(bodyData || '{}');
      const { imageBase64, provider = 'gemini', apiKey = '', model = '' } = payload;
      if (!imageBase64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing imageBase64' }));
      }
      const resolvedKey = (apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
      if (!resolvedKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing AI API Key. Configure it in AI Settings.' }));
      }
      const analysis = await callVisionAI(imageBase64, provider, resolvedKey, model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, analysis }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  });
};

