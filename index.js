const Discord = require('discord.js');
const client = new Discord.Client();
const prefix = '!';

let latestTeams = []; // !팀 명령으로 구성된 최신 팀 정보를 저장

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('message', async message => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // !팀 명령어
// !팀 명령어
if (command === '팀') {
  const n = parseInt(args[0]);
  if (isNaN(n) || n < 1) return message.reply('올바른 인원 수를 입력해주세요.');

  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return message.reply('음성 채널에 들어가 주세요.');

  const SPECTATOR_TAG = /\[관전\]/i;

  // 봇, 관전 태그만 제외 (마이크 mute 조건 제거)
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
}



  // !시작 명령어 - 팀원 강제 이동
  if (command === '해산') {
    if (latestTeams.length === 0) {
      return message.reply('먼저 !팀 명령어로 팀을 구성해주세요.');
    }


    //순서대로 내전1부터 10까지 임
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
            console.error(`이동 실패: ${member.displayName}`, err.message);
          });
        }
      });
    });

    message.channel.send('모든 인원을 이동 시켰습니다!!! @here');
  }

  // !놀자 명령어
if (command === '놀자') {
  const maxMembers = 4;

  if (!message.member.voice.channel) {
    return message.reply('먼저 음성 채널에 들어가주세요!');
  }

  const voice = message.member.voice.channel;

  // 닉네임/서버닉네임에 [관전] 포함된 멤버 제거, 봇도 제외
  const SPECTATOR_TAG = /\[관전\]/i;
  const effectiveMembers = voice.members.filter(m => {
    const name = m.displayName || m.user.username || '';
    return !m.user.bot && !SPECTATOR_TAG.test(name);
  });

  const currentMembers = effectiveMembers.size;                 // 관전 제외 후 현재 인원
  const remainingMembers = Math.max(maxMembers - currentMembers, 0);

  // 초대 링크 생성 (1시간)
  const invite = await voice.createInvite({
    maxAge: 3600
  });

  const colors = ['#FF5733', '#C70039', '#900C3F', '#581845', '#2E86C1', '#2ECC71', '#F1C40F', '#8E44AD'];
  const selectedColor = colors[Math.floor(Math.random() * colors.length)];

  const inviteMessage = new Discord.MessageEmbed()
    .setTitle(`:loud_sound: ${voice.name} 여기 왕따 있어요!!!! \n${remainingMembers} 명 구인 구직 중이에요`)
    .setColor(selectedColor)
    .setFooter('해당링크는 1시간 후 자동으로 소멸됩니다.')
    .setTimestamp();

  message.channel.send(inviteMessage);
  message.channel.send(invite.url);
}

  // !사용법 명령어
  if (message.content === '!명령어') {
    message.channel.send(
      `**구인구직 사용방법!**\n음성채널 생성 후 \`\`!놀자\`\` 입력하면 자동으로 초대링크 생성\n\n` +
      `**팀 짜기 사용방법!**\n내전 대기실 입장 후 \`\`!팀 N\`\` (EX !팀 2 > 듀오씩) 입력 시 음성채널에 있는 인원을 N명만큼 팀 나눠집니다 !\n[관전 적용된 인원은미포함] \n 해당 봇 저작권은 도비에게 있습니다. `
    );
  }
});
client.login('MTA2NDgwMjk4NjkyMjA4NjQ4MA.GzgnvZ.aWgSucVaeuNXIAMFUel2QXawpLim6lnJvnhjlM');
