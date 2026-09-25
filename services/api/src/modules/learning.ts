import type { HandlerMap } from '../context.js';
import { body, params, requireUser } from '../context.js';
import { notFound } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { requireWorker } from '../auth/rbac.js';

interface Question { id: string; question: string; choices: string[]; answer: number }
interface CourseDef {
  id: string; title: string; category: string; summary: string; durationMinutes: number; grantsSkill?: string; validMonths: number;
  lessons: { title: string; body: string }[]; questions: Question[]; passScore: number;
}

// Operational guidance only. Nothing here constitutes medical, nursing or legal advice; content owners must review before release (DECISIONS_REQUIRED D-09).
export const COURSES: CourseDef[] = [
  {
    id: 'life_support_basic', title: '生活支援講習（基礎）', category: 'life_support', durationMinutes: 25, grantsSkill: 'life_support_training', validMonths: 12,
    summary: '買い物付き添い・生活支援の基本的な進め方、安全と配慮、してはいけないことを学びます。',
    lessons: [
      { title: '業務の範囲', body: '生活支援は、買い物の付き添い・荷物運び・簡単な手伝いなど、依頼内容に書かれた範囲だけを行います。身体介護（入浴・排泄・食事の介助）や医療的な行為、金銭の管理は行いません。範囲外の依頼を受けたら、丁寧に断り、アプリのメッセージで発注者に相談してください。' },
      { title: 'あいさつと本人確認', body: '到着したら名乗り、アプリに表示された依頼内容と相手の方を確認します。相手の方が不安そうな場合は、発注者の担当者名を伝えます。訪問先の室内には、依頼で必要な場合を除いて入りません。' },
      { title: '安全と体調の変化', body: '相手の方の体調が急に悪くなったと感じたら、ためらわず119番に通報し、その後アプリの「ヘルプ」から運営と発注者に知らせてください。あなたが診断や判断をする必要はありません。' },
      { title: '金銭と個人情報', body: '現金やカードを預からないことが原則です。支払いは相手の方ご本人が行います。自宅の様子・郵便物・書類などを撮影したり、SNSに投稿したりしてはいけません。写真は依頼で必要な証跡のみ撮影します。' },
    ],
    questions: [
      { id: 'q1', question: '買い物付き添い中に、相手の方から入浴の介助を頼まれました。どうしますか？', choices: ['できる範囲で手伝う', '依頼範囲外なので丁寧に断り、発注者に相談する', '無言で帰る'], answer: 1 },
      { id: 'q2', question: '相手の方の体調が急に悪くなったように見えます。最初に行うことは？', choices: ['119番に通報し、その後アプリで知らせる', '様子を見て業務を続ける', '自分で薬を買って渡す'], answer: 0 },
      { id: 'q3', question: '支払いのためにキャッシュカードを預かってほしいと言われました。', choices: ['暗証番号を聞いて預かる', '預からず、ご本人に支払っていただく', '家族の許可があれば預かる'], answer: 1 },
      { id: 'q4', question: '撮影してよい写真はどれですか？', choices: ['依頼で必要な証跡（購入品など）', '室内の様子', '郵便物'], answer: 0 },
      { id: 'q5', question: '依頼内容と違う作業を頼まれた場合の連絡手段は？', choices: ['個人の電話番号を交換する', 'アプリのメッセージで発注者に相談する', '連絡しない'], answer: 1 },
    ],
    passScore: 4,
  },
  {
    id: 'elderly_watch_basic', title: '見守り訪問講習（基礎）', category: 'elderly_watch', durationMinutes: 20, grantsSkill: 'elderly_watch_training', validMonths: 12,
    summary: '高齢者の見守り訪問で確認すること・記録の仕方・異変時の連絡を学びます。医療的な判断は含みません。',
    lessons: [
      { title: '見守り訪問とは', body: '見守り訪問は、依頼された方の安否や生活の様子を、決められた項目に沿って確認し記録する業務です。健康状態の診断や、服薬の指示などの医療的な判断は行いません。' },
      { title: '確認と記録', body: '依頼の手順にある項目（応答があるか、困りごとはないか等）を確認し、事実だけを簡潔に記録します。推測や評価（「認知症だと思う」等）は書きません。' },
      { title: '応答がない・異変があるとき', body: '訪問しても応答がない場合や、倒れている等の異変がある場合は、ためらわず119番・110番へ通報し、アプリの「危険を報告」から運営と発注者に知らせます。無理に室内へ入らないでください。' },
    ],
    questions: [
      { id: 'q1', question: '見守り訪問の記録として適切なのは？', choices: ['「インターホンに応答あり。困りごとは特になしとのこと」', '「認知症が進んでいると思う」', '記録しない'], answer: 0 },
      { id: 'q2', question: '訪問先で応答がなく、室内で倒れている様子が見えた。', choices: ['119番・110番に通報し、アプリで報告する', '窓を割って入る', '次の訪問先へ行く'], answer: 0 },
      { id: 'q3', question: '服薬について相談されました。', choices: ['自分の判断で量を伝える', '医師・薬剤師に相談するよう伝え、発注者に共有する', '薬を預かる'], answer: 1 },
      { id: 'q4', question: '見守り業務に含まれないものは？', choices: ['安否の確認', '決められた項目の記録', '健康状態の診断'], answer: 2 },
    ],
    passScore: 3,
  },
  {
    id: 'privacy_basics', title: '個人情報の取扱い講習', category: 'privacy', durationMinutes: 15, grantsSkill: 'privacy_training', validMonths: 24,
    summary: '配送先・訪問先の個人情報を守るための基本ルールを学びます。',
    lessons: [
      { title: '必要なときだけ見る', body: 'アプリに表示される住所や連絡先は、業務に必要なときだけ確認します。受取人の電話番号は、必要なときにだけ表示し、その記録は監査のために残ります。' },
      { title: '持ち出さない・共有しない', body: '住所や氏名をメモ帳・個人のメッセージアプリ・SNSに写したり、他人に伝えたりしてはいけません。業務終了後、端末に残る情報は自動で消去されます。' },
      { title: '写真の注意', body: '証跡写真には、表札・郵便物・他人の顔・車のナンバーが写らないよう注意します。アプリはアップロード時に位置情報などのメタデータを削除します。' },
    ],
    questions: [
      { id: 'q1', question: '配達先の住所を個人のメモアプリに控えてよいですか？', choices: ['よい', 'よくない'], answer: 1 },
      { id: 'q2', question: '置き配写真で避けるべきものは？', choices: ['荷物', '表札や郵便物', '玄関ドア'], answer: 1 },
      { id: 'q3', question: '受取人の電話番号を表示すると？', choices: ['記録が残る', '何も記録されない'], answer: 0 },
    ],
    passScore: 3,
  },
  {
    id: 'safe_delivery', title: '安全運転・配送マナー講習', category: 'delivery', durationMinutes: 15, grantsSkill: 'delivery_safety_training', validMonths: 12,
    summary: '運転中のスマートフォン操作禁止、駐停車、置き配のマナーを学びます。',
    lessons: [
      { title: '運転中は操作しない', body: '運転中のスマートフォン操作は法律で禁止されています。HappyDriveは走行中に複雑な操作を制限します。ルートの確認や完了報告は、安全な場所に停車してから行ってください。' },
      { title: '駐停車', body: '駐停車禁止場所や交差点付近に停めないでください。荷物の積み下ろしは短時間で行い、ハザードランプを点灯します。' },
      { title: '置き配', body: '置き配は、依頼や受取人の指定がある場合のみ行い、指定場所に置いた写真を記録します。雨の日は濡れないよう配慮します。' },
    ],
    questions: [
      { id: 'q1', question: '次の配達先を確認したくなりました。運転中です。', choices: ['信号待ちで操作する', '安全な場所に停車してから確認する'], answer: 1 },
      { id: 'q2', question: '置き配の記録に必要なものは？', choices: ['指定場所に置いた写真', '記録は不要'], answer: 0 },
      { id: 'q3', question: '荷物の積み下ろし中に点灯するのは？', choices: ['ハザードランプ', 'ハイビーム'], answer: 0 },
    ],
    passScore: 3,
  },
];

function addMonths(d: Date, m: number): string {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x.toISOString().slice(0, 10);
}

export const learningHandlers: HandlerMap = {
  async listCourses(ctx, req) {
    const u = requireUser(req);
    const skills = await ctx.db.query(`SELECT ws.skill_code, ws.valid_until::text, sd.name FROM worker_skills ws JOIN skill_definitions sd ON sd.code = ws.skill_code WHERE ws.worker_id = $1 AND ws.status = 'verified'`, [u.id]);
    const byCode = new Map(skills.rows.map((s) => [s.skill_code, s]));
    const names = await ctx.db.query('SELECT code, name FROM skill_definitions');
    const nameOf = new Map(names.rows.map((n) => [n.code, n.name]));
    const today = new Date().toISOString().slice(0, 10);
    return COURSES.map((c) => {
      const s = c.grantsSkill ? byCode.get(c.grantsSkill) : undefined;
      return {
        id: c.id, title: c.title, category: c.category, summary: c.summary, durationMinutes: c.durationMinutes, grantsSkill: c.grantsSkill,
        grantsSkillName: c.grantsSkill ? nameOf.get(c.grantsSkill) : undefined,
        completed: !!s && (!s.valid_until || s.valid_until >= today), skillValidUntil: s?.valid_until ?? undefined,
      };
    });
  },

  async getCourse(ctx, req) {
    const list = (await learningHandlers.listCourses!(ctx, req, undefined as never)) as any[];
    const c = COURSES.find((x) => x.id === params(req).courseId);
    if (!c) throw notFound('講習が見つかりません');
    return {
      ...list.find((x) => x.id === c.id),
      lessons: c.lessons,
      questions: c.questions.map(({ id, question, choices }) => ({ id, question, choices })),
      passScore: c.passScore,
    };
  },

  async submitQuizAttempt(ctx, req) {
    const u = requireUser(req);
    requireWorker(u);
    const c = COURSES.find((x) => x.id === params(req).courseId);
    if (!c) throw notFound('講習が見つかりません');
    const answers = new Map(body<{ answers: { questionId: string; choiceIndex: number }[] }>(req).answers.map((a) => [a.questionId, a.choiceIndex]));
    const incorrect = c.questions.filter((q) => answers.get(q.id) !== q.answer).map((q) => q.id);
    const score = c.questions.length - incorrect.length;
    const passed = score >= c.passScore;
    const res = await withIdempotency(ctx, req, 'submitQuizAttempt', async (tx) => {
      await tx.query('INSERT INTO course_attempts(worker_id, course_id, score, total, passed) VALUES ($1,$2,$3,$4,$5)', [u.id, c.id, score, c.questions.length, passed]);
      let grantedSkill;
      if (passed && c.grantsSkill) {
        const validUntil = addMonths(new Date(), c.validMonths);
        await tx.query(
          `INSERT INTO worker_skills(worker_id, skill_code, status, source, valid_until, verified_at) VALUES ($1,$2,'verified','training',$3, now())
           ON CONFLICT (worker_id, skill_code) DO UPDATE SET status = 'verified', source = 'training', valid_until = EXCLUDED.valid_until, verified_at = now(), note = NULL`,
          [u.id, c.grantsSkill, validUntil],
        );
        const name = (await tx.query('SELECT name FROM skill_definitions WHERE code = $1', [c.grantsSkill])).rows[0].name;
        grantedSkill = { code: c.grantsSkill, name, status: 'verified', source: 'training', validUntil };
      }
      await recordEvent(tx, { entityType: 'user', entityId: u.id, eventType: 'course_attempt', actor: { id: u.id, role: 'worker' }, payload: { courseId: c.id, score, passed } });
      return { status: 200, body: { passed, score, total: c.questions.length, grantedSkill, incorrectQuestionIds: incorrect } };
    });
    return res.body;
  },
};

