const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_CACHE = path.join(DATA_DIR, 'players-cache.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MATCHES_DIR = path.join(DATA_DIR, 'matches');

// ========== Data Loaders ==========
function getLeagueName() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.name) return config.name;
    } catch (e) { /* fall through to default */ }
  }
  return 'Pavilion';
}

function getPlayers() {
  if (fs.existsSync(PLAYERS_CACHE)) {
    return JSON.parse(fs.readFileSync(PLAYERS_CACHE, 'utf8'));
  }
  return [];
}

function getTeams() {
  const players = getPlayers();
  return [...new Set(players.map(p => p.fantasyTeam))];
}

function getMatchFiles() {
  if (!fs.existsSync(MATCHES_DIR)) return [];
  return fs.readdirSync(MATCHES_DIR)
    .filter(f => f.endsWith('.json') || f.endsWith('.csv'))
    .sort();
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

// ========== Fantasy Points Calculation ==========
function calcBattingPoints(stats) {
  let pts = 0;
  const runs = stats.runs || 0;
  pts += runs + (stats.fours || 0) + (stats.sixes || 0) * 2;
  if (runs >= 30) pts += 5;
  if (runs >= 50) pts += 10;
  if (runs >= 100) pts += 10;
  return pts;
}

function calcBowlingPoints(stats) {
  let pts = 0;
  const wickets = stats.wickets || 0;
  pts += (stats.dots || 0) + wickets * 20;
  if (wickets >= 2) pts += 5;
  if (wickets >= 3) pts += 10;
  if (wickets >= 5) pts += 10;
  pts += (stats.maidens || 0) * 20 + (stats.lbwBowledHw || 0) * 5;
  return pts;
}

function calcFieldingPoints(stats) {
  return (stats.catches || 0) * 5 + (stats.runoutDirect || 0) * 10 + (stats.runoutIndirect || 0) * 5 + (stats.stumpings || 0) * 10;
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

// ========== API Endpoints ==========

app.get('/api/config', (req, res) => {
  const players = getPlayers();
  const configured = players.length > 0;
  const name = getLeagueName();
  const teams = getTeams();
  res.json({ configured, name, teams });
});

app.get('/api/players', (req, res) => {
  res.json(getPlayers());
});

app.get('/api/standings', (req, res) => {
  const players = getPlayers();
  if (players.length === 0) return res.status(404).json({ error: 'Not configured' });

  const teams = getTeams();
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

  const sorted = Object.entries(teamStandings)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([team, data], i) => ({ rank: i + 1, team, ...data }));

  res.json(sorted);
});

app.get('/api/matches', (req, res) => {
  res.json(loadAllMatches().reverse());
});

app.get('/api/matches/:id', (req, res) => {
  const csvFile = `match-${req.params.id}.csv`;
  const jsonFile = `match-${req.params.id}.json`;
  const csvPath = path.join(MATCHES_DIR, csvFile);
  const jsonPath = path.join(MATCHES_DIR, jsonFile);
  if (fs.existsSync(csvPath)) return res.json(loadMatch(csvFile));
  if (fs.existsSync(jsonPath)) return res.json(loadMatch(jsonFile));
  return res.status(404).json({ error: 'Match not found' });
});

app.get('/api/matches/:id/detail', (req, res) => {
  const players = getPlayers();
  if (players.length === 0) return res.status(404).json({ error: 'Not configured' });

  const teams = getTeams();
  const csvFile = `match-${req.params.id}.csv`;
  const jsonFile = `match-${req.params.id}.json`;
  const csvPath = path.join(MATCHES_DIR, csvFile);
  const jsonPath = path.join(MATCHES_DIR, jsonFile);
  let filename;
  if (fs.existsSync(csvPath)) filename = csvFile;
  else if (fs.existsSync(jsonPath)) filename = jsonFile;
  else return res.status(404).json({ error: 'Match not found' });

  const match = loadMatch(filename);
  const teamBreakdown = {};
  for (const team of teams) teamBreakdown[team] = { total: 0, players: [] };

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
  for (const team of teams) teamBreakdown[team].players.sort((a, b) => b.points - a.points);

  res.json({ match, teamBreakdown });
});

app.get('/api/dashboard', (req, res) => {
  const players = getPlayers();
  if (players.length === 0) return res.status(404).json({ error: 'Not configured' });

  const teams = getTeams();
  const leagueName = getLeagueName();
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
  for (const team of teams) {
    const teamPlayers = players.filter(p => p.fantasyTeam === team);
    teamTotals[team] = teamPlayers.reduce((sum, p) => sum + (playerPoints[p.id] ? playerPoints[p.id].total : 0), 0);
  }
  const sortedTeams = Object.entries(teamTotals).sort((a, b) => b[1] - a[1]).map(([team, total], i) => ({ rank: i + 1, team, total }));

  res.json({ totalMatches, totalPlayers: players.length, topPlayers, bestPerformance: bestPerf, teamRankings: sortedTeams, leagueName });
});

app.get('/api/players/details', (req, res) => {
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
  res.json(result);
});

app.get('/api/rules', (req, res) => {
  res.json({
    playing12: 5,
    batting: { perRun: 1, perFour: 1, perSix: 2, bonus30: 5, bonus50: 10, bonus100: 10 },
    bowling: { perDot: 1, perWicket: 20, bonus2w: 5, bonus3w: 10, bonus5w: 10, perMaiden: 20, perLbwBowledHw: 5 },
    fielding: { perCatch: 5, perRunoutDirect: 10, perRunoutIndirect: 5, perStumping: 10 },
    mom: 30
  });
});

app.listen(PORT, () => {
  console.log(`Fantasy Points Tracker running at http://localhost:${PORT}`);
});
