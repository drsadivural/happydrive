// Realtime function tools. Each maps to an EXISTING read-only API endpoint that the iOS client calls with the
// driver's own credentials (VoiceToolDispatcher allowlist). No business logic is duplicated for voice.

export interface RealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const JOB_CATEGORIES = ['elderly_watch', 'life_support', 'shopping_assist', 'corporate_task', 'community_info', 'delivery_related'];

export const VOICE_TOOLS: RealtimeTool[] = [
  {
    type: 'function',
    name: 'get_today_overview',
    description: '今日の概要（配送件数と完了数、今日の業務、予定報酬、未読通知数、近くのおすすめ案件）を取得する。「今日の予定」などに使う。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'list_delivery_stops',
    description: '指定日の配送先一覧（順番・住所・時間指定・状態）を取得する。日付を省略すると今日。',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD（日本時間）' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_jobs',
    description: '近くの公開中のHappy案件を探す（受諾できるものを優先した上位数件）。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '案件名などのキーワード' },
        category: { type: 'string', enum: JOB_CATEGORIES },
        date: { type: 'string', description: 'YYYY-MM-DD（日本時間）' },
        sort: { type: 'string', enum: ['recommended', 'distance', 'starts_at', 'amount'] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_job_details',
    description: '案件の詳細（報酬の内訳、時間、場所の地域、必要な資格、キャンセル条件、受諾できるか）を取得する。jobId は search_jobs の結果のもの。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '案件ID（search_jobs の結果）' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_my_assignments',
    description: '自分が受諾した業務の一覧を取得する。active=進行中、upcoming=これから、history=履歴。',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['active', 'upcoming', 'history'] } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_earnings_summary',
    description: '月の報酬の集計（合計・振込済み・支払予定・検収待ち・見込み）を取得する。月を省略すると今月。',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_unread_notifications',
    description: '未読のお知らせ（承認・メッセージ・報酬確定など）を取得する。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

export const VOICE_TOOL_NAMES = VOICE_TOOLS.map((t) => t.name);
