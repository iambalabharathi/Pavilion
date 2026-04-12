#!/usr/bin/env node
/**
 * Parse ESPN Cricinfo scorecard text and generate match CSV.
 *
 * Match number is extracted from the filename (e.g., match-3.txt → 3).
 *
 * Usage:
 *   node parse-match.js <rawfile> [--force]
 *
 * Example:
 *   node parse-match.js data/raw/match-2.txt
 *   node parse-match.js data/raw/match-2.txt --force
 */

const fs = require('fs');
const path = require('path');

// ========== ANSI helpers ==========
const c = {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  // Only used for titles/banners/badges — body text is plain
  red:   '\x1b[31m',
  green: '\x1b[32m',
  blue:  '\x1b[34m',
};

function banner(text, color = c.blue) {
  const line = '─'.repeat(text.length + 4);
  return `\n${color}  ┌${line}┐\n  │  ${text}  │\n  └${line}┘${c.reset}\n`;
}
function sectionHeader(text) {
  return `${c.blue}  ▸ ${text}${c.reset}`;
}

const PLAYERS_FILE = path.join(__dirname, 'data', 'players-cache.json');
const MATCHES_DIR = path.join(__dirname, 'data', 'matches');
const RAW_DIR = path.join(__dirname, 'data', 'raw');

const args = process.argv.slice(2);
const forceFlag = args.includes('--force');
const filteredArgs = args.filter(a => a !== '--force');

if (filteredArgs.length < 1) {
  console.log(`\n  ${c.blue}Usage:${c.reset}   node parse-match.js <rawfile> [--force]`);
  console.log(`  ${c.blue}Example:${c.reset} node parse-match.js data/raw/match-2.txt\n`);
  process.exit(1);
}

const rawFile = filteredArgs[0];
const basename = path.basename(rawFile, path.extname(rawFile));
const matchNumMatch = basename.match(/(\d+)/);
if (!matchNumMatch) {
  console.error(`\n  ${c.red}✗ Could not extract match number from: ${basename}${c.reset}`);
  console.error(`    Filename should contain a number, e.g., match-3.txt\n`);
  process.exit(1);
}
const matchNum = matchNumMatch[1];

if (!fs.existsSync(rawFile)) {
  console.error(`\n  ${c.red}✗ File not found: ${rawFile}${c.reset}\n`);
  process.exit(1);
}
if (!fs.existsSync(PLAYERS_FILE)) {
  console.error(`\n  ${c.red}✗ data/players-cache.json not found.${c.reset}\n`);
  process.exit(1);
}

const allPlayers = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
const rawText = fs.readFileSync(rawFile, 'utf8');
const lines = rawText.split('\n');

// ========== Name matching ==========
function normalize(name) {
  return name
    .replace(/[†\s]+/g, ' ')
    .replace(/\(c\)/g, '')
    .replace(/\(wk\)/gi, '')
    .trim()
    .toLowerCase();
}

// Returns true if two first names could refer to the same person:
// equal, OR one side is just an initial that matches the other's first letter.
// Two distinct full first names (e.g., "ashok" vs "ashutosh") are NOT compatible.
function firstNamesCompatible(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return false;
}

function matchPlayer(name, teamFilter) {
  const norm = normalize(name);
  const parts = norm.split(' ').filter(Boolean);
  const searchFirst = parts.length >= 2 ? parts[0] : '';

  // Exact match
  let found = allPlayers.find(p => normalize(p.name) === norm);
  if (found) return found;

  // Last name + first initial match
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    found = allPlayers.find(p => {
      const pp = normalize(p.name).split(' ').filter(Boolean);
      const pLast = pp[pp.length - 1];
      const pFirst = pp[0];
      return pLast === lastName && firstNamesCompatible(searchFirst, pFirst);
    });
    if (found) return found;
  }

  // Last name only (if unique, or unique within playing teams)
  // When the search has a full first name, the candidate's first name must
  // also be compatible — otherwise "Ashok Sharma" would match "Ashutosh Sharma"
  // simply because Ashutosh is the only Sharma on the playing teams.
  if (parts.length >= 1) {
    const lastName = parts[parts.length - 1];
    const isCompatible = (p) => {
      if (!searchFirst) return true;
      const pp = normalize(p.name).split(' ').filter(Boolean);
      const pFirst = pp.length >= 2 ? pp[0] : '';
      return firstNamesCompatible(searchFirst, pFirst);
    };
    const matches = allPlayers.filter(p => {
      const pp = normalize(p.name).split(' ').filter(Boolean);
      return pp[pp.length - 1] === lastName;
    }).filter(isCompatible);
    if (matches.length === 1) return matches[0];
    // Disambiguate by teams playing in this match
    if (matches.length > 1 && teamFilter) {
      const inMatch = matches.filter(p => teamFilter.has(p.iplTeam));
      if (inMatch.length === 1) return inMatch[0];
    }
  }

  // Substring match
  found = allPlayers.find(p => normalize(p.name).includes(norm) || norm.includes(normalize(p.name)));
  if (found) return found;

  // Partial: check if all parts of the search appear in a player name
  found = allPlayers.find(p => {
    const pNorm = normalize(p.name);
    return parts.every(part => pNorm.includes(part));
  });
  if (found) return found;

  return null;
}

// ========== Parse scorecard ==========

// Track stats per player name (from scorecard)
const playerStats = {}; // scorecardName -> { playing, mom, batting, bowling, fielding }

// Track keeper name per innings (identified by † symbol in scorecard)
const keepers = []; // full scorecard name of each innings' keeper

function getOrCreate(name) {
  if (!playerStats[name]) {
    playerStats[name] = {
      playing: true,
      mom: false,
      batting: { runs: 0, fours: 0, sixes: 0 },
      bowling: { wickets: 0, dots: 0, maidens: 0, lbwBowledHw: 0 },
      fielding: { catches: 0, runoutDirect: 0, runoutIndirect: 0, stumpings: 0 }
    };
  }
  return playerStats[name];
}

// Parse innings
let i = 0;
const teams = []; // IPL team names from header

function skipEmpty() {
  while (i < lines.length && !lines[i].trim()) i++;
}

function parseInnings() {
  // Find team header: "Team Name  (20 ovs maximum)" or "(T: xxx runs from xx ovs)"
  while (i < lines.length) {
    const line = lines[i].trim();
    if (/\(\d+ ovs? maximum\)/.test(line) || /\(T:.*runs from/.test(line)) {
      const teamName = line.replace(/\s*\(.*$/, '').trim();
      teams.push(teamName);
      i++;
      break;
    }
    i++;
  }

  // Skip batting header
  while (i < lines.length) {
    if (/^Batting\s/.test(lines[i].trim())) { i++; break; }
    i++;
  }

  // Parse batsmen
  while (i < lines.length) {
    const line = lines[i].trim();

    // End of batting section
    if (/^Extras\s/.test(line) || /^Total\s*$/.test(line) || /^Fall of wickets/.test(line) || /^Bowling\s/.test(line)) break;
    if (/^Did not bat/.test(line)) { i++; continue; }
    if (/^DRS/.test(line)) { i++; continue; }

    // Try to parse a batsman entry
    // Pattern: name line, then dismissal line, then stats line
    // Or: name line, "not out\tstats..." line
    if (!line || /^\d/.test(line) || line.startsWith('1-') || line.startsWith('2-')) { i++; continue; }

    // Check if this looks like a player name
    const isStatsLine = /^\d+\t\d+\t\d+/.test(line);
    const isDismissal = /^(c |b |lbw |run out|st |not out|hit wicket|retired|obstructing)/.test(line);
    if (isStatsLine || isDismissal) { i++; continue; }

    // This should be a player name
    // Detect keeper (†) before stripping the symbol
    if (/†/.test(line)) {
      const keeperName = line.replace(/[†]/, '').replace(/\(c\)/, '').replace(/\(wk\)/gi, '').trim();
      if (keeperName && keeperName.length >= 2) keepers.push(keeperName);
    }
    const playerName = line.replace(/[†]/, '').replace(/\(c\)/, '').replace(/\(wk\)/gi, '').trim();
    if (!playerName || playerName.length < 2) { i++; continue; }

    i++;
    if (i >= lines.length) break;

    let dismissalLine = '';
    let statsLine = '';

    const nextLine = lines[i].trim();

    // Check if dismissal + stats on same line (not out / retired cases)
    if (/^not out\t/.test(nextLine)) {
      dismissalLine = 'not out';
      statsLine = nextLine.replace(/^not out\s*/, '');
      i++;
    } else if (/^retired (hurt|not out)\t/.test(nextLine)) {
      dismissalLine = nextLine.match(/^retired (hurt|not out)/)[0];
      statsLine = nextLine.replace(/^retired (hurt|not out)\s*/, '');
      i++;
    } else if (/^(c |b |lbw |run out|st |hit wicket|retired|obstructing)/.test(nextLine)) {
      dismissalLine = nextLine;
      i++;
      if (i < lines.length) {
        statsLine = lines[i].trim();
        i++;
      }
    } else if (/^\d+\t/.test(nextLine)) {
      // Stats directly (no dismissal line visible)
      statsLine = nextLine;
      i++;
    } else {
      continue;
    }

    // Parse stats: R B M 4s 6s SR
    const statParts = statsLine.split('\t').map(s => s.trim());
    const runs = parseInt(statParts[0]) || 0;
    const fours = parseInt(statParts[3]) || 0;
    const sixes = parseInt(statParts[4]) || 0;

    const ps = getOrCreate(playerName);
    ps.batting.runs = runs;
    ps.batting.fours = fours;
    ps.batting.sixes = sixes;

    // Parse dismissal for fielding credits
    parseDismissal(dismissalLine, playerName);
  }

  // Scan for "Did not bat" players between batting and bowling sections
  while (i < lines.length) {
    const line = lines[i].trim();
    if (/^Bowling\s/.test(line)) { i++; break; }
    if (/^Did not bat/.test(line)) {
      i++;
      // Collect player names across one or more lines until a section boundary
      let dnbText = '';
      while (i < lines.length) {
        const dnbLine = lines[i].trim();
        if (!dnbLine || /^(Fall of|Bowling|Extras|Total|DRS|Did not bat)/.test(dnbLine) ||
            /\(\d+ ovs? maximum\)/.test(dnbLine) || /\(T:.*runs from/.test(dnbLine)) break;
        dnbText += (dnbText ? ', ' : '') + dnbLine;
        i++;
      }
      if (dnbText) {
        const dnbParts = dnbText.split(',').map(n => n.trim()).filter(Boolean);
        for (const part of dnbParts) {
          if (/†/.test(part)) {
            const keeperName = part.replace(/[†]/, '').replace(/\(c\)/, '').trim();
            if (keeperName && keeperName.length >= 2) keepers.push(keeperName);
          }
        }
        const dnbNames = dnbParts.map(n => n.replace(/[†]/, '').replace(/\(c\)/, '').trim()).filter(Boolean);
        for (const name of dnbNames) {
          if (name && name.length > 2) {
            getOrCreate(name); // Mark as playing
          }
        }
      }
      continue;
    }
    i++;
  }

  // Parse bowlers
  while (i < lines.length) {
    const line = lines[i].trim();

    // End of bowling - next innings or end of file
    if (/\(\d+ ovs? maximum\)/.test(line) || /\(T:.*runs from/.test(line)) break;
    if (!line) { i++; continue; }

    // Player name line (not a number line)
    const isStats = /^\d/.test(line);
    if (isStats) { i++; continue; }

    // Check if it's a team header for next innings
    if (/Kings|Challengers|Indians|Capitals|Titans|Riders|Giants|Royals|Sunrisers|Super/i.test(line) &&
        (/\(\d+ ovs?/.test(line) || /\(T:/.test(line))) break;

    const bowlerName = line.trim();
    if (!bowlerName || bowlerName.length < 2 || bowlerName === 'DRS' || bowlerName.startsWith('Fall of') || bowlerName.startsWith('Did not')) { i++; continue; }

    i++;
    if (i >= lines.length) break;

    // Next line(s): O M R [W] [ECON 0s WD NB] — format varies
    // Could be: "4\t0\t40\t" then "3" then "10.00\t8\t2\t0"
    // Or all on one line: "2\t0\t19\t0\t9.50\t4\t0\t0"

    const statsLine1 = lines[i].trim();
    const parts1 = statsLine1.split('\t').map(s => s.trim()).filter(Boolean);
    i++;

    let overs = 0, maidens = 0, wickets = 0, dots = 0;

    if (parts1.length >= 8) {
      // All on one line: O M R W ECON 0s WD NB
      overs = parseFloat(parts1[0]) || 0;
      maidens = parseInt(parts1[1]) || 0;
      wickets = parseInt(parts1[3]) || 0;
      dots = parseInt(parts1[5]) || 0;
    } else if (parts1.length >= 3) {
      // O M R on this line
      overs = parseFloat(parts1[0]) || 0;
      maidens = parseInt(parts1[1]) || 0;

      // Next line: wickets
      if (i < lines.length) {
        const wLine = lines[i].trim();
        const wParts = wLine.split('\t').map(s => s.trim()).filter(Boolean);
        if (wParts.length === 1 && /^\d+$/.test(wParts[0])) {
          wickets = parseInt(wParts[0]) || 0;
          i++;
        }
      }

      // Next line: ECON 0s WD NB
      if (i < lines.length) {
        const eLine = lines[i].trim();
        const eParts = eLine.split('\t').map(s => s.trim()).filter(Boolean);
        if (eParts.length >= 3 && /^\d+\.?\d*$/.test(eParts[0])) {
          dots = parseInt(eParts[1]) || 0;
          i++;
        }
      }
    }

    const bs = getOrCreate(bowlerName);
    bs.bowling.wickets = wickets;
    bs.bowling.dots = dots;
    bs.bowling.maidens = maidens;
  }
}

// Resolve a fielder name that may have † prefix to the keeper's full name.
// e.g. "†Sharma" → "Jitesh Sharma" if that's the keeper on record.
function resolveKeeperName(rawName) {
  const name = rawName.replace(/†/, '').trim();
  // Check if any keeper's full name ends with or matches this partial name
  for (const keeper of keepers) {
    const kNorm = normalize(keeper);
    const nNorm = normalize(name);
    if (kNorm === nNorm || kNorm.endsWith(nNorm) || kNorm.includes(nNorm)) {
      return keeper;
    }
  }
  return name;
}

function parseDismissal(dismissal, batsmanName) {
  if (!dismissal) return;
  const d = dismissal.trim();

  // "c & b BowlerName" — bowler gets catch (must check before regular caught)
  let m = d.match(/^c\s*&\s*b\s+(.+)$/);
  if (m) {
    const bowlerName = m[1].trim();
    const bs = getOrCreate(bowlerName);
    bs.fielding.catches++;
    return;
  }

  // "c FielderName b BowlerName" — fielder gets catch
  // †FielderName means the keeper — resolve to full keeper name
  // "c sub (Name) b BowlerName" — substitute fielder gets catch but not marked as playing
  m = d.match(/^c\s+(†?.+?)\s+b\s+(.+)$/);
  if (m) {
    let fielderRaw = m[1].trim();
    let isSub = false;
    // Extract substitute fielder name from "sub (Name)" or "sub Name"
    const subParen = fielderRaw.match(/^sub\s*\(([^)]+)\)/);
    const subPlain = fielderRaw.match(/^sub\s+(.+)/);
    if (subParen) {
      fielderRaw = subParen[1].trim();
      isSub = true;
    } else if (subPlain) {
      fielderRaw = subPlain[1].trim();
      isSub = true;
    }
    const fielderName = /†/.test(fielderRaw) ? resolveKeeperName(fielderRaw) : fielderRaw;
    if (fielderName) {
      const fs = getOrCreate(fielderName);
      fs.fielding.catches++;
      if (isSub) fs.playing = false;
    }
    return;
  }

  // "st FielderName b BowlerName" — fielder gets stumping
  // †FielderName means the keeper — resolve to full keeper name
  m = d.match(/^st\s+(†?.+?)\s+b\s+(.+)$/);
  if (m) {
    let fielderRaw = m[1].trim();
    const fielderName = /†/.test(fielderRaw) ? resolveKeeperName(fielderRaw) : fielderRaw;
    const fs = getOrCreate(fielderName);
    fs.fielding.stumpings++;
    return;
  }

  // "lbw b BowlerName" — bowler gets lbw bonus
  m = d.match(/^lbw\s+b\s+(.+)$/);
  if (m) {
    const bowlerName = m[1].trim();
    const bs = getOrCreate(bowlerName);
    bs.bowling.lbwBowledHw++;
    return;
  }

  // "b BowlerName" — bowled, bowler gets bonus
  m = d.match(/^b\s+(.+)$/);
  if (m) {
    const bowlerName = m[1].trim();
    const bs = getOrCreate(bowlerName);
    bs.bowling.lbwBowledHw++;
    return;
  }

  // "hit wicket b BowlerName"
  m = d.match(/^hit wicket\s+b\s+(.+)$/);
  if (m) {
    const bowlerName = m[1].trim();
    const bs = getOrCreate(bowlerName);
    bs.bowling.lbwBowledHw++;
    return;
  }

  // "run out (FielderName)" or "run out (F1/F2)"
  m = d.match(/^run out\s*\(([^)]+)\)/);
  if (m) {
    const fielders = m[1].split('/').map(f => /†/.test(f) ? resolveKeeperName(f) : f.trim());
    if (fielders.length === 1) {
      const fs = getOrCreate(fielders[0]);
      fs.fielding.runoutDirect++;
    } else {
      for (const f of fielders) {
        const fs = getOrCreate(f);
        fs.fielding.runoutIndirect++;
      }
    }
    return;
  }
}

// Parse both innings
parseInnings();
parseInnings();

// ========== Determine IPL teams from scorecard headers ==========
const TEAM_NAME_MAP = {
  'chennai super kings': 'CSK',
  'delhi capitals': 'DC',
  'gujarat titans': 'GT',
  'kolkata knight riders': 'KKR',
  'lucknow super giants': 'LSG',
  'mumbai indians': 'MI',
  'punjab kings': 'PBKS',
  'royal challengers bengaluru': 'RCB',
  'royal challengers bangalore': 'RCB',
  'rajasthan royals': 'RR',
  'sunrisers hyderabad': 'SRH',
};

function teamAbbr(fullName) {
  const lower = fullName.toLowerCase().trim();
  for (const [key, abbr] of Object.entries(TEAM_NAME_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return abbr;
  }
  return fullName; // fallback
}

// ========== Match players to fantasy roster ==========
const matchedPlayers = {}; // fantasyPlayerId -> stats
const unmatched = [];

const iplTeamAbbrs = new Set(teams.map(t => teamAbbr(t)));

for (const [scorecardName, stats] of Object.entries(playerStats)) {
  const player = matchPlayer(scorecardName, iplTeamAbbrs);
  if (player && iplTeamAbbrs.has(player.iplTeam)) {
    if (matchedPlayers[player.id]) {
      // Merge stats (shouldn't happen but just in case)
      const existing = matchedPlayers[player.id];
      existing.batting.runs += stats.batting.runs;
      existing.batting.fours += stats.batting.fours;
      existing.batting.sixes += stats.batting.sixes;
      existing.bowling.wickets += stats.bowling.wickets;
      existing.bowling.dots += stats.bowling.dots;
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

// ========== Review check: compare with previous raw files ==========
function collectDismissalTypes(text) {
  const types = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^c\s*&\s*b\s/.test(t)) types.add('c & b');
    else if (/^c\s+.+\s+b\s/.test(t)) types.add('caught');
    else if (/^st\s+.+\s+b\s/.test(t)) types.add('stumped');
    else if (/^lbw\s+b\s/.test(t)) types.add('lbw');
    else if (/^b\s+\w/.test(t)) types.add('bowled');
    else if (/^run out/.test(t)) types.add('run out');
    else if (/^hit wicket/.test(t)) types.add('hit wicket');
    else if (/^retired/.test(t)) types.add('retired');
    else if (/^obstructing/.test(t)) types.add('obstructing');
    else if (/^not out/.test(t)) types.add('not out');
    else if (/^timed out/.test(t)) types.add('timed out');
    else if (/^handled the ball/.test(t)) types.add('handled the ball');
  }
  return types;
}

function runReview() {
  const issues = [];
  const warnings = [];

  // --- 1. Collect known dismissal types from previous raw files ---
  const knownDismissals = new Set();
  if (fs.existsSync(RAW_DIR)) {
    const prevFiles = fs.readdirSync(RAW_DIR)
      .filter(f => f.endsWith('.txt') && path.join(RAW_DIR, f) !== path.resolve(rawFile));
    for (const f of prevFiles) {
      const prevText = fs.readFileSync(path.join(RAW_DIR, f), 'utf8');
      for (const d of collectDismissalTypes(prevText)) {
        knownDismissals.add(d);
      }
    }
  }

  const currentDismissals = collectDismissalTypes(rawText);
  if (knownDismissals.size > 0) {
    const newDismissals = [...currentDismissals].filter(d => !knownDismissals.has(d));
    if (newDismissals.length > 0) {
      warnings.push(`New dismissal type(s) not seen in previous matches: ${newDismissals.join(', ')}`);
      warnings.push(`  → Verify the parser handles these correctly.`);
    }
  }

  // --- 2. Collect known unmatched names from previous raw files ---
  // We can't re-parse previous files fully here (too heavy), so just flag unmatched count
  if (unmatched.length > 0) {
    // Check which unmatched names are new vs known from previous CSVs
    const knownUnmatched = new Set();
    if (fs.existsSync(MATCHES_DIR)) {
      const prevCSVs = fs.readdirSync(MATCHES_DIR).filter(f => f.endsWith('.csv'));
      for (const f of prevCSVs) {
        const csvContent = fs.readFileSync(path.join(MATCHES_DIR, f), 'utf8');
        // Unmatched players don't appear in CSVs, but we can check which scorecard names
        // from the current file have appeared as matched names in previous CSVs
        for (const line of csvContent.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || !trimmed) continue;
          const cols = trimmed.split(',').map(c => c.trim());
          if (cols.length >= 2) knownUnmatched.add(normalize(cols[1]));
        }
      }
    }

    const trulyNewUnmatched = unmatched.filter(name => {
      // If a name was previously matched in a CSV, it being unmatched now is unusual
      return false; // All unmatched names are worth reporting
    });

    warnings.push(`${unmatched.length} scorecard name(s) not in fantasy roster:`);
    for (const name of unmatched) {
      warnings.push(`  - "${name}"`);
    }
    warnings.push(`  → These are expected for non-auctioned players. If any look wrong, fix the raw file.`);
  }

  // --- 3. Stats sanity checks ---
  for (const [scorecardName, stats] of Object.entries(playerStats)) {
    const b = stats.batting;
    const w = stats.bowling;

    // Batting sanity
    if (b.runs > 200) {
      issues.push(`⚠ ${scorecardName}: ${b.runs} runs — unusually high. Parsing error?`);
    }
    if (b.fours > 25 || b.sixes > 20) {
      issues.push(`⚠ ${scorecardName}: ${b.fours} fours / ${b.sixes} sixes — check boundaries.`);
    }
    if (b.fours * 4 + b.sixes * 6 > b.runs) {
      issues.push(`⚠ ${scorecardName}: boundaries (${b.fours}×4 + ${b.sixes}×6 = ${b.fours*4+b.sixes*6}) exceed total runs (${b.runs}).`);
    }

    // Bowling sanity
    if (w.wickets > 8) {
      issues.push(`⚠ ${scorecardName}: ${w.wickets} wickets — unusually high.`);
    }
    if (w.dots > 30) {
      issues.push(`⚠ ${scorecardName}: ${w.dots} dots — unusually high.`);
    }
    if (w.maidens > 4) {
      issues.push(`⚠ ${scorecardName}: ${w.maidens} maidens — unusually high for T20.`);
    }
  }

  // --- 4. Innings player count ---
  // Count batsmen per innings from the raw file
  const inningsHeaders = [];
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li].trim();
    if (/\(\d+ ovs? maximum\)/.test(l) || /\(T:.*runs from/.test(l)) {
      inningsHeaders.push({ line: li, name: l.replace(/\s*\(.*$/, '').trim() });
    }
  }

  // Count matched playing players per scorecard team
  const playingCount = Object.values(matchedPlayers).filter(s => s.playing).length;
  if (playingCount < 15) {
    warnings.push(`Only ${playingCount} fantasy players marked as playing (expected ~15-22 across both teams).`);
    warnings.push(`  → Some players may not have been parsed. Check the raw file format.`);
  }

  // --- 5. Team detection check ---
  if (teams.length < 2) {
    issues.push(`Could only detect ${teams.length} team(s) from scorecard headers. Expected 2.`);
    issues.push(`  → Check that the raw file has innings headers like "Team Name  (20 ovs maximum)".`);
  }

  // --- 6. Scoring format check: look for unexpected patterns ---
  let hasTabSeparated = false;
  let hasCommaSeparated = false;
  for (const line of lines) {
    if (/^\d+\t\d+\t\d+/.test(line.trim())) hasTabSeparated = true;
    if (/^\d+,\d+,\d+/.test(line.trim())) hasCommaSeparated = true;
  }
  if (hasCommaSeparated && !hasTabSeparated) {
    issues.push(`Raw file appears to use comma-separated stats instead of tab-separated.`);
    issues.push(`  → Parser expects tab-separated ESPN Cricinfo format.`);
  }

  return { issues, warnings };
}

const review = runReview();

if (!forceFlag && review.issues.length > 0) {
  console.log(banner('REVIEW: ISSUES FOUND', c.red));
  console.log(`  Fix these issues in the raw file before converting:\n`);
  for (const issue of review.issues) {
    console.log(`  ${c.red}✗${c.reset} ${issue}`);
  }
  if (review.warnings.length > 0) {
    console.log(`\n${sectionHeader('Warnings (may be OK)')}\n`);
    for (const w of review.warnings) {
      console.log(`    ! ${w}`);
    }
  }
  console.log(`\n  Re-run after fixing, or use --force to skip review.\n`);
  process.exit(1);
}

if (review.warnings.length > 0) {
  console.log(banner('REVIEW: WARNINGS', c.blue));
  for (const w of review.warnings) {
    console.log(`  ! ${w}`);
  }
  console.log('');
}

if (review.issues.length === 0 && review.warnings.length === 0) {
  console.log(`\n  ${c.green}✓ Review passed — no issues found.${c.reset}\n`);
}

// ========== Man of the Match selection ==========

async function selectMoM() {
  const inquirer = (await import('inquirer')).default;

  // Build list of matched playing players, grouped by team
  const momCandidates = [];
  for (const [id, stats] of Object.entries(matchedPlayers)) {
    if (!stats.playing) continue;
    const p = allPlayers.find(pl => pl.id === parseInt(id));
    if (p) momCandidates.push({ id, player: p, stats });
  }

  // Sort by team, then by runs descending
  momCandidates.sort((a, b) => {
    if (a.player.iplTeam !== b.player.iplTeam) return a.player.iplTeam.localeCompare(b.player.iplTeam);
    return b.stats.batting.runs - a.stats.batting.runs;
  });

  // Build inquirer choices with separators per team
  const choices = [];
  let lastTeam = '';
  for (const cand of momCandidates) {
    if (cand.player.iplTeam !== lastTeam) {
      lastTeam = cand.player.iplTeam;
      choices.push(new inquirer.Separator(`${c.dim}  ── ${lastTeam} ${'─'.repeat(30)}${c.reset}`));
    }
    const b = cand.stats.batting, w = cand.stats.bowling, f = cand.stats.fielding;
    const parts = [];
    if (b.runs) parts.push(`${b.runs}r`);
    if (w.wickets) parts.push(`${w.wickets}w`);
    if (f.catches) parts.push(`${f.catches}ct`);
    if (f.runoutDirect) parts.push(`${f.runoutDirect}ro`);
    if (f.stumpings) parts.push(`${f.stumpings}st`);
    const statStr = parts.length ? `  ${c.dim}─ ${parts.join(', ')}${c.reset}` : '';
    choices.push({
      name: `${cand.player.name}${statStr}`,
      value: cand.id,
      short: cand.player.name,
    });
  }

  choices.push(new inquirer.Separator(`${c.dim}  ${'─'.repeat(40)}${c.reset}`));
  choices.push({
    name: `${c.dim}None / Skip${c.reset}`,
    value: null,
    short: 'None',
  });

  console.log(banner('Man of the Match', c.blue));

  const { mom } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mom',
      message: 'Select the Man of the Match',
      choices,
      pageSize: 20,
      loop: false,
    },
  ]);

  if (mom) {
    const selected = momCandidates.find(ca => ca.id === mom);
    if (selected) {
      selected.stats.mom = true;
      console.log(`\n  ${c.green}★ Man of the Match: ${selected.player.name}${c.reset}\n`);
    }
  } else {
    console.log(`\n  No Man of the Match selected.\n`);
  }
}

const iplTeamList = teams.map(t => teamAbbr(t));

// Also include teams from matched players (in case some players are on different teams in cache)
const iplTeamsFromPlayers = new Set(iplTeamList);
for (const [id, stats] of Object.entries(matchedPlayers)) {
  const p = allPlayers.find(pl => pl.id === parseInt(id));
  if (p) iplTeamsFromPlayers.add(p.iplTeam);
}

// Get all fantasy players from those IPL teams
const teamPlayers = allPlayers.filter(p => iplTeamsFromPlayers.has(p.iplTeam));

// ========== MoM prompt then generate CSV ==========
(async () => {
await selectMoM();

// ========== Generate CSV ==========
const today = new Date().toISOString().split('T')[0];
const title = iplTeamList.length >= 2
  ? `${iplTeamList[0]} vs ${iplTeamList[1]} - Match ${matchNum}`
  : `Match ${matchNum}`;

let csv = `# ${title}\n`;
csv += `# ${today}\n`;
csv += `#\n`;
csv += `# id, name, ipl_team, fantasy_team, playing, mom, runs, 4s, 6s, wkts, dots, maidens, lbw_b_hw, catches, ro_direct, ro_indirect, stumpings\n`;
csv += `\n`;

// Group by scorecard teams first, then any extra teams from player cache
const allIplTeams = [...new Set([...iplTeamList, ...iplTeamsFromPlayers])];
for (const iplTeam of allIplTeams) {
  csv += `# --- ${iplTeam} ---\n`;
  const tp = teamPlayers.filter(p => p.iplTeam === iplTeam);
  for (const p of tp) {
    const s = matchedPlayers[p.id];
    if (s) {
      csv += `${p.id}, ${p.name}, ${p.iplTeam}, ${p.fantasyTeam}, ${s.playing?1:0}, ${s.mom?1:0}, ${s.batting.runs}, ${s.batting.fours}, ${s.batting.sixes}, ${s.bowling.wickets}, ${s.bowling.dots}, ${s.bowling.maidens}, ${s.bowling.lbwBowledHw}, ${s.fielding.catches}, ${s.fielding.runoutDirect}, ${s.fielding.runoutIndirect}, ${s.fielding.stumpings}\n`;
    } else {
      csv += `${p.id}, ${p.name}, ${p.iplTeam}, ${p.fantasyTeam}, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0\n`;
    }
  }
  csv += `\n`;
}

// Write CSV
if (!fs.existsSync(MATCHES_DIR)) fs.mkdirSync(MATCHES_DIR, { recursive: true });
const outFile = path.join(MATCHES_DIR, `match-${matchNum}.csv`);

if (fs.existsSync(outFile)) {
  console.error(`\n  ${c.red}✗ File exists: ${outFile} — delete it first or use a different number.${c.reset}\n`);
  process.exit(1);
}

fs.writeFileSync(outFile, csv);

// ========== Summary ==========
console.log(banner(`${title}`, c.green));

console.log(`  ${c.green}✓${c.reset} Created: ${outFile}`);
console.log(`    Fantasy players matched: ${Object.keys(matchedPlayers).length}  |  Playing: ${Object.values(matchedPlayers).filter(s => s.playing).length}\n`);

if (unmatched.length > 0) {
  console.log(`${sectionHeader('Not in fantasy roster (OK if not auctioned)')}`);
  for (const name of unmatched) {
    console.log(`    • ${name}`);
  }
  console.log('');
}

console.log(`${sectionHeader('Matched players')}\n`);
for (const [id, stats] of Object.entries(matchedPlayers)) {
  const p = allPlayers.find(pl => pl.id === parseInt(id));
  const b = stats.batting, w = stats.bowling, f = stats.fielding;
  const parts = [];
  if (b.runs) parts.push(`${b.runs}r`);
  if (w.wickets) parts.push(`${w.wickets}w`);
  if (f.catches) parts.push(`${f.catches}ct`);
  if (f.runoutDirect) parts.push(`${f.runoutDirect}ro`);
  if (f.stumpings) parts.push(`${f.stumpings}st`);
  const momTag = stats.mom ? ` ${c.green}★ MoM${c.reset}` : '';
  const nameStr = p ? p.name : `ID:${id}`;
  const teamStr = p ? p.fantasyTeam : '?';
  console.log(`    ${nameStr} ${c.dim}(${teamStr})${c.reset}${momTag} ${c.dim}─${c.reset} ${parts.join(', ') || `${c.dim}playing only${c.reset}`}`);
}

console.log(`\n  Review the CSV, then refresh the site.\n`);
})();
