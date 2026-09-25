import { redirect } from 'next/navigation';
import { HOME_PATH } from '@/lib/config';

export default function Index() {
  redirect(HOME_PATH);
}
