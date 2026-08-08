import { redirect } from 'next/navigation';

// Jobs is the landing screen. A signed-out visitor does not stop here: /jobs sits
// inside the (app) group, whose layout sends them to /sign-in.
export default function Home() {
  redirect('/jobs');
}
