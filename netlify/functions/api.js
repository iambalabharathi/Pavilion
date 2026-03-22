const fs = require('fs');
const path = require('path');

// ========== File-based data (bundled in deploy) ==========
function resolveDataDir() {
  const candidates = [
    path.join(__dirname, 'data'),
    path.join(__dirname, '..', 'data'),
    path.join(__dirname, '..', '..', 'data'),
    path.join(process.cwd(), 'data'),
    '/var/task/data',
    '/var/task/src/data',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

const DATA_DIR = resolveDataDir();

// ========== Helpers ==========
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ========== File-based config & players ==========
function getConfig() {
  if (!DATA_DIR) return { name: 'Pavilion' };
  const configPath = path.join(DATA_DIR, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { name: raw.name || 'Pavilion' };
    }
  } catch {}
  return { name: 'Pavilion' };
}

function getPlayers() {
  if (!DATA_DIR) return [];
  const playersPath = path.join(DATA_DIR, 'players-cache.json');
  try {
    if (fs.existsSync(playersPath)) {
      return JSON.parse(fs.readFileSync(playersPath, 'utf8')) || [];
    }
  } catch {}
  return [];
}

function getTeams(players) {
  return [...new Set(players.map(p => p.fantasyTeam))];
}

// ========== CSV Match Loading ==========
function parseCSVMatch(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n');
  let title = '', date = '', abandoned = false;
  const players = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      if (!title && /^#\s+\w+\s+vs\s+\w+/.test(trimmed)) title = trimmed.replace(/^#\s*/, '');
      if (!date && /^#\s+\d{4}-\d{2}-\d{2}/.test(trimmed)) date = trimmed.replace(/^#\s*/, '').trim();
      if (/abandoned/i.test(trimmed)) abandoned = true;
      continue;
    }
    const cols = trimmed.split(',').map(c => c.trim());
    if (cols.length < 17) continue;
    const id = parseInt(cols[0]);
    if (isNaN(id)) continue;
    const playing = parseInt(cols[4]) === 1;
    const mom = parseInt(cols[5]) === 1;
    const runs = parseInt(cols[6]) || 0;
    const fours = parseInt(cols[7]) || 0;
    const sixes = parseInt(cols[8]) || 0;
    const wickets = parseInt(cols[9]) || 0;
    const dots = parseInt(cols[10]) || 0;
    const maidens = parseInt(cols[11]) || 0;
    const lbwBowledHw = parseInt(cols[12]) || 0;
    const catches = parseInt(cols[13]) || 0;
    const runoutDirect = parseInt(cols[14]) || 0;
    const runoutIndirect = parseInt(cols[15]) || 0;
    const stumpings = parseInt(cols[16]) || 0;
    const hasStats = playing || mom || runs || fours || sixes || wickets || dots || maidens || lbwBowledHw || catches || runoutDirect || runoutIndirect || stumpings;
    if (!hasStats) continue;
    players[id] = {
      playing, mom,
      batting: { runs, fours, sixes },
      bowling: { wickets, dots, maidens, lbwBowledHw },
      fielding: { catches, runoutDirect, runoutIndirect, stumpings }
    };
  }
  const basename = path.basename(filepath, '.csv');
  const matchId = basename.replace('match-', '');
  return { id: matchId, title: title || basename, date, abandoned, players };
}

function getMatchFiles() {
  if (!DATA_DIR) return [];
  const dir = path.join(DATA_DIR, 'matches');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort();
}

function loadMatch(filename) {
  return parseCSVMatch(path.join(DATA_DIR, 'matches', filename));
}

function loadAllMatches() {
  return getMatchFiles().map(f => loadMatch(f));
}

// ========== Points Calculation ==========
function calcBattingPoints(stats) {
  let pts = 0; const runs = stats.runs || 0;
  pts += runs + (stats.fours || 0) + (stats.sixes || 0) * 2;
  if (runs >= 30) pts += 5; if (runs >= 50) pts += 10; if (runs >= 100) pts += 10;
  return pts;
}
function calcBowlingPoints(stats) {
  let pts = 0; const wickets = stats.wickets || 0;
  pts += (stats.dots || 0) + wickets * 20;
  if (wickets >= 2) pts += 5; if (wickets >= 3) pts += 10; if (wickets >= 5) pts += 10;
  pts += (stats.maidens || 0) * 20 + (stats.lbwBowledHw || 0) * 5;
  return pts;
}
function calcFieldingPoints(stats) {
  return (stats.catches || 0) * 5 + (stats.runoutDirect || 0) * 10 + (stats.runoutIndirect || 0) * 5 + (stats.stumpings || 0) * 10;
}
function calcPlayerMatchPoints(pm) {
  let t = 0;
  if (pm.playing) t += 5;
  if (pm.batting) t += calcBattingPoints(pm.batting);
  if (pm.bowling) t += calcBowlingPoints(pm.bowling);
  if (pm.fielding) t += calcFieldingPoints(pm.fielding);
  if (pm.mom) t += 30;
  return t;
}

// ========== Route Handlers ==========
function handleGetConfig() {
  const config = getConfig();
  const players = getPlayers();
  const teams = getTeams(players);
  return json(200, { configured: players.length > 0, name: config.name, teams });
}

function handlePlayers() {
  return json(200, getPlayers());
}

function handleStandings() {
  const config = getConfig();
  const players = getPlayers();
  const teams = getTeams(players);
  const matches = loadAllMatches();
  const playerPoints = {};
  for (const p of players) playerPoints[p.id] = { total: 0, matchCount: 0, matches: [] };
  for (const match of matches) {
    if (match.abandoned) continue;
    for (const [playerId, stats] of Object.entries(match.players || {})) {
      const pid = parseInt(playerId);
      const pts = calcPlayerMatchPoints(stats);
      if (!playerPoints[pid]) playerPoints[pid] = { total: 0, matchCount: 0, matches: [] };
      playerPoints[pid].total += pts;
      playerPoints[pid].matchCount++;
      playerPoints[pid].matches.push({ matchId: match.id, matchTitle: match.title, points: pts });
    }
  }
  const teamStandings = {};
  for (const team of teams) {
    const teamPlayers = players.filter(p => p.fantasyTeam === team);
    let teamTotal = 0;
    const playerDetails = teamPlayers.map(p => {
      const pp = playerPoints[p.id] || { total: 0, matchCount: 0, matches: [] };
      teamTotal += pp.total;
      return { ...p, points: pp.total, matchCount: pp.matchCount, matchDetails: pp.matches };
    });
    playerDetails.sort((a, b) => b.points - a.points);
    teamStandings[team] = { total: teamTotal, players: playerDetails };
  }
  const sorted = Object.entries(teamStandings).sort((a, b) => b[1].total - a[1].total).map(([team, data], i) => ({ rank: i + 1, team, ...data }));
  return json(200, sorted);
}

function handleMatches() {
  const matches = loadAllMatches();
  return json(200, [...matches].reverse());
}

function handleMatchById(id) {
  const files = getMatchFiles();
  const file = files.find(f => f === `match-${id}.csv`);
  if (!file) return json(404, { error: 'Match not found' });
  return json(200, loadMatch(file));
}

function handleMatchDetail(id) {
  const files = getMatchFiles();
  const file = files.find(f => f === `match-${id}.csv`);
  if (!file) return json(404, { error: 'Match not found' });
  const match = loadMatch(file);
  const players = getPlayers();
  const teams = getTeams(players);
  const teamBreakdown = {};
  for (const team of teams) teamBreakdown[team] = { total: 0, players: [] };
  for (const [playerId, stats] of Object.entries(match.players || {})) {
    const pid = parseInt(playerId);
    const p = players.find(pl => pl.id === pid);
    if (!p) continue;
    const pts = match.abandoned ? 0 : calcPlayerMatchPoints(stats);
    if (teamBreakdown[p.fantasyTeam]) {
      teamBreakdown[p.fantasyTeam].total += pts;
      teamBreakdown[p.fantasyTeam].players.push({ ...p, points: pts, stats });
    }
  }
  for (const team of teams) teamBreakdown[team].players.sort((a, b) => b.points - a.points);
  return json(200, { match, teamBreakdown });
}

function handleDashboard() {
  const config = getConfig();
  const players = getPlayers();
  const teams = getTeams(players);
  const matches = loadAllMatches();
  const playerPoints = {};
  for (const p of players) playerPoints[p.id] = { total: 0, matchCount: 0, bestMatch: 0, bestMatchTitle: '' };
  let totalMatches = 0;
  for (const match of matches) {
    if (match.abandoned) continue;
    totalMatches++;
    for (const [playerId, stats] of Object.entries(match.players || {})) {
      const pid = parseInt(playerId);
      const pts = calcPlayerMatchPoints(stats);
      if (!playerPoints[pid]) playerPoints[pid] = { total: 0, matchCount: 0, bestMatch: 0, bestMatchTitle: '' };
      playerPoints[pid].total += pts;
      playerPoints[pid].matchCount++;
      if (pts > playerPoints[pid].bestMatch) { playerPoints[pid].bestMatch = pts; playerPoints[pid].bestMatchTitle = match.title; }
    }
  }
  const topPlayers = players.map(p => ({ ...p, ...playerPoints[p.id] })).sort((a, b) => b.total - a.total).slice(0, 10);
  let bestPerf = { points: 0 };
  for (const match of matches) {
    if (match.abandoned) continue;
    for (const [playerId, stats] of Object.entries(match.players || {})) {
      const pts = calcPlayerMatchPoints(stats);
      if (pts > bestPerf.points) {
        const p = players.find(pl => pl.id === parseInt(playerId));
        bestPerf = { points: pts, playerName: p ? p.name : 'Unknown', fantasyTeam: p ? p.fantasyTeam : '', matchTitle: match.title, stats };
      }
    }
  }
  const teamTotals = {};
  for (const team of teams) {
    const tp = players.filter(p => p.fantasyTeam === team);
    teamTotals[team] = tp.reduce((sum, p) => sum + (playerPoints[p.id] ? playerPoints[p.id].total : 0), 0);
  }
  const sortedTeams = Object.entries(teamTotals).sort((a, b) => b[1] - a[1]).map(([team, total], i) => ({ rank: i + 1, team, total }));
  return json(200, { totalMatches, totalPlayers: players.length, topPlayers, bestPerformance: bestPerf, teamRankings: sortedTeams, leagueName: config.name });
}

function handlePlayersDetails() {
  const players = getPlayers();
  const matches = loadAllMatches();
  const result = players.map(p => {
    const mb = []; let total = 0;
    for (const match of matches) {
      if (match.abandoned) continue;
      const stats = (match.players || {})[p.id];
      if (!stats) continue;
      const playingPts = stats.playing ? 5 : 0;
      const battingPts = stats.batting ? calcBattingPoints(stats.batting) : 0;
      const bowlingPts = stats.bowling ? calcBowlingPoints(stats.bowling) : 0;
      const fieldingPts = stats.fielding ? calcFieldingPoints(stats.fielding) : 0;
      const momPts = stats.mom ? 30 : 0;
      const mt = playingPts + battingPts + bowlingPts + fieldingPts + momPts;
      total += mt;
      mb.push({ matchId: match.id, matchTitle: match.title, matchDate: match.date, total: mt, playing: playingPts, batting: battingPts, bowling: bowlingPts, fielding: fieldingPts, mom: momPts, stats });
    }
    return { ...p, total, matchCount: mb.length, matches: mb };
  });
  result.sort((a, b) => b.total - a.total);
  return json(200, result);
}

function handleRules() {
  return json(200, {
    playing12: 5,
    batting: { perRun: 1, perFour: 1, perSix: 2, bonus30: 5, bonus50: 10, bonus100: 10 },
    bowling: { perDot: 1, perWicket: 20, bonus2w: 5, bonus3w: 10, bonus5w: 10, perMaiden: 20, perLbwBowledHw: 5 },
    fielding: { perCatch: 5, perRunoutDirect: 10, perRunoutIndirect: 5, perStumping: 10 },
    mom: 30
  });
}

// ========== Main Handler ==========
exports.handler = async (event) => {
  const method = event.httpMethod;
  const rawPath = event.path
    .replace(/^\/?\.netlify\/functions\/api\/?/, '')
    .replace(/^\/?(api)\/?/, '')
    .replace(/^\//, '')
    .replace(/\/$/, '');

  try {
    if (method === 'GET' && rawPath === 'config') return handleGetConfig();
    if (method === 'GET' && rawPath === 'players') return handlePlayers();
    if (method === 'GET' && rawPath === 'standings') return handleStandings();
    if (method === 'GET' && rawPath === 'matches') return handleMatches();
    if (method === 'GET' && rawPath === 'dashboard') return handleDashboard();
    if (method === 'GET' && rawPath === 'players/details') return handlePlayersDetails();
    if (method === 'GET' && rawPath === 'rules') return handleRules();

    const detailMatch = rawPath.match(/^matches\/([^/]+)\/detail$/);
    if (method === 'GET' && detailMatch) return handleMatchDetail(detailMatch[1]);

    const matchById = rawPath.match(/^matches\/([^/]+)$/);
    if (method === 'GET' && matchById) return handleMatchById(matchById[1]);

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error('Function error:', err);
    return json(500, { error: 'Internal server error', message: err.message });
  }
};
