// The sign-in wall for /chat. Sign-in is required (product decision), so this gate stands in front
// of the chat and shows, in order: a splash while auth resolves, a provider sign-in screen when
// signed out, a one-time profile form when a signed-in user has no profile yet, and the chat itself
// once both are satisfied. Everything here is themed to match the rest of the page.

import { useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { SylorStar } from './SylorStar';
import { ChatPage } from './ChatPage';
import type { ProfileDraft } from '../shared/profile';

/** Multicolor Google "G", inlined so we don't depend on a brand-icon set. */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** GitHub mark, inlined for the same reason. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.24-.02-2.25-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.31-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.18.77.84 1.23 1.91 1.23 3.23 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
    </svg>
  );
}

function Splash() {
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[#faf9f5] text-[#6b675e]">
      <SylorStar size={30} />
      <LoaderCircle className="h-5 w-5 animate-spin text-[#cf5535]" aria-hidden="true" />
    </div>
  );
}

function SignInScreen() {
  const { signInWithGoogle, signInWithGithub, error } = useAuth();
  const [busy, setBusy] = useState<null | 'google' | 'github'>(null);

  const run = async (which: 'google' | 'github') => {
    setBusy(which);
    try {
      await (which === 'google' ? signInWithGoogle() : signInWithGithub());
    } finally {
      setBusy(null);
    }
  };

  const btn =
    'flex w-full items-center justify-center gap-3 rounded-xl border border-[#e4e1d8] bg-white px-4 py-3 text-[15px] font-medium text-[#141413] transition-colors duration-150 hover:border-[#cbc6ba] hover:bg-[#fbfaf7] disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center bg-[#faf9f5] px-4 text-[#141413]">
      <div className="chat-in w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <SylorStar size={34} />
          <h1 className="font-display mt-4 text-[28px] font-normal leading-tight">Sign in to Sylor</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-[#6b675e]">
            Sylor learns who you are so its answers fit you. Sign in to start chatting.
          </p>
        </div>

        <div className="space-y-2.5">
          <button
            type="button"
            className={btn}
            disabled={busy !== null}
            onClick={() => run('google')}
          >
            {busy === 'google' ? (
              <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <GoogleG className="h-5 w-5" />
            )}
            Continue with Google
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy !== null}
            onClick={() => run('github')}
          >
            {busy === 'github' ? (
              <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <GithubMark className="h-5 w-5" />
            )}
            Continue with GitHub
          </button>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-[#e4b8a8] bg-[#f9ede8] px-3 py-2 text-[13px] leading-relaxed text-[#8a3b22]">
            {error}
          </p>
        ) : null}

        <p className="mt-6 text-center text-[12px] leading-relaxed text-[#9c988e]">
          A preview chat. Sylor’s full workspace runs in the app with your own model.
        </p>
      </div>
    </div>
  );
}

function ProfileForm() {
  const { user, saveProfile } = useAuth();
  const [name, setName] = useState(user?.displayName || '');
  const [nickname, setNickname] = useState((user?.displayName || '').trim().split(/\s+/)[0] || '');
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [about, setAbout] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const draft: ProfileDraft = { name, nickname, role, company, about };
      await saveProfile(draft);
      // On success the gate re-renders into the chat; no need to reset local state.
    } catch {
      setErr('Couldn’t save your profile. Check your connection and try again.');
      setSaving(false);
    }
  };

  const field =
    'w-full rounded-xl border border-[#e4e1d8] bg-white px-3.5 py-2.5 text-[15px] text-[#141413] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#9c988e] focus:border-[#cbc6ba] focus:shadow-[0_0_0_4px_rgba(207,85,53,0.10)]';
  const label = 'mb-1.5 block text-[13px] font-medium text-[#544f46]';

  return (
    <div className="flex h-[100dvh] flex-col overflow-y-auto bg-[#faf9f5] px-4 py-10 text-[#141413]">
      <div className="chat-in mx-auto w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <SylorStar size={30} />
          <h1 className="font-display mt-4 text-[26px] font-normal leading-tight">
            Tell Sylor about you
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-[#6b675e]">
            A few details so Sylor’s answers fit you. Short is fine — you can add more later.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="pf-name" className={label}>
              Name
            </label>
            <input
              id="pf-name"
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              autoComplete="name"
              required
            />
          </div>
          <div>
            <label htmlFor="pf-nick" className={label}>
              What should Sylor call you?
            </label>
            <input
              id="pf-nick"
              className={field}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="A nickname"
            />
          </div>
          <div>
            <label htmlFor="pf-role" className={label}>
              Your role
            </label>
            <input
              id="pf-role"
              className={field}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Frontend engineer, Founder, Student"
            />
          </div>
          <div>
            <label htmlFor="pf-company" className={label}>
              Company or team <span className="font-normal text-[#9c988e]">(optional)</span>
            </label>
            <input
              id="pf-company"
              className={field}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Where you work"
            />
          </div>
          <div>
            <label htmlFor="pf-about" className={label}>
              Anything else Sylor should know?{' '}
              <span className="font-normal text-[#9c988e]">(optional)</span>
            </label>
            <textarea
              id="pf-about"
              className={field + ' min-h-[84px] resize-y'}
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="Tools you use, how you like answers, what you’re building…"
            />
          </div>

          {err ? (
            <p className="rounded-lg border border-[#e4b8a8] bg-[#f9ede8] px-3 py-2 text-[13px] leading-relaxed text-[#8a3b22]">
              {err}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={!name.trim() || saving}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#cf5535] px-4 py-3 text-[15px] font-medium text-white transition-colors duration-150 hover:bg-[#b8482c] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#e0c4ba]"
          >
            {saving ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
            Start chatting
          </button>
        </form>
      </div>
    </div>
  );
}

export function SignInGate() {
  const { user, profile, byok, loading, profileLoading, signOutUser } = useAuth();

  if (loading || (user && profileLoading)) return <Splash />;
  if (!user) return <SignInScreen />;
  if (!profile) return <ProfileForm />;
  return <ChatPage profile={profile} byok={byok} onSignOut={signOutUser} />;
}
