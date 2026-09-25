import type { components } from '@happydrive/contracts';
import { toHalfWidth } from './geo';

export type OrganizationInput = components['schemas']['OrganizationInput'];
export type OrgKind = NonNullable<OrganizationInput['kind']>;

export interface OrgFormState {
  legalName: string;
  kind: OrgKind | '';
  corporateNumber: string;
  address: string;
  contact: string;
  representativeName: string;
}

export function emptyOrgForm(): OrgFormState {
  return { legalName: '', kind: 'company', corporateNumber: '', address: '', contact: '', representativeName: '' };
}

export function orgToForm(o: Partial<components['schemas']['Organization']>): OrgFormState {
  return {
    legalName: o.legalName ?? '',
    kind: (o.kind as OrgKind | undefined) ?? '',
    corporateNumber: o.corporateNumber ?? '',
    address: o.address ?? '',
    contact: o.contact ?? '',
    representativeName: o.representativeName ?? '',
  };
}

/** OrganizationInput の制約（legalName 2〜120、法人番号13桁、住所・連絡先 4〜200、代表者 1〜100） */
export function validateOrgForm(f: OrgFormState): { value?: OrganizationInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const legalName = f.legalName.trim();
  const address = f.address.trim();
  const contact = f.contact.trim();
  const representativeName = f.representativeName.trim();
  const corporateNumber = toHalfWidth(f.corporateNumber).replace(/[\s-]/g, '');
  const n = (s: string) => Array.from(s).length;

  if (!legalName) errors.legalName = '正式名称を入力してください。';
  else if (n(legalName) < 2 || n(legalName) > 120) errors.legalName = '正式名称は2〜120文字で入力してください。';
  if (corporateNumber && !/^[0-9]{13}$/.test(corporateNumber)) errors.corporateNumber = '法人番号は13桁の数字で入力してください。';
  if (!address) errors.address = '所在地を入力してください。';
  else if (n(address) < 4 || n(address) > 200) errors.address = '所在地は4〜200文字で入力してください。';
  if (!contact) errors.contact = '公開連絡先を入力してください。';
  else if (n(contact) < 4 || n(contact) > 200) errors.contact = '公開連絡先は4〜200文字で入力してください。';
  if (!representativeName) errors.representativeName = '代表者名を入力してください。';
  else if (n(representativeName) > 100) errors.representativeName = '代表者名は100文字以内で入力してください。';
  if (f.kind && !['company', 'municipality', 'npo', 'other'].includes(f.kind)) errors.kind = '種別が正しくありません。';

  if (Object.keys(errors).length) return { errors };
  const value: OrganizationInput = { legalName, address, contact, representativeName };
  if (f.kind) value.kind = f.kind;
  if (corporateNumber) value.corporateNumber = corporateNumber;
  return { value, errors };
}
