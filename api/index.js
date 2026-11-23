const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join('/tmp', 'operator_stats.json');

function loadStats() {
  let stats = {
    totalFilesProcessed: 0,
    totalPagesProcessed: 0,
    totalBlanksRemoved: 0,
    operators: {},
    dailyStats: {},
    logs: []
  };
  if (fs.existsSync(STATS_FILE)) {
    try {
      stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    } catch (e) {}
  }
  return stats;
}

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const reqUrl = (req.url || '').split('?')[0];

  if (req.method === 'GET') {
    const stats = loadStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, stats }));
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const stats = loadStats();
        const todayStr = new Date().toISOString().split('T')[0];
        const opName = (payload.operatorName || 'Default Operator').trim();
        const pageCount = parseInt(payload.pageCount || 1, 10);
        const blanksRemoved = parseInt(payload.blanksRemoved || 0, 10);

        if (!stats.operators) stats.operators = {};
        if (!stats.logs) stats.logs = [];
        if (!stats.dailyStats) stats.dailyStats = {};

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
          fileName: path.basename(payload.targetPath || payload.fileName || 'document.pdf'),
          targetPath: payload.targetPath || '',
          pageCount: pageCount,
          blanksRemoved: blanksRemoved,
          saveMode: payload.saveMode || 'auto'
        };

        stats.logs.unshift(logEntry);
        if (stats.logs.length > 2000) stats.logs = stats.logs.slice(0, 2000);

        try {
          fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
        } catch (e) {}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, stats, logEntry }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
};
