module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const hasServerKey = Boolean(
    (process.env.GEMINI_API_KEY || '').trim() ||
    (process.env.OPENAI_API_KEY || '').trim() ||
    (process.env.GROQ_API_KEY || '').trim() ||
    (process.env.ANTHROPIC_API_KEY || '').trim()
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, hasServerKey }));
};
