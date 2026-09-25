import type { components } from '@happydrive/contracts';

/** 運営Web の Cookie 接頭辞（企業ポータルと localhost で衝突しないよう分ける） */
export const COOKIE_PREFIX = 'hda';
export const APP_NAME = '運営管理';
export const HOME_PATH = '/dashboard';

type Role = components['schemas']['Role'];
export const ADMIN_ROLES: readonly Role[] = ['admin_operator', 'admin_support', 'admin_auditor'];
/** 変更操作を画面に出すロール（監査は閲覧のみ。API 側でも拒否される） */
export const WRITE_ROLES: readonly Role[] = ['admin_operator', 'admin_support'];
