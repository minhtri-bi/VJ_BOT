import {loadCases} from '../../scripts/evaluate_tutor.mjs';

const introduction = {id:'practical:v1:N5:introductions:situation', level:'N5'};
const open = {lesson:introduction, focus:null};
const greeting = 'Acknowledge the greeting briefly. Do not assign a task, ask a question, introduce yourself again, or fill a blank.';
const dislike = 'Explain why 好き cannot take ません. Give the negative pattern and one cue for the same sentence. Preserve “does not like fish”; do not rewrite it as hate or switch topics.';
const validSpeech = 'Accept 何も勉強してません as natural spoken Japanese. The full form is optional when describing register; never claim the spoken form is incorrect.';

const added = [
  {id:'bare-greeting', channels:['chat','live'], ...open, steps:[
    {message:'hi', check:'greeting', rubric:greeting}
  ]},
  {id:'practice-chips', channels:['chat','live'], ...open, steps:[
    {action:'start', message:'Cho em tập giới thiệu tên bằng tiếng Nhật.', rubric:'Start with one short, relevant name question.'},
    {message:'hi', check:'greeting', rubric:`${greeting} Do not replace the open practice target.`},
    {action:'explain', message:'Em muốn tự giải thích mẫu câu này bằng lời của em.', check:'no-welcome',
      rubric:'Ask the learner to explain one point of the self-introduction pattern. Do not lecture, give the answer, welcome again, or switch topics.'},
    {action:'situation', message:'Thầy cho em tình huống mới ở lớp tiếng Nhật để dùng cùng mẫu.', check:'no-welcome',
      rubric:'Give one concrete, new situation with the same name-introduction goal. Respect the setting if the learner supplied one. No answer, welcome, or unrelated exercise.'}
  ]},
  {id:'direct-meaning', channels:['chat','live'], ...open, steps:[
    {message:'たべよう nghĩa là gì thầy? Em chỉ muốn hiểu từ này.', check:'no-welcome',
      rubric:'Answer in one or two accessible Vietnamese sentences. Explain that as an invitation it can mean “ăn thôi / cùng ăn nhé”; a brief relevant Japanese example is optional. No romaji, filler, or unrelated exercise.'}
  ]},
  {id:'vietnamese-only-explanation', channels:['chat','live'], ...open, steps:[
    {message:'Vì sao trong câu tự giới thiệu mình không cần nhắc từ “tôi”? Giải thích bằng tiếng Việt thôi, không cần chữ Nhật hay bài tập.', check:'vietnamese-only',
      rubric:'Explain that context makes the speaker clear, so the subject may be omitted. Do not replace the explanation with a Japanese sentence or a new question.'}
  ]},
  {id:'same-sentence-repair', channels:['chat','live'], steps:[
    {message:'Em muốn nói là không thích cá. Em thử: 魚がすきません。 Thầy chỉ gợi ý để em tự sửa câu này, chưa đưa cả câu nhé.', check:'no-welcome', rubric:dislike}
  ]},
  {id:'spoken-contraction', channels:['chat','live'], steps:[
    {message:'Thầy xem câu này có tự nhiên khi nói không: 何も勉強してません。', check:'no-welcome', rubric:validSpeech}
  ]},
  {id:'live-assent', channels:['live'], steps:[
    {history:[{role:'assistant',text:'お店で買い物の練習をしましょうか。'}],message:'うん。',check:'no-welcome',
      rubric:'Treat うん as assent to the shopping roleplay. Start it directly, in one natural turn, without another greeting, asking permission again, or inserting a Vietnamese translation.'}
  ]},
  {id:'live-unclear-transcript', channels:['live'], steps:[
    {message:'えっと… [không rõ]',check:'no-welcome',
      rubric:'Ask the learner to repeat what was unclear. Do not infer a sentence, correct grammar or pronunciation, grade the learner, or start a new lesson.'}
  ]},
  {id:'live-japanese-only', channels:['live'], japaneseOnly:true, steps:[
    {message:'この文の「から」はどんな意味ですか。ベトナムから来ました。',check:'japanese-only',
      rubric:'Explain から as the place of origin in simple Japanese only. Do not add Vietnamese, a quiz, or meanings not relevant to this sentence.'}
  ]},
  {id:'live-pre-answer', channels:['live'], lesson:introduction, focus:{kind:'question',index:1}, steps:[
    {action:'hint', message:'Thầy gợi ý chỗ trống, em chưa thử. Đừng đưa đáp án.', check:'withhold-topic-particle',
      rubric:'Offer a small strategy without naming は, completing the sentence, eliminating answer choices, or treating the request as an attempt.'}
  ]},
  {id:'live-recall-pre-answer', channels:['live'], lesson:{id:'n5-teaching:v1:topic',level:'N5'},focus:{kind:'question',index:4}, steps:[
    {action:'hint',check:'withhold-topic-particle',
      rubric:'One helpful clue about what the sentence is about. Do not name は, complete the sentence, or claim the learner tried it.'}
  ]},
  {id:'new-valid-variant', channels:['live'], pack:'held-out', steps:[
    {message:'「水を飲みたいです」 có tự nhiên không? Em chỉ muốn hỏi chữ を.',check:'no-welcome',
      rubric:'Accept を in 水を飲みたいです; が is also possible. Do not insist on a single phrasing or imply the person already drank water.'}
  ]},
  {id:'evidence-based-recap', channels:['live'], pack:'held-out', steps:[
    {action:'summary',history:[{role:'user',text:'すみません、郵便局はどこですか。'}],check:'no-welcome',
      rubric:'Use the actual successful direction question as evidence. Do not invent a weakness, grade pronunciation, or ask a new question.'}
  ]},
  {id:'request-detail', channels:['live'], pack:'held-out', steps:[
    {message:'Thầy giải thích kỹ giúp em điểm khác nhau giữa 〜たい và 〜た. Em hay nhầm muốn làm với đã làm.',check:'no-welcome',
      rubric:'Explain want-to versus completed past action in Vietnamese. Contrast one pair with the same verb. Do not compress away the distinction, drift, or give an unrelated task.'}
  ]}
];

const reserved = new Set(['n3-repair-context','corpus-difficulty','authored-provenance']);
const regressionCases = new Set([
  'chat/partial-subgoal','chat/same-sentence-repair','live/same-sentence-repair',
  'live/bare-greeting','live/live-assent','live/live-unclear-transcript','live/live-japanese-only'
]);

export const casePacks = ['development','held-out','regression'];

export async function selectCases(pack) {
  if (!casePacks.includes(pack)) throw new Error('Unknown tutor evaluation pack.');
  return (await promptCases()).filter(item=>pack==='regression'
    ? regressionCases.has(`${item.channel}/${item.id}`) : item.pack===pack);
}

export async function promptCases() {
  const original = (await loadCases()).map(item => ({
    id:item.id, channel:'chat', level:item.level, lesson:item.lesson, focus:item.focus,
    pack:reserved.has(item.id) ? 'held-out' : 'development', rubric:item.rubric,
    steps:item.steps.map(step => ({...step, action:step.intent, rubric:step.expected_behavior.join(' ')}))
  }));
  return [...original, ...added.flatMap(({channels, ...item}) => channels.map(channel => ({
    level:'N5', pack:'development', ...item, channel,
    steps:item.steps.map((step,index) => ({id:`turn-${index+1}`, ...step}))
  })))];
}
