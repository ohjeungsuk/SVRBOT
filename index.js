// index.js (discord.js v12.5.3 + Google Sheets logger for "카톡외출목록" + !백업)
// Required Heroku Config Vars:
// - DISCORD_TOKEN
// - GOOGLE_SA_JSON_B64
//
// Recommended Heroku dynos: worker=1, web=0

const Discord = require('discord.js');
const { google } = require('googleapis');

const client = new Discord.Client({
  partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});

const prefix = '!';
let latestTeams = [];

// ---- Google Sheets Settings ----
const TARGET_CHANNEL_ID = '1439239707320909895'; // 너 현재 설정
const SPREADSHEET_ID = '1aXIUb5yMA92s5EoYuyxf5IM8yFa_hryihUJDFIjsxyU';

// 외출 목록 기록 탭
const SHEET_TITLE_FIXED = '카톡외출목록';

// 백업 최대 메시지 수 (너무 큰 채널이면 무한히 걸릴 수 있어서 안전장치)
const BACKUP_MAX_MESSAGES = 20000;

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
// 닉네임: ...
// 사유: ...
// 기간: ...
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

// message_id -> row number cache
const msgRowCache = new Map();

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
}

function extractRowNumberFromUpdatedRange(updatedRange) {
  if (!updatedRange) return null;
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

// 외출목록 행 추가: 닉네임/사유/기간/등록시간(KST)
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
  if (rowNum) msgRowCache.set(String(message.id), rowNum);

  console.log('[Leave][Append] ok', 'mid=' + message.id, 'row=' + (rowNum ? rowNum : 'unknown'), 'updatedRange=' + (updatedRange ? updatedRange : 'null'));
}

// 메시지 수정 시 (캐시에 row가 있는 경우만) A~C 업데이트
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
  // v12 supports fetch
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
  // nowKST: "YYYY-MM-DD HH:mm:ss" -> use date only
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
  // 마지막 수단
  return base + '-' + new Date().getTime();
}

async function createSheetTab(title) {
  console.log('[Backup] creating sheet tab:', title);

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title: title },
          },
        },
      ],
    },
  });

  console.log('[Backup] sheet tab created:', title);
}

async function appendRowsToSheet(sheetTitle, rows) {
  // rows: [ [..], [..] ... ]
  const range = a1Range(sheetTitle, 'A:I');
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function fetchAllMessagesFromChannelText(channel) {
  // 최신 -> 과거 방향으로 100개씩 fetch, 끝까지
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

    const arr = batch.array(); // v12
    for (let i = 0; i < arr.length; i++) {
      all.push(arr[i]);
    }

    lastId = arr[arr.length - 1].id;

    if (all.length % 500 === 0) {
      console.log('[Backup] fetched messages:', all.length);
    }
  }

  return all;
}

async function runBackup(invokingMessage) {
  if (backupRunning) {
    try { await invokingMessage.reply('이미 백업 진행중이야. 끝나면 다시 시도해줘.'); } catch (e) {}
    return;
  }

  backupRunning = true;
  try {
    await initSheets();

    const ch = await getOrFetchChannel(TARGET_CHANNEL_ID);
    if (!ch || ch.type !== 'text') {
      console.error('[Backup] target channel not found or not text:', TARGET_CHANNEL_ID);
      try { await invokingMessage.reply('백업 실패: 채널을 못 찾았거나 텍스트 채널이 아님.'); } catch (e) {}
      return;
    }

    // 새 시트 이름 생성
    const nowKST = formatKSTFromDate(new Date());
    const base = makeBackupBaseTitle(nowKST);
    const existing = await listSheetTitles();
    const newTitle = makeUniqueTitle(base, existing);

    // 시트 탭 생성
    await createSheetTab(newTitle);

    // 헤더
    const header = [
      'created_at_kst',
      'edited_at_kst',
      'author',
      'author_id',
      'channel_id',
      'message_id',
      'content',
      'message_link',
      'attachments'
    ];
    await appendRowsToSheet(newTitle, [header]);

    console.log('[Backup] fetching messages from channel:', TARGET_CHANNEL_ID);

    const msgs = await fetchAllMessagesFromChannelText(ch);

    if (!msgs || msgs.length === 0) {
      console.log('[Backup] no messages fetched');
      try { await invokingMessage.reply('백업 완료(0건). 새 시트: ' + newTitle); } catch (e) {}
      return;
    }

    // 과거 -> 최신 순으로 저장하려면 reverse
    msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    console.log('[Backup] total messages fetched:', msgs.length);

    // rows 만들기
    const rows = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];

      const createdKST = m.createdAt ? formatKSTFromDate(m.createdAt) : '';
      const editedKST = m.editedAt ? formatKSTFromDate(m.editedAt) : '';
      const author = m.author ? (m.author.tag || '') : '';
      const authorId = m.author ? String(m.author.id) : '';
      const channelId = String(m.channel.id);
      const messageId = String(m.id);
      const content = m.content ? String(m.content) : '';

      let attach = '';
      try {
        if (m.attachments && m.attachments.size > 0) {
          const a = m.attachments.array().map(x => x.url);
          attach = a.join(' ');
        }
      } catch (e) {}

      const link = buildMessageLink(m);

      rows.push([createdKST, editedKST, author, authorId, channelId, messageId, content, link, attach]);

      if ((i + 1) % 500 === 0) {
        console.log('[Backup] prepared rows:', i + 1);
      }
    }

    // 시트로 batch append (500줄씩)
    const CHUNK = 500;
    for (let s = 0; s < rows.length; s += CHUNK) {
      const chunk = rows.slice(s, s + CHUNK);
      await appendRowsToSheet(newTitle, chunk);
      console.log('[Backup] appended to sheet:', Math.min(s + CHUNK, rows.length) + '/' + rows.length);
    }

    console.log('[Backup] done. sheet:', newTitle);

    try { await invokingMessage.reply('백업 완료: ' + rows.length + '건, 새 시트: ' + newTitle); } catch (e) {}
  } catch (e) {
    console.error('[Backup] failed:', e && e.stack ? e.stack : e);
    try { await invokingMessage.reply('백업 실패. Heroku 로그 확인해줘.'); } catch (ee) {}
  } finally {
    backupRunning = false;
  }
}

// ---- Global Error Logs ----
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});

// ---- Discord Events ----
client.on('ready', async () => {
  console.log('[Bot] LoggedInAs:', client.user.tag);
  console.log('[Bot] TARGET_CHANNEL_ID:', TARGET_CHANNEL_ID);
  console.log('[Env] DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? 'SET' : 'MISSING');
  console.log('[Env] GOOGLE_SA_JSON_B64:', process.env.GOOGLE_SA_JSON_B64 ? 'SET' : 'MISSING');

  try {
    await initSheets();
  } catch (e) {
    console.error('[SheetsInitFailed]', e && e.stack ? e.stack : e);
  }
});

// 메시지 작성 시: 타겟 채널(또는 스레드) + 양식이면 외출목록 기록
client.on('message', async (message) => {
  if (!message || !message.author) return;
  if (message.author.bot) return;

  if (isTargetChannelOrThread(message)) {
    console.log(
      '[MSG] recv',
      'cid=' + message.channel.id,
      'parent=' + (message.channel.parentID ? message.channel.parentID : 'none'),
      'mid=' + message.id,
      'created(KST)=' + formatKSTFromDate(message.createdAt),
      'content=' + safeShort(message.content, 140)
    );

    enqueueSheetJob(() => appendLeaveRow(message));
  }

  // Commands
  if (!message.content || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // !백업: 지정 채널 전체 메시지를 새 시트로 백업
  if (command === '백업') {
    console.log('[Backup] command received by', message.author.tag);
    // 백업은 시간이 걸리니까 별도 실행
    runBackup(message);
    return;
  }

  // ---------------- 기존 기능들 유지 ----------------

  // !팀
  if (command === '팀') {
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) return message.reply('올바른 인원 수를 입력해주세요.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('음성 채널에 들어가 주세요.');

    const SPECTATOR_TAG = /\[관전\]/i;
    const members = voiceChannel.members
      .filter(m => {
        const name = m.displayName || m.user.username || '';
        return !m.user.bot && !SPECTATOR_TAG.test(name);
      })
      .array();

    if (members.length < n) return message.reply('음성 채널에 인원이 부족합니다.');

    const shuffledMembers = members.sort(() => Math.random() - 0.5);
    const teams = [];
    let restMembers = shuffledMembers.length;

    while (restMembers > 0) {
      const teamSize = Math.min(restMembers, n);
      const teamMembers = shuffledMembers.slice(teams.length * n, teams.length * n + teamSize);
      teams.push(teamMembers.map(member => member.displayName));
      restMembers -= teamSize;
    }

    latestTeams = teams;

    const selectedTeamIndex = Math.floor(Math.random() * teams.length);
    const selectedTeamName = `${selectedTeamIndex + 1} 팀`;
    const randomMessage = `${selectedTeamName}이 좀 치네...?`;

    let teamMessage = `**새로운 팀이 구성되었습니다!**\n나와 함께 할 팀은???\n\n`;
    teams.forEach((team, i) => {
      teamMessage += `\`\`\`\nTeam ${i + 1}\n`;
      team.forEach(name => { teamMessage += `${name}\n`; });
      teamMessage += `\`\`\`\n`;
    });

    message.channel.send(teamMessage);
    message.channel.send(randomMessage);
    return;
  }

  // !해산
  if (command === '해산') {
    if (latestTeams.length === 0) {
      return message.reply('먼저 !팀 명령어로 팀을 구성해주세요.');
    }

    const voiceChannelIds = [
      '1450857003521015921', '1450857559715217560', '1450857466312261786',
      '1450857664388005980', '1450857791789989971', '1450857978289983568',
      '1450858008027336844', '1450858203570110608', '1451547463554170930',
      '1451547521531773029'
    ];

    latestTeams.forEach((team, i) => {
      const channelId = voiceChannelIds[i];
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== 'voice') return;

      team.forEach(name => {
        const member = message.guild.members.cache.find(m => m.displayName === name);
        if (member && member.voice.channel) {
          member.voice.setChannel(channel).catch(err => {
            console.error('이동 실패:', member.displayName, err.message);
          });
        }
      });
    });

    message.channel.send('모든 인원을 이동 시켰습니다!!! @here');
    return;
  }

  // !놀자
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
      .setTitle(`:loud_sound: ${voice.name} 여기 왕따 있어요!!!! \n${remainingMembers} 명 구인 구직 중이에요`)
      .setColor(selectedColor)
      .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
      .setTimestamp();

    message.channel.send(inviteMessage);
    message.channel.send(invite.url + "\n@here");
    return;
  }

  // !명령어
  if (message.content === '!명령어') {
    message.channel.send(
      `**구인구직 사용방법!**\n음성채널 생성 후 \`\`!놀자\`\` 입력하면 자동으로 초대링크 생성\n\n` +
      `**팀 짜기 사용방법!**\n내전 대기실 입장 후 \`\`!팀 N\`\` (EX !팀 2 > 듀오씩) 입력 시 음성채널에 있는 인원을 N명만큼 팀 나눠집니다 !\n[관전 적용된 인원은미포함] \n 해당 봇 저작권은 도비에게 있습니다. `
    );
    return;
  }
});

// 메시지 수정 시: (캐시에 row가 있는 경우만) 외출목록 A~C 갱신
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
