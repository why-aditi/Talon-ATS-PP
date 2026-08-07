import { redirect } from 'next/navigation';

// Jobs is the landing screen until the sign-in flow lands with step 4.
export default function Home() {
  redirect('/jobs');
}
