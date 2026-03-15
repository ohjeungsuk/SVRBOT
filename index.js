// index.js (discord.js v12.5.3 + Google Sheets logger + !복귀 + PartyBeast room renumber )
// Required Heroku Config Vars:
// - DISCORD_TOKEN
// - GOOGLE_SA_JSON_B64
// Optional:
//
// Recommended Heroku dynos: worker=1, web=0

const Discord = require('discord.js');
const { google } = require('googleapis');
const client = new Discord.Client({
  partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
  ws: {
    intents: [
      'GUILDS',
      'GUILD_MEMBERS',
      'GUILD_MESSAGES',
      'GUILD_MESSAGE_REACTIONS',
      'GUILD_VOICE_STATES',
    ],
  },
});

const prefix = '!';
let latestTeams = []; // [[memberId...], ...]
let latestTeamsMeta = { guildId: '', textChannelId: '', voiceChannelId: '', createdAtMs: 0 };

// ---- Google Sheets Settings ----
const TARGET_CHANNEL_ID = '1439239707320909895';
const SPREADSHEET_ID = '1WzlRm6jlOGxTz4dTgbdMopzcJCNop8dnz7kP9GsMXZs';
const SHEET_TITLE_FIXED = '카톡외출목록';
const BACKUP_MAX_MESSAGES = 20000;

// ---- 복귀(대기실) Settings ----
const WAITING_ROOM_VOICE_ID = '1453266042439860224';
const lastDisbandedMemberIds = new Set(); // !해산으로 이동된 사람 id 저장

// ---- 팀/해산 명령 채널 기준 ----
// !팀, !해산 은 아래 텍스트 채널에서만 동작하도록 제한한다.
const TEAM_COMMAND_TEXT_CHANNEL_ID = '1450859016665432134';

// ---- Activity Filter Command Channel ----
// 필터 관련 명령은 관리자만 볼 수 있는 이 텍스트 채널에서만 동작한다.
// 현재는 팀 명령 채널과 동일 ID를 사용한다.
const FILTER_COMMAND_TEXT_CHANNEL_ID = '1482589757551939675';

// ---- Activity Filter Settings ----
const FILTER_CHAT_CHANNEL_IDS = [
  '1439240703887671357',
];
const FILTER_RECRUIT_CHANNEL_IDS = [
  '1456630730435068138',
];
const FILTER_VOICE_CATEGORY_IDS = [
  '1453251021282476084',
];
const FILTER_VOICE_MINUTES_REQUIRED = 10;
const FILTER_DEFAULT_PERIOD_MINUTES = 1;
const FILTER_CONFIG_SHEET_TITLE = '활동필터설정';
const FILTER_STATE_SHEET_TITLE = '활동필터상태';
const FILTER_LOG_SHEET_TITLE = '활동필터로그';

// ---- PartyBeast Room Renumber Settings ----
const REN_NUMBER_DELAY_MS = 2000;      // 파티비스트 생성/삭제 이후 기다리는 시간
const REN_RENAME_GAP_MS = 700;         // rename 연속 호출 간 간격(레이트리밋 완화)

const MANAGED_ROOM_CATEGORIES = [
  { categoryId: '1453251021282476084', prefix: '일반방' },
  { categoryId: '1453251462586171446', prefix: '경쟁방' },
  { categoryId: '1453257882438205531', prefix: '빡겜방' },
];

const managedCategoryMap = new Map();
for (let i = 0; i < MANAGED_ROOM_CATEGORIES.length; i++) {
  managedCategoryMap.set(String(MANAGED_ROOM_CATEGORIES[i].categoryId), MANAGED_ROOM_CATEGORIES[i]);
}

// ---- 전부이동 상태 관리 ----
const moveAllStateByUser = new Map(); // userId -> { guildId, sourceChannelId, createdAtMs }
const MOVEALL_TIMEOUT_MS = 60000;     // 60초 안에 목적 채널 이름을 받아야 유효

const filterTrackedChatChannelIds = new Set(FILTER_CHAT_CHANNEL_IDS.map((v) => String(v)));
const filterTrackedRecruitChannelIds = new Set(FILTER_RECRUIT_CHANNEL_IDS.map((v) => String(v)));
const filterTrackedVoiceCategoryIds = new Set(FILTER_VOICE_CATEGORY_IDS.map((v) => String(v)));

let filterSheetsReady = false;
let filterDataReady = false;
let filterConfig = {
  periodMinutes: null,
  periodSetAtKST: '',
  testTargetIds: [],
  targetMode: 'test',
};
const filterStateByUserId = new Map();

const FILTER_STATE_COLUMNS = [
  'userId',
  'username',
  'displayName',
  'isTestTarget',
  'trackingStartAtKST',
  'lastChatAtKST',
  'lastRecruitAtKST',
  'voiceMinutes',
  'passReason',
  'passedAtKST',
  'lastVoiceJoinAtKST',
  'lastVoiceChannelId',
  'kicked',
  'kickedAtKST',
  'updatedAtKST',
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function isAdminMember(member) {
  if (!member || !member.hasPermission) return false;
  try { return member.hasPermission('ADMINISTRATOR'); } catch (e) { return false; }
}

function isTeamCommandTextChannel(message) {
  if (!message || !message.channel) return false;
  return String(message.channel.id) === String(TEAM_COMMAND_TEXT_CHANNEL_ID);
}

function isFilterCommandTextChannel(message) {
  if (!message || !message.channel) return false;
  return String(message.channel.id) === String(FILTER_COMMAND_TEXT_CHANNEL_ID);
}

async function ensureFilterCommandAccess(message) {
  if (!isAdminMember(message.member)) {
    try { await message.reply('권한이 없다.'); } catch (e) {}
    return false;
  }

  if (!isFilterCommandTextChannel(message)) {
    try { await message.reply('이 명령어는 관리자 전용 필터 채널에서만 사용할 수 있다.'); } catch (e) {}
    return false;
  }

  return true;
}

// 팀 셔플용: Fisher–Yates 셔플
function shuffleArray(inputArray) {
  const arr = inputArray.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// members 배열을 팀 단위로 나누기
function buildTeamsFromMembersArray(membersArray, teamSize) {
  const teams = [];
  for (let i = 0; i < membersArray.length; i += teamSize) {
    const teamMembers = membersArray.slice(i, i + teamSize);
    teams.push(teamMembers);
  }
  return teams;
}

// 이전 팀(latestTeams)과 새 팀(teamsMembers)이 얼마나 비슷한지 평가
// 반환: { ratio } - 1.0에 가까울수록 "이전 팀과 많이 비슷", 0에 가까울수록 "많이 다름"
function evaluateTeamDifference(prevTeams, newTeamsMembers) {
  if (!prevTeams || !Array.isArray(prevTeams) || prevTeams.length === 0) {
    // 비교 기준이 없으면 "완전 새로"라고 보고 ratio 0.0 취급
    return { ratio: 0.0 };
  }

  // 새 팀을 ID 배열로 변환
  const newTeamsIds = [];
  const memberSet = new Set();
  for (let i = 0; i < newTeamsMembers.length; i++) {
    const team = newTeamsMembers[i];
    const ids = [];
    for (let j = 0; j < team.length; j++) {
      const id = String(team[j].id);
      ids.push(id);
      memberSet.add(id);
    }
    newTeamsIds.push(ids);
  }

  const prevTeamsIds = [];
  for (let i = 0; i < prevTeams.length; i++) {
    const t = prevTeams[i];
    const ids = [];
    for (let j = 0; j < t.length; j++) {
      ids.push(String(t[j]));
    }
    prevTeamsIds.push(ids);
  }

  if (newTeamsIds.length === 0 || memberSet.size === 0) {
    return { ratio: 0.0 };
  }

  // 멤버별 이전 팀 인덱스
  const prevTeamIndexByMember = {};
  for (let i = 0; i < prevTeamsIds.length; i++) {
    const team = prevTeamsIds[i];
    for (let j = 0; j < team.length; j++) {
      prevTeamIndexByMember[team[j]] = i;
    }
  }

  const prevTeamCount = prevTeamsIds.length;
  const newTeamCount = newTeamsIds.length;

  if (prevTeamCount === 0 || newTeamCount === 0) {
    return { ratio: 0.0 };
  }

  // overlap[prevTeamIndex][newTeamIndex] = 겹치는 인원 수
  const overlap = [];
  for (let i = 0; i < prevTeamCount; i++) {
    const row = [];
    for (let j = 0; j < newTeamCount; j++) row.push(0);
    overlap.push(row);
  }

  for (let j = 0; j < newTeamsIds.length; j++) {
    const newTeam = newTeamsIds[j];
    for (let k = 0; k < newTeam.length; k++) {
      const id = newTeam[k];
      const pi = prevTeamIndexByMember[id];
      if (pi === 0 || (pi && pi >= 0)) {
        overlap[pi][j] = overlap[pi][j] + 1;
      }
    }
  }

  let totalSimilarMembers = 0;
  const totalMembers = memberSet.size;

  for (let j = 0; j < newTeamCount; j++) {
    const newSize = newTeamsIds[j].length;
    if (newSize === 0) continue;

    let maxOverlap = 0;
    for (let i = 0; i < prevTeamCount; i++) {
      if (overlap[i][j] > maxOverlap) maxOverlap = overlap[i][j];
    }
    // 각 새 팀에서 "이전 팀과 가장 많이 겹치는 인원 수"를 유사도로 본다.
    totalSimilarMembers += maxOverlap;
  }

  const ratio = totalMembers > 0 ? (totalSimilarMembers / totalMembers) : 0.0;
  return { ratio: ratio };
}

// sheet job serialize
let sheetQueue = Promise.resolve();
function enqueueSheetJob(fn) {
  sheetQueue = sheetQueue.then(fn).catch((err) => {
    console.error('[SheetJobError]', err && err.stack ? err.stack : err);
  });
  return sheetQueue;
}


function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing env var: ' + name);
  return v;
}

function safeShort(str, maxLen) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

async function sendLongText(channel, text) {
  if (!channel || !text) return;

  const src = String(text);
  const limit = 1900;
  if (src.length <= limit) {
    await channel.send(src);
    return;
  }

  let start = 0;
  while (start < src.length) {
    let end = Math.min(start + limit, src.length);
    if (end < src.length) {
      const cut = src.lastIndexOf('\n', end);
      if (cut > start + 200) end = cut;
    }
    await channel.send(src.slice(start, end));
    start = end;
  }
}

function normalizePeriodMinutesInput(value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) return null;
  if (n > 10080) return 10080;
  return n;
}

function isFilterTrackedTextChannel(message, channelIdSet) {
  if (!message || !message.channel) return false;

  const cid = String(message.channel.id);
  if (channelIdSet.has(cid)) return true;

  if (message.channel.parentID && channelIdSet.has(String(message.channel.parentID))) {
    return true;
  }

  return false;
}

function isTrackedVoiceChannel(channel) {
  if (!channel) return false;
  if (channel.type !== 'voice') return false;
  if (!channel.parentID) return false;
  if (!filterTrackedVoiceCategoryIds.has(String(channel.parentID))) return false;
  if (String(channel.name || '').indexOf('[관전]') >= 0) return false;
  return true;
}

function parseKSTStringToDate(kstText) {
  if (!kstText) return null;
  const m = String(kstText).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = parseInt(m[6], 10);

  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second));
}

function diffMinutesFloor(fromDate, toDate) {
  if (!fromDate || !toDate) return 0;
  const ms = toDate.getTime() - fromDate.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / 60000);
}

function filterStateToRow(state) {
  return [
    state.userId || '',
    state.username || '',
    state.displayName || '',
    state.isTestTarget || 'N',
    state.trackingStartAtKST || '',
    state.lastChatAtKST || '',
    state.lastRecruitAtKST || '',
    String(state.voiceMinutes || '0'),
    state.passReason || '',
    state.passedAtKST || '',
    state.lastVoiceJoinAtKST || '',
    state.lastVoiceChannelId || '',
    state.kicked || 'N',
    state.kickedAtKST || '',
    state.updatedAtKST || '',
  ];
}

function rowToFilterState(row, rowNumber) {
  const src = Array.isArray(row) ? row : [];
  return {
    rowNumber: rowNumber,
    userId: src[0] ? String(src[0]) : '',
    username: src[1] ? String(src[1]) : '',
    displayName: src[2] ? String(src[2]) : '',
    isTestTarget: src[3] === 'Y' ? 'Y' : 'N',
    trackingStartAtKST: src[4] ? String(src[4]) : '',
    lastChatAtKST: src[5] ? String(src[5]) : '',
    lastRecruitAtKST: src[6] ? String(src[6]) : '',
    voiceMinutes: src[7] ? String(src[7]) : '0',
    passReason: src[8] ? String(src[8]) : '',
    passedAtKST: src[9] ? String(src[9]) : '',
    lastVoiceJoinAtKST: src[10] ? String(src[10]) : '',
    lastVoiceChannelId: src[11] ? String(src[11]) : '',
    kicked: src[12] === 'Y' ? 'Y' : 'N',
    kickedAtKST: src[13] ? String(src[13]) : '',
    updatedAtKST: src[14] ? String(src[14]) : '',
  };
}

async function ensureSheetWithHeader(title, header) {
  await initSheets();

  const existing = await listSheetTitles();
  if (existing.indexOf(title) < 0) {
    await createSheetTab(title);
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: a1Range(title, 'A1:' + String.fromCharCode(64 + header.length) + '1'),
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
    return;
  }

  const read = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: a1Range(title, 'A1:' + String.fromCharCode(64 + header.length) + '1'),
  });
  const values = read && read.data && read.data.values ? read.data.values : [];
  const row = values.length > 0 ? values[0] : [];
  let needWrite = false;
  for (let i = 0; i < header.length; i++) {
    if (String(row[i] || '') !== String(header[i])) {
      needWrite = true;
      break;
    }
  }
  if (needWrite) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: a1Range(title, 'A1:' + String.fromCharCode(64 + header.length) + '1'),
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  }
}

async function ensureFilterSheetsReady() {
  if (filterSheetsReady) return;

  await ensureSheetWithHeader(FILTER_CONFIG_SHEET_TITLE, ['key', 'value']);
  await ensureSheetWithHeader(FILTER_STATE_SHEET_TITLE, [
    'user_id', 'username', 'display_name', 'is_test_target', 'tracking_start_at_kst',
    'last_chat_at_kst', 'last_recruit_at_kst', 'voice_minutes', 'pass_reason', 'passed_at_kst',
    'last_voice_join_at_kst', 'last_voice_channel_id', 'kicked', 'kicked_at_kst', 'updated_at_kst'
  ]);
  await ensureSheetWithHeader(FILTER_LOG_SHEET_TITLE, ['time_kst', 'type', 'user_id', 'username', 'display_name', 'detail']);

  filterSheetsReady = true;
}

async function loadFilterConfigFromSheet() {
  await ensureFilterSheetsReady();

  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: a1Range(FILTER_CONFIG_SHEET_TITLE, 'A2:B20'),
  });

  const values = res && res.data && res.data.values ? res.data.values : [];
  const nextConfig = {
    periodMinutes: null,
    periodSetAtKST: '',
    testTargetIds: [],
    targetMode: 'test',
  };

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const key = row[0] ? String(row[0]) : '';
    const value = row[1] ? String(row[1]) : '';

    if (key === 'period_minutes' || key === 'period_days') {
      const n = normalizePeriodMinutesInput(value);
      if (n) nextConfig.periodMinutes = n;
    } else if (key === 'period_set_at_kst') {
      nextConfig.periodSetAtKST = value ? String(value) : '';
    } else if (key === 'test_target_ids') {
      nextConfig.testTargetIds = value
        ? value.split(',').map((v) => String(v).trim()).filter((v) => v.length > 0)
        : [];
    } else if (key === 'target_mode') {
      nextConfig.targetMode = value === 'all' ? 'all' : 'test';
    }
  }

  filterConfig = nextConfig;
}

async function saveFilterConfigToSheet() {
  await ensureFilterSheetsReady();

  const nowKST = formatKSTFromDate(new Date());
  const values = [
    ['period_minutes', filterConfig.periodMinutes ? String(filterConfig.periodMinutes) : ''],
    ['period_set_at_kst', filterConfig.periodSetAtKST || ''],
    ['test_target_ids', (filterConfig.testTargetIds || []).join(',')],
    ['target_mode', filterConfig.targetMode === 'all' ? 'all' : 'test'],
    ['updated_at', nowKST],
  ];

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: a1Range(FILTER_CONFIG_SHEET_TITLE, 'A2:B6'),
    valueInputOption: 'RAW',
    requestBody: { values: values },
  });
}

async function loadFilterStateFromSheet() {
  await ensureFilterSheetsReady();

  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: a1Range(FILTER_STATE_SHEET_TITLE, 'A2:O'),
  });

  const values = res && res.data && res.data.values ? res.data.values : [];
  filterStateByUserId.clear();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const state = rowToFilterState(values[i], rowNumber);
    if (!state.userId) continue;
    filterStateByUserId.set(String(state.userId), state);
  }
}

async function ensureFilterDataLoaded() {
  if (filterDataReady) return;
  await loadFilterConfigFromSheet();
  await loadFilterStateFromSheet();
  filterDataReady = true;
}

async function appendFilterLog(type, memberOrState, detail) {
  await ensureFilterSheetsReady();

  const nowKST = formatKSTFromDate(new Date());
  let userId = '';
  let username = '';
  let displayName = '';

  if (memberOrState) {
    if (memberOrState.user && memberOrState.id) {
      userId = String(memberOrState.id || '');
      username = memberOrState.user && memberOrState.user.username ? String(memberOrState.user.username) : '';
      displayName = memberOrState.displayName ? String(memberOrState.displayName) : username;
    } else {
      userId = memberOrState.userId ? String(memberOrState.userId) : '';
      username = memberOrState.username ? String(memberOrState.username) : '';
      displayName = memberOrState.displayName ? String(memberOrState.displayName) : '';
    }
  }

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: a1Range(FILTER_LOG_SHEET_TITLE, 'A:F'),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[nowKST, String(type || ''), userId, username, displayName, String(detail || '')]] },
  });
}

function getFilterState(userId) {
  return filterStateByUserId.get(String(userId)) || null;
}

function isCurrentTestTargetId(userId) {
  return filterConfig.testTargetIds.indexOf(String(userId)) >= 0;
}

function isFilterTargetModeAll() {
  return String(filterConfig && filterConfig.targetMode ? filterConfig.targetMode : 'test') === 'all';
}

function isFilterTargetUserId(userId) {
  if (isFilterTargetModeAll()) return true;
  return isCurrentTestTargetId(userId);
}

function isFilterPeriodReady() {
  return !!(filterConfig && filterConfig.periodMinutes && filterConfig.periodSetAtKST);
}

function getFilterPeriodMs() {
  const minutes = parseInt(filterConfig && filterConfig.periodMinutes ? filterConfig.periodMinutes : '0', 10) || 0;
  return minutes * 60 * 1000;
}

function getFilterTargetModeLabel() {
  return isFilterTargetModeAll() ? '전체' : '테스트';
}

function buildEmptyFilterStateForMember(member, nowDate) {
  const nowKST = formatKSTFromDate(nowDate || new Date());
  return {
    rowNumber: null,
    userId: String(member.id),
    username: member.user && member.user.username ? String(member.user.username) : '',
    displayName: member.displayName ? String(member.displayName) : (member.user && member.user.username ? String(member.user.username) : ''),
    isTestTarget: 'Y',
    trackingStartAtKST: nowKST,
    lastChatAtKST: '',
    lastRecruitAtKST: '',
    voiceMinutes: '0',
    passReason: '',
    passedAtKST: '',
    lastVoiceJoinAtKST: '',
    lastVoiceChannelId: '',
    kicked: 'N',
    kickedAtKST: '',
    updatedAtKST: nowKST,
  };
}

async function saveFilterState(state) {
  await ensureFilterSheetsReady();

  const row = filterStateToRow(state);
  if (state.rowNumber) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: a1Range(FILTER_STATE_SHEET_TITLE, 'A' + state.rowNumber + ':O' + state.rowNumber),
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  } else {
    const res = await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: a1Range(FILTER_STATE_SHEET_TITLE, 'A:O'),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    const updatedRange = res && res.data && res.data.updates ? res.data.updates.updatedRange : null;
    const rowNum = extractRowNumberFromUpdatedRange(updatedRange);
    if (rowNum) state.rowNumber = rowNum;
  }

  filterStateByUserId.set(String(state.userId), state);
}

async function setFilterPass(state, reason, eventDate, extraDetail) {
  const nowDate = eventDate || new Date();
  const nowKST = formatKSTFromDate(nowDate);

  state.passReason = String(reason || '');
  state.passedAtKST = nowKST;
  state.updatedAtKST = nowKST;
  state.lastVoiceJoinAtKST = '';
  state.lastVoiceChannelId = '';

  await saveFilterState(state);
  await appendFilterLog('PASS', state, 'reason=' + state.passReason + (extraDetail ? ' ' + extraDetail : ''));
}

async function updateFilterActivityForMessage(message, activityType) {
  if (!message || !message.guild || !message.member) return;

  await ensureFilterDataLoaded();

  const userId = String(message.author.id);
  if (!isFilterTargetUserId(userId)) return;

  let state = getFilterState(userId);
  if (!state) {
    state = buildEmptyFilterStateForMember(message.member, message.createdAt || new Date());
  }

  if (state.kicked === 'Y' || state.passedAtKST) return;

  const eventKST = formatKSTFromDate(message.createdAt || new Date());
  state.username = message.author.username ? String(message.author.username) : state.username;
  state.displayName = message.member.displayName ? String(message.member.displayName) : state.displayName;
  state.isTestTarget = 'Y';
  state.updatedAtKST = eventKST;

  if (activityType === 'chat') state.lastChatAtKST = eventKST;
  if (activityType === 'recruit') state.lastRecruitAtKST = eventKST;

  await saveFilterState(state);
  await setFilterPass(state, activityType, message.createdAt || new Date(), 'channel=' + String(message.channel.id));
}

async function finalizeVoiceMinutesForState(state, leaveDate) {
  if (!state || !state.lastVoiceJoinAtKST) return;

  const joinDate = parseKSTStringToDate(state.lastVoiceJoinAtKST);
  const endDate = leaveDate || new Date();
  const minutes = diffMinutesFloor(joinDate, endDate);
  const current = parseInt(state.voiceMinutes || '0', 10) || 0;
  const nextMinutes = current + minutes;
  const nowKST = formatKSTFromDate(endDate);

  state.voiceMinutes = String(nextMinutes);
  state.lastVoiceJoinAtKST = '';
  state.lastVoiceChannelId = '';
  state.updatedAtKST = nowKST;

  await saveFilterState(state);
  await appendFilterLog('VOICE_ACCUM', state, 'added=' + minutes + ' total=' + nextMinutes);

  if (!state.passedAtKST && nextMinutes >= FILTER_VOICE_MINUTES_REQUIRED) {
    await setFilterPass(state, 'voice', endDate, 'minutes=' + nextMinutes);
  }
}

async function startVoiceTrackingForState(state, channel, startDate) {
  const nowDate = startDate || new Date();
  const nowKST = formatKSTFromDate(nowDate);

  state.lastVoiceJoinAtKST = nowKST;
  state.lastVoiceChannelId = channel ? String(channel.id) : '';
  state.updatedAtKST = nowKST;

  await saveFilterState(state);
  await appendFilterLog('VOICE_JOIN', state, 'channel=' + (channel ? String(channel.id) : ''));
}

async function handleTrackedVoiceTransition(oldState, newState) {
  const member = newState && newState.member ? newState.member : (oldState ? oldState.member : null);
  if (!member || !member.user || member.user.bot) return;

  await ensureFilterDataLoaded();

  const userId = String(member.id);
  if (!isFilterTargetUserId(userId)) return;

  let state = getFilterState(userId);
  if (!state) {
    state = buildEmptyFilterStateForMember(member, new Date());
  }

  if (state.kicked === 'Y' || state.passedAtKST) return;

  state.username = member.user.username ? String(member.user.username) : state.username;
  state.displayName = member.displayName ? String(member.displayName) : state.displayName;
  state.isTestTarget = 'Y';

  const beforeChannel = oldState ? oldState.channel : null;
  const afterChannel = newState ? newState.channel : null;
  const beforeTracked = isTrackedVoiceChannel(beforeChannel);
  const afterTracked = isTrackedVoiceChannel(afterChannel);

  if (beforeTracked && (!afterTracked || String(beforeChannel.id) !== String(afterChannel ? afterChannel.id : ''))) {
    await finalizeVoiceMinutesForState(state, new Date());
    if (state.passedAtKST) return;
  }

  if (afterTracked && (!beforeTracked || String(beforeChannel ? beforeChannel.id : '') !== String(afterChannel.id))) {
    await startVoiceTrackingForState(state, afterChannel, new Date());
  }
}

async function setFilterPeriodMinutes(minutes) {
  filterConfig.periodMinutes = minutes;
  filterConfig.periodSetAtKST = formatKSTFromDate(new Date());
  await saveFilterConfigToSheet();
  await appendFilterLog('PERIOD_SET', null, 'minutes=' + String(minutes));
}

async function setTestTargetsFromMembers(members) {
  await ensureFilterDataLoaded();

  const uniqueMap = new Map();
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (!member || !member.id || !member.user || member.user.bot) continue;
    uniqueMap.set(String(member.id), member);
  }

  const nowDate = new Date();
  const nowKST = formatKSTFromDate(nowDate);
  const newIds = Array.from(uniqueMap.keys());

  const oldIds = filterConfig.testTargetIds ? filterConfig.testTargetIds.slice() : [];
  for (let i = 0; i < oldIds.length; i++) {
    const oldId = String(oldIds[i]);
    if (newIds.indexOf(oldId) >= 0) continue;

    const oldState = getFilterState(oldId);
    if (!oldState) continue;
    oldState.isTestTarget = 'N';
    oldState.lastVoiceJoinAtKST = '';
    oldState.lastVoiceChannelId = '';
    oldState.updatedAtKST = nowKST;
    await saveFilterState(oldState);
  }

  for (let i = 0; i < newIds.length; i++) {
    const member = uniqueMap.get(newIds[i]);
    const existingState = getFilterState(newIds[i]);
    const state = buildEmptyFilterStateForMember(member, nowDate);
    if (existingState && existingState.rowNumber) state.rowNumber = existingState.rowNumber;
    await saveFilterState(state);
    await appendFilterLog('TEST_TARGET_SET', state, 'tracking_start=' + state.trackingStartAtKST);

    if (member.voice && member.voice.channel && isTrackedVoiceChannel(member.voice.channel)) {
      await startVoiceTrackingForState(state, member.voice.channel, nowDate);
    }
  }

  filterConfig.testTargetIds = newIds;
  filterConfig.targetMode = 'test';
  await saveFilterConfigToSheet();
}

async function clearTestTargets() {
  await ensureFilterDataLoaded();

  const nowKST = formatKSTFromDate(new Date());
  const oldIds = filterConfig.testTargetIds ? filterConfig.testTargetIds.slice() : [];

  for (let i = 0; i < oldIds.length; i++) {
    const state = getFilterState(oldIds[i]);
    if (!state) continue;
    state.isTestTarget = 'N';
    state.lastVoiceJoinAtKST = '';
    state.lastVoiceChannelId = '';
    state.updatedAtKST = nowKST;
    await saveFilterState(state);
    await appendFilterLog('TEST_TARGET_CLEAR', state, 'cleared');
  }

  filterConfig.testTargetIds = [];
  filterConfig.targetMode = 'test';
  await saveFilterConfigToSheet();
}

function buildFilterStatusLine(state, nowDate) {
  const now = nowDate || new Date();
  const started = parseKSTStringToDate(state.trackingStartAtKST);
  const passed = !!state.passedAtKST;
  const kicked = state.kicked === 'Y';
  const voiceMinutes = parseInt(state.voiceMinutes || '0', 10) || 0;

  if (kicked) {
    return state.displayName + ' - 이미 강퇴됨';
  }

  if (passed) {
    return state.displayName + ' - 통과 (' + state.passReason + ')';
  }

  if (!started) {
    return state.displayName + ' - 시작시간 없음';
  }

  const elapsedMs = now.getTime() - started.getTime();
  const periodMs = getFilterPeriodMs();

  if (elapsedMs < periodMs) {
    const remainMs = periodMs - elapsedMs;
    const remainMinutes = Math.ceil(remainMs / 60000);
    return state.displayName + ' - 대기중 (남은시간 약 ' + remainMinutes + '분, 음성 ' + voiceMinutes + '분)';
  }

  return state.displayName + ' - 미통과 (채팅/구인구직 없음, 음성 ' + voiceMinutes + '분)';
}

async function setAllTargetsFromGuild(guild) {
  await ensureFilterDataLoaded();

  if (!guild) throw new Error('guild_not_found');

  let fetchedMembers = null;
  try {
    fetchedMembers = await guild.members.fetch();
  } catch (e) {
    console.error('[FilterAllTargetsFetchError]', e && e.stack ? e.stack : e);
    throw e;
  }

  const nowDate = new Date();
  const nowKST = formatKSTFromDate(nowDate);
  const activeIds = [];

  fetchedMembers.forEach((member) => {
    if (!member || !member.id || !member.user || member.user.bot) return;
    activeIds.push(String(member.id));
  });

  const activeIdSet = new Set(activeIds);

  for (let i = 0; i < activeIds.length; i++) {
    const userId = activeIds[i];
    const member = fetchedMembers.get(userId);
    if (!member) continue;

    const existingState = getFilterState(userId);
    const state = buildEmptyFilterStateForMember(member, nowDate);
    if (existingState && existingState.rowNumber) state.rowNumber = existingState.rowNumber;
    await saveFilterState(state);
    await appendFilterLog('ALL_TARGET_SET', state, 'tracking_start=' + state.trackingStartAtKST);

    if (member.voice && member.voice.channel && isTrackedVoiceChannel(member.voice.channel)) {
      await startVoiceTrackingForState(state, member.voice.channel, nowDate);
    }
  }

  const allStates = Array.from(filterStateByUserId.values());
  for (let i = 0; i < allStates.length; i++) {
    const state = allStates[i];
    if (!state || !state.userId) continue;
    if (activeIdSet.has(String(state.userId))) continue;
    state.isTestTarget = 'N';
    state.lastVoiceJoinAtKST = '';
    state.lastVoiceChannelId = '';
    state.updatedAtKST = nowKST;
    await saveFilterState(state);
  }

  filterConfig.testTargetIds = activeIds;
  filterConfig.targetMode = 'all';
  await saveFilterConfigToSheet();
}

async function runFilterForCurrentTargets(message) {
  await ensureFilterDataLoaded();

  if (!isFilterPeriodReady()) {
    await message.reply('먼저 !기간 N 으로 기간부터 설정해라. 예: !기간 1');
    return;
  }

  if ((!filterConfig.testTargetIds || filterConfig.testTargetIds.length === 0) && !isFilterTargetModeAll()) {
    await message.reply('테스트 대상자가 없다. 먼저 !테스트 @대상 또는 !테스트 유저ID 형식으로 지정해라.');
    return;
  }

  const guild = message.guild;
  const nowDate = new Date();
  const resultLines = [];
  const kickTargets = [];
  const targetIds = filterConfig.testTargetIds ? filterConfig.testTargetIds.slice() : [];

  for (let i = 0; i < targetIds.length; i++) {
    const userId = String(targetIds[i]);
    const state = getFilterState(userId);
    if (!state) continue;

    resultLines.push(buildFilterStatusLine(state, nowDate));

    if (state.kicked === 'Y' || state.passedAtKST) continue;

    const started = parseKSTStringToDate(state.trackingStartAtKST);
    if (!started) continue;

    const elapsedMs = nowDate.getTime() - started.getTime();
    const periodMs = getFilterPeriodMs();
    if (elapsedMs < periodMs) continue;

    kickTargets.push(state);
  }

  await sendLongText(message.channel, [
    '**필터 결과**',
    '대상 모드: ' + getFilterTargetModeLabel(),
    '기간: ' + String(filterConfig.periodMinutes) + '분',
    '대상: ' + String(targetIds.length) + '명',
    '',
    resultLines.length > 0 ? resultLines.join('\n') : '대상 없음'
  ].join('\n'));

  for (let i = 0; i < kickTargets.length; i++) {
    const state = kickTargets[i];
    let member = guild.members.cache.get(String(state.userId));
    if (!member) {
      try { member = await guild.members.fetch(String(state.userId)); } catch (e) { member = null; }
    }

    if (!member) {
      await appendFilterLog('KICK_SKIP', state, 'member_not_found');
      continue;
    }

    if (!member.kickable) {
      await appendFilterLog('KICK_SKIP', state, 'member_not_kickable');
      try { await message.channel.send(state.displayName + ' 강퇴 실패: 봇 권한 또는 역할 순서를 확인해라.'); } catch (e) {}
      continue;
    }

    const reason = '필터 기간 내 활동 조건 미충족';
    try {
      await member.send('귀하께서는 지정된 테스트 기간 동안 활동 조건을 충족하지 않아 퇴출되었습니다.');
    } catch (e) {}

    try {
      await member.kick(reason);
      const nowKST = formatKSTFromDate(new Date());
      state.kicked = 'Y';
      state.kickedAtKST = nowKST;
      state.updatedAtKST = nowKST;
      await saveFilterState(state);
      await appendFilterLog('KICKED', state, 'reason=' + reason);
      try { await message.channel.send(state.displayName + ' 퇴출 완료'); } catch (e) {}
    } catch (e) {
      await appendFilterLog('KICK_FAIL', state, e && e.message ? e.message : 'unknown_error');
      try { await message.channel.send(state.displayName + ' 강퇴 실패: ' + (e && e.message ? e.message : '알 수 없는 오류')); } catch (ee) {}
    }
  }
}

async function resolveMentionOrIdMembers(message, rawArgs) {
  const result = [];
  const seen = new Set();

  function pushMember(member) {
    if (!member || !member.id || !member.user || member.user.bot) return;
    const id = String(member.id);
    if (seen.has(id)) return;
    seen.add(id);
    result.push(member);
  }

  if (message.mentions && message.mentions.members) {
    message.mentions.members.forEach((member) => {
      pushMember(member);
    });
  }

  for (let i = 0; i < rawArgs.length; i++) {
    const token = String(rawArgs[i] || '').trim();
    if (!token) continue;

    let targetId = '';
    const mentionMatch = token.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
      targetId = String(mentionMatch[1]);
    } else if (/^\d{5,}$/.test(token)) {
      targetId = token;
    }

    if (!targetId) continue;
    if (seen.has(targetId)) continue;

    let member = message.guild.members.cache.get(targetId);
    if (!member) {
      try { member = await message.guild.members.fetch(targetId); } catch (e) { member = null; }
    }

    pushMember(member);
  }

  return result;
}

function parseServiceAccountFromB64() {
  const b64 = getEnv('GOOGLE_SA_JSON_B64');
  const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  const creds = JSON.parse(jsonStr);

  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

// KST 문자열 (YYYY-MM-DD HH:mm:ss)
function formatKSTFromDate(dateObj) {
  const t = new Date(dateObj.getTime() + 9 * 60 * 60 * 1000);
  const iso = t.toISOString();
  return iso.slice(0, 19).replace('T', ' ');
}

function buildMessageLink(message) {
  const guildId = message.guild ? message.guild.id : '@me';
  return 'https://discord.com/channels/' + guildId + '/' + message.channel.id + '/' + message.id;
}

// thread 지원: parentID가 타겟 채널이면 true
function isTargetChannelOrThread(message) {
  if (!message || !message.channel) return false;

  const cid = String(message.channel.id);
  if (cid === TARGET_CHANNEL_ID) return true;

  if (message.channel.parentID && String(message.channel.parentID) === TARGET_CHANNEL_ID) {
    return true;
  }
  return false;
}

function a1Range(sheetTitle, a1) {
  const safe = String(sheetTitle).replace(/'/g, "''");
  return "'" + safe + "'!" + a1;
}

// 입력 양식 파서
function parseLeaveForm(content) {
  if (!content) return null;

  const lines = String(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let nickname = '';
  let reason = '';
  let period = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([^:]+)\s*:\s*(.*)$/);
    if (!m) continue;

    const key = String(m[1]).replace(/\s/g, '');
    const val = String(m[2]).trim();

    if (key === '닉네임') nickname = val;
    else if (key === '사유') reason = val;
    else if (key === '기간') period = val;
  }

  if (!nickname || !reason || !period) return null;
  return { nickname, reason, period };
}

let sheetsApi = null;
let SHEET_TITLE = null;

// 메시지ID->행번호 캐시. 메모리 상한 유지.
const msgRowCache = new Map();
const MSG_ROW_CACHE_MAX = 5000;
function msgRowCacheSet(mid, row) {
  if (msgRowCache.size >= MSG_ROW_CACHE_MAX) {
    const it = msgRowCache.keys().next();
    if (!it.done) msgRowCache.delete(it.value);
  }
  msgRowCache.set(String(mid), row);
}

async function initSheets() {
  if (sheetsApi && SHEET_TITLE) return;

  const creds = parseServiceAccountFromB64();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsApi = google.sheets({ version: 'v4', auth });
  SHEET_TITLE = SHEET_TITLE_FIXED;

  console.log('[Sheets] LeaveSheetTitle(Fixed):', SHEET_TITLE);
  console.log('[Sheets] SpreadsheetId:', SPREADSHEET_ID);
}

function extractRowNumberFromUpdatedRange(updatedRange) {
  if (!updatedRange) return null;
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

async function appendLeaveRow(message) {
  await initSheets();

  const parsed = parseLeaveForm(message.content);
  if (!parsed) {
    console.log('[Leave][Skip] format not matched', 'mid=' + message.id, 'content=' + safeShort(message.content, 120));
    return;
  }

  const registeredAtKST = formatKSTFromDate(message.createdAt);
  const row = [parsed.nickname, parsed.reason, parsed.period, registeredAtKST];

  const range = a1Range(SHEET_TITLE, 'A:D');

  console.log('[Leave][Append] try', 'mid=' + message.id, 'nick=' + safeShort(parsed.nickname, 30), 'time(KST)=' + registeredAtKST);

  const res = await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  const updatedRange = res && res.data && res.data.updates ? res.data.updates.updatedRange : null;
  const rowNum = extractRowNumberFromUpdatedRange(updatedRange);
  if (rowNum) msgRowCacheSet(String(message.id), rowNum);

  console.log('[Leave][Append] ok', 'mid=' + message.id, 'row=' + (rowNum ? rowNum : 'unknown'));
}

async function updateLeaveRowFromEdit(message) {
  await initSheets();

  const rowNum = msgRowCache.get(String(message.id));
  if (!rowNum) {
    console.log('[Leave][Edit] skip (row not cached)', 'mid=' + message.id);
    return;
  }

  const parsed = parseLeaveForm(message.content);
  if (!parsed) {
    console.log('[Leave][Edit] skip (format not matched)', 'mid=' + message.id);
    return;
  }

  const range = a1Range(SHEET_TITLE, 'A' + rowNum + ':C' + rowNum);

  console.log('[Leave][Edit] try', 'mid=' + message.id, 'row=' + rowNum);

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    requestBody: { values: [[parsed.nickname, parsed.reason, parsed.period]] },
  });

  console.log('[Leave][Edit] ok', 'mid=' + message.id, 'row=' + rowNum);
}

// ---------- Backup 기능 ----------
let backupRunning = false;

async function getOrFetchChannel(channelId) {
  let ch = client.channels.cache.get(channelId);
  if (ch) return ch;
  try {
    ch = await client.channels.fetch(channelId);
    return ch;
  } catch (e) {
    return null;
  }
}

async function listSheetTitles() {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheets = meta && meta.data && meta.data.sheets ? meta.data.sheets : [];
  const titles = [];
  for (let i = 0; i < sheets.length; i++) {
    const p = sheets[i].properties;
    if (p && p.title) titles.push(String(p.title));
  }
  return titles;
}

function makeBackupBaseTitle(nowKST) {
  const d = nowKST.slice(0, 10);
  return '백업(' + d + ')';
}

function makeUniqueTitle(base, existingTitles) {
  if (existingTitles.indexOf(base) < 0) return base;
  let idx = 1;
  while (idx < 1000) {
    const t = base + '-' + idx;
    if (existingTitles.indexOf(t) < 0) return t;
    idx++;
  }
  return base + '-' + new Date().getTime();
}

async function createSheetTab(title) {
  console.log('[Backup] creating sheet tab:', title);

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: title } } },
      ],
    },
  });

  console.log('[Backup] sheet tab created:', title);
}

async function appendRowsToSheet(sheetTitle, rows, a1) {
  const range = a1Range(sheetTitle, a1);
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function fetchAllMessagesFromChannelText(channel) {
  const all = [];
  let lastId = null;

  while (all.length < BACKUP_MAX_MESSAGES) {
    const opt = { limit: 100 };
    if (lastId) opt.before = lastId;

    let batch;
    try {
      batch = await channel.messages.fetch(opt);
    } catch (e) {
      console.error('[Backup] channel.messages.fetch failed:', e && e.message ? e.message : e);
      break;
    }

    if (!batch || batch.size === 0) break;

    const arr = batch.array();
    for (let i = 0; i < arr.length; i++) all.push(arr[i]);

    lastId = arr[arr.length - 1].id;

    if (all.length % 500 === 0) {
      console.log('[Backup] fetched messages:', all.length);
    }
  }

  return all;
}

async function runBackup(invokingMessage) {
  async function notify(text) {
    if (!invokingMessage || !invokingMessage.author) return;

    try {
      await invokingMessage.author.send(String(text));
      return;
    } catch (e) {
      try {
        const tmp = await invokingMessage.reply(String(text) + '\n(DM 수신이 차단되어 채널에 잠깐 표시됩니다.)');
        if (tmp && tmp.delete) {
          setTimeout(() => {
            try { tmp.delete(); } catch (ee) {}
          }, 8000);
        }
      } catch (ee2) {}
    }
  }

  try { await invokingMessage.delete(); } catch (e) {}

  if (backupRunning) {
    await notify('이미 백업 진행중입니다. 끝난 뒤 다시 시도해 주세요.');
    return;
  }

  backupRunning = true;
  try {
    await notify('백업을 시작합니다.');
    await initSheets();

    const ch = await getOrFetchChannel(TARGET_CHANNEL_ID);
    if (!ch || ch.type !== 'text') {
      console.error('[Backup] target channel not found or not text:', TARGET_CHANNEL_ID);
      await notify('백업 실패: 대상 채널을 찾지 못했거나 텍스트 채널이 아닙니다.');
      return;
    }

    const nowKST = formatKSTFromDate(new Date());
    const base = makeBackupBaseTitle(nowKST);
    const existing = await listSheetTitles();
    const newTitle = makeUniqueTitle(base, existing);

    await createSheetTab(newTitle);

    const header = ['닉네임', '사유', '외출날짜'];
    await appendRowsToSheet(newTitle, [header], 'A:C');

    console.log('[Backup] fetching messages from channel:', TARGET_CHANNEL_ID);

    const msgs = await fetchAllMessagesFromChannelText(ch);
    if (!msgs || msgs.length === 0) {
      await notify('백업 완료(0건). 새 시트: ' + newTitle);
      return;
    }

    msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    console.log('[Backup] total messages fetched:', msgs.length);

    const rows = [];
    let matched = 0;

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const parsed = parseLeaveForm(m.content);
      if (!parsed) continue;

      matched++;
      rows.push([parsed.nickname, parsed.reason, parsed.period]);

      if (matched % 500 === 0) {
        console.log('[Backup] matched rows:', matched);
      }
    }

    if (rows.length === 0) {
      console.log('[Backup] no matched leave-form messages');
      await notify('백업 완료(양식 0건). 새 시트: ' + newTitle);
      return;
    }

    const CHUNK = 500;
    for (let s = 0; s < rows.length; s += CHUNK) {
      const chunk = rows.slice(s, s + CHUNK);
      await appendRowsToSheet(newTitle, chunk, 'A:C');
      console.log('[Backup] appended:', Math.min(s + CHUNK, rows.length) + '/' + rows.length);
    }

    console.log('[Backup] done. sheet:', newTitle, 'matched:', rows.length);
    await notify('백업 완료: 양식 ' + rows.length + '건, 새 시트: ' + newTitle);

  } catch (e) {
    console.error('[Backup] failed:', e && e.stack ? e.stack : e);
    await notify('백업 실패. Heroku 로그를 확인해 주세요.');
  } finally {
    backupRunning = false;
  }
}

// ---- PartyBeast Room Renumber Implementation ----
const renumberTimers = new Map();      // key: guildId:categoryId -> timeout
const renumberQueues = new Map();      // key: guildId:categoryId -> Promise

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isManagedCategory(categoryId) {
  return managedCategoryMap.has(String(categoryId));
}

function scheduleRenumber(guildId, categoryId, why) {
  if (!guildId || !categoryId) return;
  const cid = String(categoryId);
  if (!isManagedCategory(cid)) return;

  const key = String(guildId) + ':' + cid;
  const old = renumberTimers.get(key);
  if (old) {
    try { clearTimeout(old); } catch (e) {}
  }

  const t = setTimeout(() => {
    enqueueRenumberJob(String(guildId), cid, why);
  }, REN_NUMBER_DELAY_MS);

  renumberTimers.set(key, t);
}

function enqueueRenumberJob(guildId, categoryId, why) {
  const key = String(guildId) + ':' + String(categoryId);
  const prev = renumberQueues.get(key) || Promise.resolve();

  const next = prev.then(async () => {
    try {
      await renumberCategoryRooms(guildId, categoryId, why);
    } catch (e) {
      console.error('[RenumberError]', e && e.stack ? e.stack : e);
    }
  });

  renumberQueues.set(key, next);
  return next;
}

async function renumberCategoryRooms(guildId, categoryId, why) {
  const cfg = managedCategoryMap.get(String(categoryId));
  if (!cfg) return;

  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;

  const prefixText = String(cfg.prefix);
  const re = new RegExp('^' + escapeRegex(prefixText) + '\\s*(\\d+)$', 'i');

  const voices = guild.channels.cache
    .filter((ch) => ch && ch.type === 'voice' && String(ch.parentID) === String(categoryId))
    .array();

  const targets = [];
  for (let i = 0; i < voices.length; i++) {
    const ch = voices[i];
    const name = String(ch.name || '');
    const m = name.match(re);
    if (!m) continue;
    targets.push(ch);
  }

  if (targets.length <= 1) {
    if (targets.length === 1) {
      const desired = prefixText + '1';
      if (String(targets[0].name) !== desired) {
        console.log('[Renumber] single channel rename', 'cat=' + categoryId, 'from=' + targets[0].name, 'to=' + desired, 'why=' + String(why || ''));
        try {
          await targets[0].setName(desired, 'renumber(single)');
        } catch (e) {
          console.error('[Renumber] rename failed:', e && e.message ? e.message : e);
        }
      }
    }
    return;
  }

  targets.sort((a, b) => {
    const ta = a.createdTimestamp || 0;
    const tb = b.createdTimestamp || 0;
    return ta - tb;
  });

  const plan = [];
  for (let i = 0; i < targets.length; i++) {
    const desired = prefixText + String(i + 1);
    if (String(targets[i].name) !== desired) {
      plan.push({ ch: targets[i], to: desired });
    }
  }

  if (plan.length === 0) return;

  console.log('[Renumber] start', 'cat=' + categoryId, 'prefix=' + prefixText, 'count=' + targets.length, 'changes=' + plan.length, 'why=' + String(why || ''));

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    try {
      console.log('[Renumber] rename', 'from=' + item.ch.name, 'to=' + item.to);
      await item.ch.setName(item.to, 'renumber');
      await delay(REN_RENAME_GAP_MS);
    } catch (e) {
      console.error('[Renumber] rename failed:', e && e.message ? e.message : e);
    }
  }

  console.log('[Renumber] done', 'cat=' + categoryId);
}

// ---- Global Error/Signal Handling ----
process.on('uncaughtException', (err) => {
  console.error('[FATAL][uncaughtException]', err && err.stack ? err.stack : err);
  try { if (client && client.destroy) client.destroy(); } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL][unhandledRejection]', err && err.stack ? err.stack : err);
  try { if (client && client.destroy) client.destroy(); } catch (e) {}
  process.exit(1);
});

function gracefulShutdown(sig) {
  console.log('[Signal]', sig, 'received. shutting down gracefully.');
  try { if (client && client.destroy) client.destroy(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

client.on('shardReady', (id) => console.log('[ShardReady]', id));
client.on('shardDisconnect', (event, id) => console.log('[ShardDisconnect]', id, 'code=' + (event && event.code)));
client.on('shardReconnecting', (id) => console.log('[ShardReconnecting]', id));
client.on('error', (e) => console.error('[ClientError]', e && e.stack ? e.stack : e));
client.on('warn', (w) => console.warn('[ClientWarn]', w));
client.on('rateLimit', (info) => console.warn('[RateLimit]', JSON.stringify(info)));

setInterval(() => {
  console.log('[Heartbeat]', new Date().toISOString());
}, 10 * 60 * 1000);

// ---- Discord Events ----
client.on('ready', async () => {
  console.log('[Bot] LoggedInAs:', client.user.tag);
  console.log('[Bot] TARGET_CHANNEL_ID:', TARGET_CHANNEL_ID);
  console.log('[Bot] FILTER_COMMAND_TEXT_CHANNEL_ID:', FILTER_COMMAND_TEXT_CHANNEL_ID);
  console.log('[Bot] Intents:', client.options && client.options.ws ? client.options.ws.intents : 'unknown');
  console.log('[Env] DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? 'SET' : 'MISSING');
  console.log('[Env] GOOGLE_SA_JSON_B64:', process.env.GOOGLE_SA_JSON_B64 ? 'SET' : 'MISSING');

  try {
    await initSheets();
    await ensureFilterDataLoaded();
  } catch (e) {
    console.error('[SheetsInitFailed]', e && e.stack ? e.stack : e);
  }
});

// 채널 생성/삭제 감시해서 번호정렬 트리거
client.on('channelCreate', (channel) => {
  try {
    if (!channel) return;
    if (channel.type !== 'voice') return;
    if (!channel.guild) return;
    if (!channel.parentID) return;
    if (!isManagedCategory(channel.parentID)) return;

    scheduleRenumber(channel.guild.id, channel.parentID, 'channelCreate');
  } catch (e) {
    console.error('[channelCreate handler error]', e && e.stack ? e.stack : e);
  }
});

client.on('channelDelete', (channel) => {
  try {
    if (!channel) return;
    if (channel.type !== 'voice') return;
    if (!channel.guild) return;
    if (!channel.parentID) return;
    if (!isManagedCategory(channel.parentID)) return;

    scheduleRenumber(channel.guild.id, channel.parentID, 'channelDelete');
  } catch (e) {
    console.error('[channelDelete handler error]', e && e.stack ? e.stack : e);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  enqueueSheetJob(() => handleTrackedVoiceTransition(oldState, newState));
});

// 메시지 작성 시
client.on('message', async (message) => {
  if (!message || !message.author) return;
  if (message.author.bot) return;

  // ---- 전부이동: 목적 채널 이름 입력 단계 처리 ----
  const pendingMove = moveAllStateByUser.get(String(message.author.id));
  if (pendingMove && message.guild && String(message.guild.id) === String(pendingMove.guildId)) {
    if (message.content && !message.content.startsWith(prefix)) {
      const now = nowMs();
      if (now - pendingMove.createdAtMs > MOVEALL_TIMEOUT_MS) {
        moveAllStateByUser.delete(String(message.author.id));
        try { await message.reply('전부이동 시간이 초과되었습니다. 다시 !전부이동 명령을 사용해 주세요.'); } catch (e) {}
        return;
      }

      const guild = message.guild;
      const sourceChannel = guild.channels.cache.get(String(pendingMove.sourceChannelId));
      if (!sourceChannel || sourceChannel.type !== 'voice') {
        moveAllStateByUser.delete(String(message.author.id));
        try { await message.reply('전부이동 실패: 원래 음성 채널을 찾지 못했습니다.'); } catch (e) {}
        return;
      }

      const raw = String(message.content).trim();
      let targetChannel = null;

      const mentionMatch = raw.match(/^<#!?(\d+)>$/);
      if (mentionMatch) {
        const cid = mentionMatch[1];
        const ch = guild.channels.cache.get(String(cid));
        if (ch && ch.type === 'voice') targetChannel = ch;
      }

      if (!targetChannel && /^[0-9]+$/.test(raw)) {
        const ch = guild.channels.cache.get(String(raw));
        if (ch && ch.type === 'voice') targetChannel = ch;
      }

      if (!targetChannel) {
        const lower = raw.toLowerCase();
        targetChannel = guild.channels.cache.find((ch) => {
          if (!ch || ch.type !== 'voice') return false;
          const name = String(ch.name || '').toLowerCase();
          return name === lower;
        });
      }

      if (!targetChannel) {
        try { await message.reply('전부이동 실패: 해당 이름의 음성 채널을 찾지 못했습니다. 다시 !전부이동 명령을 사용해 주세요.'); } catch (e) {}
        moveAllStateByUser.delete(String(message.author.id));
        return;
      }

      if (String(targetChannel.id) === String(sourceChannel.id)) {
        try { await message.reply('이미 그 음성 채널에 있습니다.'); } catch (e) {}
        moveAllStateByUser.delete(String(message.author.id));
        return;
      }

      const members = sourceChannel.members.array();
      let movedCount = 0;

      for (let i = 0; i < members.length; i++) {
        const mem = members[i];
        if (!mem || !mem.voice || !mem.voice.channel) continue;
        try {
          await mem.voice.setChannel(targetChannel);
          movedCount++;
        } catch (e) {
          console.error('[MoveAll] move failed:', mem.id, e && e.message ? e.message : e);
        }
      }

      moveAllStateByUser.delete(String(message.author.id));
      try {
        await message.reply('전부이동 완료: ' + movedCount + '명을 "' + String(targetChannel.name || '') + '" 채널로 이동했습니다.');
      } catch (e) {}
      return;
    }
  }

  if (isTargetChannelOrThread(message)) {
    console.log(
      '[MSG] recv',
      'cid=' + message.channel.id,
      'mid=' + message.id,
      'created(KST)=' + formatKSTFromDate(message.createdAt),
      'content=' + safeShort(message.content, 140)
    );
    enqueueSheetJob(() => appendLeaveRow(message));
  }

  try {
    if (isFilterTrackedTextChannel(message, filterTrackedChatChannelIds)) {
      enqueueSheetJob(() => updateFilterActivityForMessage(message, 'chat'));
    } else if (isFilterTrackedTextChannel(message, filterTrackedRecruitChannelIds)) {
      enqueueSheetJob(() => updateFilterActivityForMessage(message, 'recruit'));
    }
  } catch (e) {
    console.error('[FilterMessageTrackError]', e && e.stack ? e.stack : e);
  }

  if (!message.content || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();


  if (command === '백업') {
    console.log('[Backup] command received by', message.author.tag);
    runBackup(message);
    return;
  }

  if (command === '기간') {
    if (!(await ensureFilterCommandAccess(message))) return;

    const minutes = normalizePeriodMinutesInput(args[0]);
    if (!minutes) {
      try { await message.reply('사용법: !기간 1  (테스트 기준 1 = 1분)'); } catch (e) {}
      return;
    }

    await enqueueSheetJob(() => setFilterPeriodMinutes(minutes));
    try { await message.reply('필터 기간을 ' + String(minutes) + '분으로 설정했다. 이제 !테스트 @유저 또는 !테스트 유저ID 형식으로 대상자를 지정해라.'); } catch (e) {}
    return;
  }

  if (command === '테스트') {
    if (!(await ensureFilterCommandAccess(message))) return;

    await ensureFilterDataLoaded();
    if (!isFilterPeriodReady()) {
      try { await message.reply('먼저 !기간 N 으로 기간부터 설정해라. 예: !기간 1'); } catch (e) {}
      return;
    }

    const members = await resolveMentionOrIdMembers(message, args);
    console.log('[TEST_CMD]', 'args=' + JSON.stringify(args), 'resolved=' + JSON.stringify(members.map((m) => String(m.id))));
    if (!members || members.length === 0) {
      try { await message.reply('대상자를 찾지 못했다. 사용법: !테스트 @유저1 @유저2 또는 !테스트 유저ID1 유저ID2'); } catch (e) {}
      return;
    }

    await enqueueSheetJob(() => setTestTargetsFromMembers(members));
    try { await message.reply('테스트 대상자 설정 완료: ' + members.map((m) => String(m.displayName)).join(', ')); } catch (e) {}
    return;
  }

  if (command === '전체대상') {
    if (!(await ensureFilterCommandAccess(message))) return;

    await ensureFilterDataLoaded();
    if (!isFilterPeriodReady()) {
      try { await message.reply('먼저 !기간 N 으로 기간부터 설정해라. 예: !기간 1'); } catch (e) {}
      return;
    }

    try {
      await enqueueSheetJob(() => setAllTargetsFromGuild(message.guild));
      try { await message.reply('전체 대상 모드로 전환했다. 현재 서버의 봇 제외 전체 유저를 대상으로 설정했다.'); } catch (e) {}
    } catch (e) {
      console.error('[SET_ALL_TARGETS_ERROR]', e && e.stack ? e.stack : e);
      try { await message.reply('전체 대상 설정 실패. 봇의 Server Members Intent 및 권한을 확인해라.'); } catch (ee) {}
    }
    return;
  }

  if (command === '테스트삭제') {
    if (!(await ensureFilterCommandAccess(message))) return;

    await ensureFilterDataLoaded();
    if (!filterConfig.testTargetIds || filterConfig.testTargetIds.length === 0) {
      try { await message.reply('삭제할 테스트 대상자가 없다.'); } catch (e) {}
      return;
    }

    await enqueueSheetJob(() => clearTestTargets());
    try { await message.reply('현재 테스트 대상자 설정을 전부 삭제하고 테스트 모드로 초기화했다.'); } catch (e) {}
    return;
  }

  if (command === '테스트목록') {
    if (!(await ensureFilterCommandAccess(message))) return;

    await ensureFilterDataLoaded();

    const headerLines = [
      '**테스트 대상자 목록**',
      '대상 모드: ' + getFilterTargetModeLabel(),
      '기간 설정: ' + (isFilterPeriodReady() ? (String(filterConfig.periodMinutes) + '분') : '미설정'),
      ''
    ];

    if (!filterConfig.testTargetIds || filterConfig.testTargetIds.length === 0) {
      headerLines.push('현재 테스트 대상자가 없다.');
      try { await sendLongText(message.channel, headerLines.join('\n')); } catch (e) {}
      return;
    }

    const names = [];
    for (let i = 0; i < filterConfig.testTargetIds.length; i++) {
      const targetId = String(filterConfig.testTargetIds[i]);
      const state = getFilterState(targetId);
      if (state) {
        names.push(state.displayName + ' (' + state.userId + ')');
        continue;
      }

      let member = message.guild.members.cache.get(targetId);
      if (!member) {
        try { member = await message.guild.members.fetch(targetId); } catch (e) { member = null; }
      }
      if (member) names.push(String(member.displayName) + ' (' + targetId + ')');
      else names.push('알 수 없음 (' + targetId + ')');
    }

    headerLines.push(names.join('\n'));
    try { await sendLongText(message.channel, headerLines.join('\n')); } catch (e) {}
    return;
  }

  if (command === '필터') {
    if (!(await ensureFilterCommandAccess(message))) return;

    await enqueueSheetJob(() => runFilterForCurrentTargets(message));
    return;
  }

  // !복귀: 마지막 !해산으로 이동된 인원들을 대기실로 이동
  if (command === '복귀') {
    if (!isAdminMember(message.member)) {
      try { await message.reply('권한이 없다.'); } catch (e) {}
      return;
    }

    if (!message.guild) return;

    const waiting = message.guild.channels.cache.get(WAITING_ROOM_VOICE_ID);
    if (!waiting || waiting.type !== 'voice') {
      try { await message.reply('복귀 실패: 대기실 음성채널을 못 찾음.'); } catch (e) {}
      return;
    }

    if (lastDisbandedMemberIds.size === 0) {
      try { await message.reply('복귀할 대상이 없다.'); } catch (e) {}
      return;
    }

    let moved = 0;
    const ids = Array.from(lastDisbandedMemberIds);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const mem = message.guild.members.cache.get(String(id));
      if (!mem) continue;
      if (!mem.voice || !mem.voice.channel) continue;

      try {
        await mem.voice.setChannel(waiting);
        moved++;
      } catch (e) {
        console.error('[Return] move failed:', id, e && e.message ? e.message : e);
      }
    }

    lastDisbandedMemberIds.clear();
    try { await message.reply('복귀 완료: ' + moved + '명 대기실 이동'); } catch (e) {}
    return;
  }

  if (command === '팀') {
    if (!isAdminMember(message.member)) {
      try { await message.reply('권한이 없다.'); } catch (e) {}
      return;
    }

    // 팀짜기 명령은 지정된 텍스트 채널에서만 허용
    if (!isTeamCommandTextChannel(message)) {
      try { await message.reply('이 명령어는 지정된 채널에서만 사용할 수 있다.'); } catch (e) {}
      return;
    }

    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) {
      return message.reply('올바른 인원 수를 입력해주세요.');
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('음성 채널에 들어가 주세요.');
    }

    const SPECTATOR_TAG = /\[관전\]/i;
    const members = voiceChannel.members
      .filter(m => {
        const name = m.displayName || m.user.username || '';
        return !m.user.bot && !SPECTATOR_TAG.test(name);
      })
      .array();

    if (members.length < n) {
      return message.reply('음성 채널에 인원이 부족합니다.');
    }

    // 이전 팀 정보 복사(이전 run과 비교용)
    const prevTeamsForCompare = (latestTeams && Array.isArray(latestTeams) && latestTeams.length > 0)
      ? latestTeams
      : null;

    // 새 팀 구성 시 "이전 팀과의 유사도"를 줄이기 위한 시도
    const MAX_RETRY = 12;
    const MAX_SIMILAR_RATIO = 0.4; // 최대 40% 정도만 이전 팀과 비슷하도록 허용

    let bestTeamsMembers = null;
    let bestRatio = 1.0;

    if (!prevTeamsForCompare) {
      // 이전 팀이 없으면 그냥 한 번 셔플
      const shuffledMembers = shuffleArray(members);
      bestTeamsMembers = buildTeamsFromMembersArray(shuffledMembers, n);
      bestRatio = 0.0;
    } else {
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        const shuffledMembers = shuffleArray(members);
        const candidateTeams = buildTeamsFromMembersArray(shuffledMembers, n);
        const diff = evaluateTeamDifference(prevTeamsForCompare, candidateTeams);

        if (diff.ratio < bestRatio) {
          bestRatio = diff.ratio;
          bestTeamsMembers = candidateTeams;
        }

        if (diff.ratio <= MAX_SIMILAR_RATIO) {
          break;
        }
      }

      if (!bestTeamsMembers) {
        const shuffledMembers = shuffleArray(members);
        bestTeamsMembers = buildTeamsFromMembersArray(shuffledMembers, n);
        bestRatio = 1.0;
      }
    }

    const teamsMembers = bestTeamsMembers;

    latestTeams = teamsMembers.map(team => team.map(m => String(m.id)));
    latestTeamsMeta = {
      guildId: String(message.guild.id),
      textChannelId: String(message.channel.id),
      voiceChannelId: String(voiceChannel.id),
      createdAtMs: nowMs(),
    };

    const selectedTeamIndex = Math.floor(Math.random() * teamsMembers.length);
    const selectedTeamName = (selectedTeamIndex + 1) + ' 팀';
    const randomMessage = selectedTeamName + '이 좀 치네...?';

    let teamMessage = '**새로운 팀이 구성되었습니다!**\n나와 함께 할 팀은???\n\n';
    for (let i = 0; i < teamsMembers.length; i++) {
      const team = teamsMembers[i];
      teamMessage += '```\nTeam ' + (i + 1) + '\n';
      for (let j = 0; j < team.length; j++) {
        teamMessage += String(team[j].displayName) + '\n';
      }
      teamMessage += '```\n';
    }

    teamMessage += '\n' + randomMessage + '\n';

    await sendLongText(message.channel, teamMessage);

    const mentions = members.map(m => '<@' + String(m.id) + '>').join(' ');
    if (mentions) {
      const tokens = mentions.split(' ').filter(Boolean);
      const batchSize = 30;
      let line = '참가자:';
      for (let i = 0; i < tokens.length; i++) {
        if ((i % batchSize) === 0 && i !== 0) {
          await message.channel.send(line);
          line = '참가자:';
        }
        line += ' ' + tokens[i];
      }
      if (line.trim() !== '참가자:') {
        await message.channel.send(line);
      }
    }
    return;
  }

  if (command === '해산') {
    if (!isAdminMember(message.member)) {
      try { await message.reply('권한이 없다.'); } catch (e) {}
      return;
    }

    // 해산 명령도 지정된 텍스트 채널에서만 허용
    if (!isTeamCommandTextChannel(message)) {
      try { await message.reply('이 명령어는 지정된 채널에서만 사용할 수 있다.'); } catch (e) {}
      return;
    }

    if (latestTeams.length === 0) {
      return message.reply('먼저 !팀 명령어로 팀을 구성해주세요.');
    }

    const voiceChannelIds = [
      '1450857003521015921', '1450857559715217560', '1450857466312261786',
      '1450857664388005980', '1450857791789989971', '1450857978289983568',
      '1450858008027336844', '1450858203570110608', '1451547463554170930',
      '1451547521531773029'
    ];

    lastDisbandedMemberIds.clear();

    latestTeams.forEach((team, i) => {
      const channelId = voiceChannelIds[i];
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== 'voice') return;

      for (let j = 0; j < team.length; j++) {
        const memberId = String(team[j]);
        const member = message.guild.members.cache.get(memberId);
        if (member && member.voice && member.voice.channel) {
          member.voice.setChannel(channel).then(() => {
            try { lastDisbandedMemberIds.add(String(member.id)); } catch (e) {}
          }).catch(err => {
            console.error('이동 실패:', member.displayName, err && err.message ? err.message : err);
          });
        }
      }
    });

    message.channel.send('모든 인원을 이동 시켰습니다!!! @here');
    return;
  }

  if (command === '전부이동') {
    if (!message.guild) return;
    if (!isAdminMember(message.member)) {
      try { await message.reply('권한이 없다.'); } catch (e) {}
      return;
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel || voiceChannel.type !== 'voice') {
      try { await message.reply('전부이동 실패: 먼저 음성 채널에 들어가 주세요.'); } catch (e) {}
      return;
    }

    moveAllStateByUser.set(String(message.author.id), {
      guildId: String(message.guild.id),
      sourceChannelId: String(voiceChannel.id),
      createdAtMs: nowMs(),
    });

    try {
      await message.reply('어디로 이동할까요? 이동할 음성 채널 이름(또는 채널 멘션, 채널 ID)을 한 번 더 입력해 주세요. (60초 이내)');
    } catch (e) {}
    return;
  }

  if (command === '놀자') {
    const maxMembers = 4;

    if (!message.member.voice.channel) {
      return message.reply('먼저 음성 채널에 들어가주세요!');
    }

    const voice = message.member.voice.channel;

    const SPECTATOR_TAG = /\[관전\]/i;
    const effectiveMembers = voice.members.filter(m => {
      const name = m.displayName || m.user.username || '';
      return !m.user.bot && !SPECTATOR_TAG.test(name);
    });

    const currentMembers = effectiveMembers.size;
    const remainingMembers = Math.max(maxMembers - currentMembers, 0);

    const invite = await voice.createInvite({ maxAge: 3600 });

    const colors = ['#FF5733', '#C70039', '#900C3F', '#581845', '#2E86C1', '#2ECC71', '#F1C40F', '#8E44AD'];
    const selectedColor = colors[Math.floor(Math.random() * colors.length)];

    const inviteMessage = new Discord.MessageEmbed()
      .setTitle(voice.name + '\n' + remainingMembers + ' 명 구인 구직 중이에요')
      .setColor(selectedColor)
      .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
      .setTimestamp();

    message.channel.send(inviteMessage);
    message.channel.send(invite.url + '\n@here');
    return;
  }

  if (message.content === '!명령어') {
    message.channel.send(
      '**구인구직 사용방법!**\n음성채널 생성 후 `!놀자` 입력하면 자동으로 초대링크 생성\n\n' +
      '**복귀 사용방법!**\n`!복귀` 입력하면 마지막 `!해산`으로 이동된 인원을 대기실로 이동\n\n' +
      '**팀 짜기 사용방법!**\n지정된 텍스트 채널에서 내전 대기실 입장 후 `!팀 N` (예: !팀 2 > 2인 팀) 입력 시, 현재 음성채널 인원을 N명씩 팀으로 나눕니다.\n[관전 표시된 인원은 팀 구성에서 제외됩니다]\n해당 봇 저작권은 도비에게 있습니다.'
    );
    return;
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (!newMessage) return;

    if (newMessage.partial) {
      try { newMessage = await newMessage.fetch(); } catch (e) { return; }
    }

    if (!newMessage.author || newMessage.author.bot) return;
    if (!isTargetChannelOrThread(newMessage)) return;

    console.log('[MSG_EDIT] recv', 'mid=' + newMessage.id, 'content=' + safeShort(newMessage.content, 140));
    enqueueSheetJob(() => updateLeaveRowFromEdit(newMessage));
  } catch (e) {
    console.error('[messageUpdate handler error]', e && e.stack ? e.stack : e);
  }
});

client.login(getEnv('DISCORD_TOKEN'));
