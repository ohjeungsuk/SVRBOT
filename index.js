// index.js (discord.js v12.5.3 + Google Sheets logger for "카톡외출목록")
// Required Heroku Config Vars:
// - DISCORD_TOKEN
// - GOOGLE_SA_JSON_B64
//
// Recommended Heroku dynos: worker=1, web=0 (avoid double running)

const Discord = require('discord.js');
const { google } = require('googleapis');

const client = new Discord.Client({
  partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});

const prefix = '!';
let latestTeams = []; // !팀 명령으로 구성된 최신 팀 정보를 저장

// ---- Google Sheets Settings ----
const TARGET_CHANNEL_ID = '1439239707320909895';
const SPREADSHEET_ID = '1aXIUb5yMA92s5EoYuyxf5IM8yFa_hryihUJDFIjsxyU';

// 여기에 기록할 시트 탭 이름
const SHEET_TITLE_FIXED = '카톡외출목록';

// message_id -> row number cache (dyno 재시작하면 초기화됨)
const msgRowCache = new Map();

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

  // private_key sometimes arrives with escaped newlines
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

// "한국시간" 문자열 (YYYY-MM-DD HH:mm:ss)
function formatKSTFromDate(dateObj) {
  // KST = UTC + 9, Korea has no DST
  const t = new Date(dateObj.getTime() + 9 * 60 * 60 * 1000);
  const iso = t.toISOString(); // shifted-utc
  // "YYYY-MM-DDTHH:mm:ss.sssZ" -> "YYYY-MM-DD HH:mm:ss"
  return iso.slice(0, 19).replace('T', ' ');
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
  // quote sheet title safely: '카톡외출목록'!A:D
  const safe = String(sheetTitle).replace(/'/g, "''");
  return "'" + safe + "'!" + a1;
}

// 입력 양식 파서
// 기대 형식:
// 닉네임: 도비/98/TEST
// 사유: 테스트입니다
// 기간: 언젠간
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

    // "키: 값" 형태만 받음
    const m = line.match(/^([^:]+)\s*:\s*(.*)$/);
    if (!m) continue;

    const key = String(m[1]).replace(/\s/g, ''); // 공백 제거
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
  console.log('[Sheets] SheetTitle(Fixed):', SHEET_TITLE);
}

function extractRowNumberFromUpdatedRange(updatedRange) {
  // example: "'카톡외출목록'!A12:D12" or "카톡외출목록!A12:D12"
  if (!updatedRange) return null;
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

// 카톡외출목록에 행 추가: 닉네임/사유/기간/등록시간(KST)
async function appendLeaveRow(message) {
  await initSheets();

  const parsed = parseLeaveForm(message.content);
  if (!parsed) {
    console.log(
      '[Leave][Skip] format not matched',
      'cid=' + message.channel.id,
      'mid=' + message.id,
      'content=' + safeShort(message.content, 120)
    );
    return;
  }

  const registeredAtKST = formatKSTFromDate(message.createdAt);

  // 시트 컬럼: 닉네임 | 사유 | 기간 | 등록시간
  const row = [parsed.nickname, parsed.reason, parsed.period, registeredAtKST];

  const range = a1Range(SHEET_TITLE, 'A:D');

  console.log(
    '[Leave][Append] try',
    'mid=' + message.id,
    'nick=' + safeShort(parsed.nickname, 30),
    'time(KST)=' + registeredAtKST
  );

  const res = await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  const updatedRange =
    res && res.data && res.data.updates ? res.data.updates.updatedRange : null;

  const rowNum = extractRowNumberFromUpdatedRange(updatedRange);
  if (rowNum) msgRowCache.set(String(message.id), rowNum);

  console.log(
    '[Leave][Append] ok',
    'mid=' + message.id,
    'row=' + (rowNum ? rowNum : 'unknown'),
    'updatedRange=' + (updatedRange ? updatedRange : 'null')
  );
}

// 메시지 수정 시 (dyno 재시작 전/캐시 있는 경우에만) A~C 업데이트
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

  // 등록시간(D)은 최초 작성 시간으로 유지, A~C만 업데이트
  const range = a1Range(SHEET_TITLE, 'A' + rowNum + ':C' + rowNum);

  console.log(
    '[Leave][Edit] try',
    'mid=' + message.id,
    'row=' + rowNum
  );

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[parsed.nickname, parsed.reason, parsed.period]],
    },
  });

  console.log('[Leave][Edit] ok', 'mid=' + message.id, 'row=' + rowNum);
}

// ---- Global Error Logs (Heroku logs에 반드시 찍히게) ----
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

// 메시지 작성 시: 타겟 채널(또는 스레드) + 양식이면 시트에 기록
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

  // !팀 명령어
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

  // !해산 명령어 - 팀원 강제 이동
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

  // !놀자 명령어
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

// 메시지 수정 시: (캐시에 row가 있는 경우만) A~C 갱신
client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (!newMessage) return;

    if (newMessage.partial) {
      try { newMessage = await newMessage.fetch(); } catch (e) { return; }
    }

    if (!newMessage.author || newMessage.author.bot) return;
    if (!isTargetChannelOrThread(newMessage)) return;

    console.log(
      '[MSG_EDIT] recv',
      'cid=' + newMessage.channel.id,
      'parent=' + (newMessage.channel.parentID ? newMessage.channel.parentID : 'none'),
      'mid=' + newMessage.id,
      'content=' + safeShort(newMessage.content, 140)
    );

    enqueueSheetJob(() => updateLeaveRowFromEdit(newMessage));
  } catch (e) {
    console.error('[messageUpdate handler error]', e && e.stack ? e.stack : e);
  }
});

client.login(getEnv('DISCORD_TOKEN'));
