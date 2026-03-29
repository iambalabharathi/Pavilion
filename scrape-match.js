#!/usr/bin/env node
/**
 * Scrape a Cricbuzz scorecard and generate match CSV.
 *
 * Usage:
 *   node scrape-match.js <cricbuzz-match-id> <match-number>
 *
 * Example:
 *   node scrape-match.js 149618 10
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const PLAYERS_FILE = path.join(__dirname, 'data', 'players-cache.json');
const MATCHES_DIR = path.join(__dirname, 'data', 'matches');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scrape-match.js <cricbuzz-match-id> <match-number>');
  process.exit(1);
}

const cricbuzzMatchId = args[0];
const matchNum = args[1];
const outFile = path.join(MATCHES_DIR, `match-${matchNum}.csv`);

if (fs.existsSync(outFile)) {
  console.log(`match-${matchNum}.csv already exists, overwriting.`);
}

const allPlayers = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));

// ========== HTTP fetch ==========
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ========== Name matching (same logic as parse-match.js) ==========
function normalize(name) {
  return name
    .replace(/[†\s]+/g, ' ')
    .replace(/\(c\)/g, '')
    .replace(/\(wk\)/gi, '')
    .replace(/\(c & wk\)/gi, '')
    .replace(/\(c &amp; wk\)/gi, '')
    .trim()
    .toLowerCase();
}

function matchPlayerInList(name, playerList) {
  const norm = normalize(name);
  const parts = norm.split(' ').filter(Boolean);

  let found = playerList.find(p => normalize(p.name) === norm);
  if (found) return found;

  // Last name + first initial (only if unique match)
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const firstInitial = parts[0][0];
    const matches = playerList.filter(p => {
      const pp = normalize(p.name).split(' ').filter(Boolean);
      return pp[pp.length - 1] === lastName && pp[0][0] === firstInitial;
    });
    if (matches.length === 1) return matches[0];
  }

  // Last name only (if unique)
  if (parts.length >= 1) {
    const lastName = parts[parts.length - 1];
    const matches = playerList.filter(p => {
      const pp = normalize(p.name).split(' ').filter(Boolean);
      return pp[pp.length - 1] === lastName;
    });
    if (matches.length === 1) return matches[0];
  }

  found = playerList.find(p => normalize(p.name).includes(norm) || norm.includes(normalize(p.name)));
  if (found) return found;

  found = playerList.find(p => {
    const pNorm = normalize(p.name);
    return parts.every(part => pNorm.includes(part));
  });
  if (found) return found;

  return null;
}

// Try matching against team players first, then all players
let teamFilteredPlayers = allPlayers;
function matchPlayer(name) {
  return matchPlayerInList(name, teamFilteredPlayers) || matchPlayerInList(name, allPlayers);
}

// ========== Parse scorecard HTML ==========
function parseScorecard(html) {
  const $ = cheerio.load(html);
  const playerStats = {};
  const teams = [];
  const unmatched = [];

  function getOrCreate(name) {
    const clean = name.replace(/\(c\)/g, '').replace(/\(wk\)/gi, '').replace(/\(c & wk\)/gi, '').replace(/\(c &amp; wk\)/gi, '').trim();
    if (!playerStats[clean]) {
      playerStats[clean] = {
        playing: true,
        mom: false,
        batting: { runs: 0, fours: 0, sixes: 0 },
        bowling: { wickets: 0, dots: 0, maidens: 0, lbwBowledHw: 0 },
        fielding: { catches: 0, runoutDirect: 0, runoutIndirect: 0, stumpings: 0 },
      };
    }
    return playerStats[clean];
  }

  function parseDismissal(dismissal) {
    if (!dismissal) return;
    const d = dismissal.trim();

    // c & b BowlerName
    let m = d.match(/^c\s*&\s*b\s+(.+)$/);
    if (m) {
      getOrCreate(m[1].trim()).fielding.catches++;
      return;
    }

    // c FielderName b BowlerName
    m = d.match(/^c\s+(?:†)?(.+?)\s+b\s+(.+)$/);
    if (m) {
      const fielder = m[1].replace(/^sub\s*\([^)]*\)/, '').replace(/^sub\s+/, '').trim();
      if (fielder) getOrCreate(fielder).fielding.catches++;
      return;
    }

    // st FielderName b BowlerName
    m = d.match(/^st\s+(?:†)?(.+?)\s+b\s+(.+)$/);
    if (m) {
      getOrCreate(m[1].trim()).fielding.stumpings++;
      return;
    }

    // lbw b BowlerName
    m = d.match(/^lbw\s+b\s+(.+)$/);
    if (m) {
      getOrCreate(m[1].trim()).bowling.lbwBowledHw++;
      return;
    }

    // b BowlerName (bowled)
    m = d.match(/^b\s+(.+)$/);
    if (m) {
      getOrCreate(m[1].trim()).bowling.lbwBowledHw++;
      return;
    }

    // hit wicket b BowlerName
    m = d.match(/^hit wicket\s+b\s+(.+)$/);
    if (m) {
      getOrCreate(m[1].trim()).bowling.lbwBowledHw++;
      return;
    }

    // run out (Fielder) or run out (F1/F2)
    m = d.match(/^run out\s*\(([^)]+)\)/);
    if (m) {
      const fielders = m[1].split('/').map(f => f.replace(/†/, '').trim());
      if (fielders.length === 1) {
        getOrCreate(fielders[0]).fielding.runoutDirect++;
      } else {
        for (const f of fielders) {
          getOrCreate(f).fielding.runoutIndirect++;
        }
      }
      return;
    }
  }

  // Innings headers have id="team-{teamId}-innings-{N}" and text content is the team abbreviation
  const seenInnings = new Set();
  $('[id^="team-"][id*="-innings-"]').each((_, el) => {
    const id = $(el).attr('id');
    if (!id || seenInnings.has(id)) return;
    seenInnings.add(id);

    const teamAbbr = $(el).children().first().text().trim();
    if (teamAbbr && !teams.includes(teamAbbr)) {
      teams.push(teamAbbr);
    }
  });

  // Parse batting rows
  const batRows = $('div[class*="scorecard-bat-grid"]');
  const processedBatRows = new Set();

  batRows.each((idx, el) => {
    const $row = $(el);

    // Skip header rows (contain "Batter" as bold text)
    const firstDiv = $row.children().first();
    if (firstDiv.hasClass('font-bold') && firstDiv.text().trim() === 'Batter') return;

    // Find player link
    const playerLink = $row.find('a[href*="/profiles/"]');
    if (!playerLink.length) return;

    const playerName = playerLink.text().trim();
    if (!playerName) return;

    // Deduplicate (mobile + desktop render same rows)
    const key = `bat-${playerName}`;
    if (processedBatRows.has(key)) return;
    processedBatRows.add(key);

    // Dismissal text
    const dismissalDiv = $row.find('div.text-cbTxtSec');
    const dismissal = dismissalDiv.text().trim();

    // Stats: R, B, 4s, 6s, SR are in the justify-center divs
    const statDivs = $row.children('div.flex.justify-center.items-center');
    const stats = [];
    statDivs.each((_, sd) => {
      const text = $(sd).text().trim();
      if (text !== '') stats.push(text);
    });

    // stats order: R, B, 4s, 6s, SR (based on header)
    const runs = parseInt(stats[0]) || 0;
    const fours = parseInt(stats[2]) || 0;
    const sixes = parseInt(stats[3]) || 0;

    const ps = getOrCreate(playerName);
    ps.batting.runs = runs;
    ps.batting.fours = fours;
    ps.batting.sixes = sixes;

    // Parse dismissal for fielding
    if (dismissal && dismissal !== 'not out' && dismissal !== 'batting') {
      parseDismissal(dismissal);
    }
  });

  // Parse "Did not bat" players
  $('div').each((_, el) => {
    const text = $(el).text().trim();
    if (text.startsWith('Did not bat')) {
      // DNB players are listed as links after the "Did not bat:" text
      $(el).find('a[href*="/profiles/"]').each((_, a) => {
        const name = $(a).text().trim();
        if (name) getOrCreate(name);
      });
    }
  });

  // Parse bowling rows
  const bowlRows = $('div[class*="scorecard-bowl-grid"]');
  const processedBowlRows = new Set();

  bowlRows.each((_, el) => {
    const $row = $(el);

    // Skip header rows
    const firstDiv = $row.children().first();
    if (firstDiv.hasClass('font-bold') && firstDiv.text().trim() === 'Bowler') return;

    // Find bowler link
    const bowlerLink = $row.find('a[href*="/profiles/"]').first();
    if (!bowlerLink.length) return;

    const bowlerName = bowlerLink.text().trim();
    if (!bowlerName) return;

    // Deduplicate
    const key = `bowl-${bowlerName}`;
    if (processedBowlRows.has(key)) return;
    processedBowlRows.add(key);

    // Stats: O, M, R, W, NB, WD, ECO
    const statDivs = $row.children('div.flex.justify-center.items-center');
    const stats = [];
    statDivs.each((_, sd) => {
      stats.push($(sd).text().trim());
    });

    const maidens = parseInt(stats[1]) || 0;
    const wickets = parseInt(stats[3]) || 0;

    const bs = getOrCreate(bowlerName);
    bs.bowling.wickets += wickets;
    bs.bowling.maidens += maidens;
    // dots hardcoded to 0
  });

  // Prefer matching against players from the two playing teams
  const teamAbbrSet = new Set(teams.map(t => t.toUpperCase()));
  teamFilteredPlayers = allPlayers.filter(p => teamAbbrSet.has(p.iplTeam));

  // Match players to fantasy roster
  const matchedPlayers = {};
  for (const [scorecardName, stats] of Object.entries(playerStats)) {
    const player = matchPlayer(scorecardName);
    if (player) {
      if (matchedPlayers[player.id]) {
        // Merge stats
        const existing = matchedPlayers[player.id];
        existing.batting.runs += stats.batting.runs;
        existing.batting.fours += stats.batting.fours;
        existing.batting.sixes += stats.batting.sixes;
        existing.bowling.wickets += stats.bowling.wickets;
        existing.bowling.maidens += stats.bowling.maidens;
        existing.bowling.lbwBowledHw += stats.bowling.lbwBowledHw;
        existing.fielding.catches += stats.fielding.catches;
        existing.fielding.runoutDirect += stats.fielding.runoutDirect;
        existing.fielding.runoutIndirect += stats.fielding.runoutIndirect;
        existing.fielding.stumpings += stats.fielding.stumpings;
      } else {
        matchedPlayers[player.id] = stats;
      }
    } else {
      unmatched.push(scorecardName);
    }
  }

  return { matchedPlayers, teams, unmatched };
}

// ========== Extract match date from page ==========
function extractDate(html) {
  const $ = cheerio.load(html);
  // Look for date in the page — typically in match info
  // Try meta tags first
  const title = $('title').text();
  // Fallback: use today's date
  return new Date().toISOString().split('T')[0];
}

// ========== Generate CSV ==========
function generateCSV(matchedPlayers, teams, matchNum, date) {
  const TEAM_NAME_MAP = {
    'chennai super kings': 'CSK', 'csk': 'CSK',
    'delhi capitals': 'DC', 'dc': 'DC',
    'gujarat titans': 'GT', 'gt': 'GT',
    'kolkata knight riders': 'KKR', 'kkr': 'KKR',
    'lucknow super giants': 'LSG', 'lsg': 'LSG',
    'mumbai indians': 'MI', 'mi': 'MI',
    'punjab kings': 'PBKS', 'pbks': 'PBKS',
    'royal challengers bengaluru': 'RCB', 'rcb': 'RCB',
    'rajasthan royals': 'RR', 'rr': 'RR',
    'sunrisers hyderabad': 'SRH', 'srh': 'SRH',
  };

  function teamAbbr(name) {
    const lower = name.toLowerCase().trim();
    if (TEAM_NAME_MAP[lower]) return TEAM_NAME_MAP[lower];
    for (const [key, abbr] of Object.entries(TEAM_NAME_MAP)) {
      if (lower.includes(key) || key.includes(lower)) return abbr;
    }
    return name.toUpperCase();
  }

  const iplTeamList = teams.map(t => teamAbbr(t));

  // Only include the two playing teams
  const iplTeamSet = new Set(iplTeamList);
  const teamPlayers = allPlayers.filter(p => iplTeamSet.has(p.iplTeam));

  const title = iplTeamList.length >= 2
    ? `${iplTeamList[0]} vs ${iplTeamList[1]} - Match ${matchNum}`
    : `Match ${matchNum}`;

  let csv = `# ${title}\n`;
  csv += `# ${date}\n`;
  csv += `#\n`;
  csv += `# id, name, ipl_team, fantasy_team, playing, mom, runs, 4s, 6s, wkts, dots, maidens, lbw_b_hw, catches, ro_direct, ro_indirect, stumpings\n`;
  csv += `\n`;

  for (const iplTeam of iplTeamList) {
    csv += `# --- ${iplTeam} ---\n`;
    const tp = teamPlayers.filter(p => p.iplTeam === iplTeam);
    for (const p of tp) {
      const s = matchedPlayers[p.id];
      if (s) {
        csv += `${p.id}, ${p.name}, ${p.iplTeam}, ${p.fantasyTeam}, ${s.playing?1:0}, ${s.mom?1:0}, ${s.batting.runs}, ${s.batting.fours}, ${s.batting.sixes}, ${s.bowling.wickets}, 0, ${s.bowling.maidens}, ${s.bowling.lbwBowledHw}, ${s.fielding.catches}, ${s.fielding.runoutDirect}, ${s.fielding.runoutIndirect}, ${s.fielding.stumpings}\n`;
      } else {
        csv += `${p.id}, ${p.name}, ${p.iplTeam}, ${p.fantasyTeam}, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0\n`;
      }
    }
    csv += `\n`;
  }

  return csv;
}

// ========== Main ==========
(async () => {
  try {
    const scorecardUrl = `https://www.cricbuzz.com/live-cricket-scorecard/${cricbuzzMatchId}/match`;
    console.log(`Fetching scorecard: ${scorecardUrl}`);

    const html = await fetch(scorecardUrl);
    const { matchedPlayers, teams, unmatched } = parseScorecard(html);
    const date = extractDate(html);

    console.log(`Teams: ${teams.join(' vs ')}`);
    console.log(`Matched: ${Object.keys(matchedPlayers).length} fantasy players`);
    console.log(`Playing: ${Object.values(matchedPlayers).filter(s => s.playing).length}`);

    if (unmatched.length > 0) {
      console.log(`Not in fantasy roster: ${unmatched.join(', ')}`);
    }

    const csv = generateCSV(matchedPlayers, teams, matchNum, date);

    if (!fs.existsSync(MATCHES_DIR)) fs.mkdirSync(MATCHES_DIR, { recursive: true });
    fs.writeFileSync(outFile, csv);
    console.log(`Written: ${outFile}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
