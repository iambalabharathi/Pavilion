const fs = require('fs');
const path = require('path');

// Netlify esbuild bundles included_files relative to the function's directory
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
const MATCHES_DIR = DATA_DIR ? path.join(DATA_DIR, 'matches') : null;
const PLAYERS_CACHE = DATA_DIR ? path.join(DATA_DIR, 'players-cache.json') : null;

const TEAMS = ['Ragu', 'RK', 'Darshan', 'Prabhu', 'Dots', 'JD', 'Rijo', 'Prakash'];

// ========== Helpers ==========
function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getPlayers() {
  if (!PLAYERS_CACHE) return [];
  try {
    return JSON.parse(fs.readFileSync(PLAYERS_CACHE, 'utf8'));
  } catch {
    return [];
  }
}

function getMatchFiles() {
  if (!MATCHES_DIR) return [];
  try {
    return fs.readdirSync(MATCHES_DIR)
      .filter(f => f.endsWith('.json') || f.endsWith('.csv'))
      .sort();
  } catch {
    return [];
  }
}

function handleDebug() {
  const candidates = [
    path.join(__dirname, 'data'),
    path.join(__dirname, '..', 'data'),
    path.join(__dirname, '..', '..', 'data'),
    path.join(process.cwd(), 'data'),
    '/var/task/data',
    '/var/task/src/data',
  ];
  const info = {
    __dirname,
    cwd: process.cwd(),
    DATA_DIR,
    PLAYERS_CACHE,
    MATCHES_DIR,
    candidateResults: candidates.map(c => ({ path: c, exists: fs.existsSync(c) })),
  };
  // List files in __dirname to see what's there
  try { info.dirnameFiles = fs.readdirSync(__dirname); } catch (e) { info.dirnameFiles = e.message; }
  try { info.cwdFiles = fs.readdirSync(process.cwd()); } catch (e) { info.cwdFiles = e.message; }
  try { info.varTask = fs.readdirSync('/var/task'); } catch (e) { info.varTask = e.message; }
  if (DATA_DIR) {
    try { info.dataFiles = fs.readdirSync(DATA_DIR); } catch (e) { info.dataFiles = e.message; }
  }
  return json(200, info);
}

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

function loadMatch(filename) {
  const filepath = path.join(MATCHES_DIR, filename);
  if (filename.endsWith('.csv')) return parseCSVMatch(filepath);
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function loadAllMatches() {
  return getMatchFiles().map(f => loadMatch(f));
}

// ========== Points Calculation ==========
function calcBattingPoints(stats) {
  let pts = 0;
  const runs = stats.runs || 0;
  pts += runs;
  pts += (stats.fours || 0) * 1;
  pts += (stats.sixes || 0) * 2;
  if (runs >= 30) pts += 5;
  if (runs >= 50) pts += 10;
  if (runs >= 100) pts += 10;
  return pts;
}

function calcBowlingPoints(stats) {
  let pts = 0;
  const wickets = stats.wickets || 0;
  pts += (stats.dots || 0) * 1;
  pts += wickets * 20;
  if (wickets >= 2) pts += 5;
  if (wickets >= 3) pts += 10;
  if (wickets >= 5) pts += 10;
  pts += (stats.maidens || 0) * 20;
  pts += (stats.lbwBowledHw || 0) * 5;
  return pts;
}

function calcFieldingPoints(stats) {
  let pts = 0;
  pts += (stats.catches || 0) * 5;
  pts += (stats.runoutDirect || 0) * 10;
  pts += (stats.runoutIndirect || 0) * 5;
  pts += (stats.stumpings || 0) * 10;
  return pts;
}

function calcPlayerMatchPoints(playerMatch) {
  let total = 0;
  if (playerMatch.playing) total += 5;
  if (playerMatch.batting) total += calcBattingPoints(playerMatch.batting);
  if (playerMatch.bowling) total += calcBowlingPoints(playerMatch.bowling);
  if (playerMatch.fielding) total += calcFieldingPoints(playerMatch.fielding);
  if (playerMatch.mom) total += 30;
  return total;
}

// ========== Route Handlers ==========
function handlePlayers() {
  return json(200, getPlayers());
}

function handleStandings() {
  const players = getPlayers();
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
  for (const team of TEAMS) {
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
  const sorted = Object.entries(teamStandings)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([team, data], i) => ({ rank: i + 1, team, ...data }));
  return json(200, sorted);
}

function handleMatches() {
  return json(200, loadAllMatches().reverse());
}

function handleMatchById(id) {
  const csvFile = `match-${id}.csv`;
  const jsonFile = `match-${id}.json`;
  const csvPath = path.join(MATCHES_DIR, csvFile);
  const jsonPath = path.join(MATCHES_DIR, jsonFile);
  if (fs.existsSync(csvPath)) return json(200, loadMatch(csvFile));
  if (fs.existsSync(jsonPath)) return json(200, loadMatch(jsonFile));
  return json(404, { error: 'Match not found' });
}

function handleMatchDetail(id) {
  const csvFile = `match-${id}.csv`;
  const jsonFile = `match-${id}.json`;
  const csvPath = path.join(MATCHES_DIR, csvFile);
  const jsonPath = path.join(MATCHES_DIR, jsonFile);
  let filename;
  if (fs.existsSync(csvPath)) filename = csvFile;
  else if (fs.existsSync(jsonPath)) filename = jsonFile;
  else return json(404, { error: 'Match not found' });

  const match = loadMatch(filename);
  const players = getPlayers();
  const teamBreakdown = {};
  for (const team of TEAMS) teamBreakdown[team] = { total: 0, players: [] };
  for (const [playerId, stats] of Object.entries(match.players || {})) {
    const pid = parseInt(playerId);
    const p = players.find(pl => pl.id === pid);
    if (!p) continue;
    const pts = match.abandoned ? 0 : calcPlayerMatchPoints(stats);
    const team = p.fantasyTeam;
    if (teamBreakdown[team]) {
      teamBreakdown[team].total += pts;
      teamBreakdown[team].players.push({ ...p, points: pts, stats });
    }
  }
  for (const team of TEAMS) teamBreakdown[team].players.sort((a, b) => b.points - a.points);
  return json(200, { match, teamBreakdown });
}

function handleDashboard() {
  const players = getPlayers();
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
      if (pts > playerPoints[pid].bestMatch) {
        playerPoints[pid].bestMatch = pts;
        playerPoints[pid].bestMatchTitle = match.title;
      }
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
  for (const team of TEAMS) {
    const teamPlayers = players.filter(p => p.fantasyTeam === team);
    teamTotals[team] = teamPlayers.reduce((sum, p) => sum + (playerPoints[p.id] ? playerPoints[p.id].total : 0), 0);
  }
  const sortedTeams = Object.entries(teamTotals).sort((a, b) => b[1] - a[1]).map(([team, total], i) => ({ rank: i + 1, team, total }));
  return json(200, { totalMatches, totalPlayers: players.length, topPlayers, bestPerformance: bestPerf, teamRankings: sortedTeams });
}

function handlePlayersDetails() {
  const players = getPlayers();
  const matches = loadAllMatches();
  const result = players.map(p => {
    const matchBreakdowns = [];
    let total = 0;
    for (const match of matches) {
      if (match.abandoned) continue;
      const stats = (match.players || {})[p.id];
      if (!stats) continue;
      const playingPts = stats.playing ? 5 : 0;
      const battingPts = stats.batting ? calcBattingPoints(stats.batting) : 0;
      const bowlingPts = stats.bowling ? calcBowlingPoints(stats.bowling) : 0;
      const fieldingPts = stats.fielding ? calcFieldingPoints(stats.fielding) : 0;
      const momPts = stats.mom ? 30 : 0;
      const matchTotal = playingPts + battingPts + bowlingPts + fieldingPts + momPts;
      total += matchTotal;
      matchBreakdowns.push({
        matchId: match.id, matchTitle: match.title, matchDate: match.date,
        total: matchTotal, playing: playingPts, batting: battingPts, bowling: bowlingPts, fielding: fieldingPts, mom: momPts, stats
      });
    }
    return { ...p, total, matchCount: matchBreakdowns.length, matches: matchBreakdowns };
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
  // The path after /api/ comes through as the function path
  // With the redirect /api/* -> /.netlify/functions/api/:splat
  // event.path will be /.netlify/functions/api/...
  const rawPath = event.path.replace('/.netlify/functions/api', '').replace(/^\//, '');

  try {
    if (method === 'GET') {
      if (rawPath === 'debug') return handleDebug();
      if (rawPath === 'players') return handlePlayers();
      if (rawPath === 'standings') return handleStandings();
      if (rawPath === 'matches') return handleMatches();
      if (rawPath === 'dashboard') return handleDashboard();
      if (rawPath === 'rules') return handleRules();
      if (rawPath === 'players/details') return handlePlayersDetails();

      // /matches/:id/detail
      const detailMatch = rawPath.match(/^matches\/([^/]+)\/detail$/);
      if (detailMatch) return handleMatchDetail(detailMatch[1]);

      // /matches/:id
      const matchById = rawPath.match(/^matches\/([^/]+)$/);
      if (matchById) return handleMatchById(matchById[1]);
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error('Function error:', err);
    return json(500, { error: 'Internal server error', message: err.message });
  }
};
