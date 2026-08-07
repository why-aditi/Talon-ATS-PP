import type { Metadata } from 'next';
import { SignInForm, SignInHero } from '../../components/sign-in';

export const metadata: Metadata = { title: 'Sign in · Talon' };

export default function SignInPage() {
  // 747/693 at 1440, measured off 01-sign-in@2x.png. The hero collapses below lg —
  // it is decoration, and the form is the whole job of the screen.
  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-[747fr_693fr]">
      <SignInHero />
      <SignInForm />
    </main>
  );
}
