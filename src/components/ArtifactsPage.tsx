import { StrictMode } from 'react';
import { AuthProvider, useAuth } from '../lib/auth';
import {
  deleteArtifact,
  streamArtifacts,
  type CloudArtifact,
} from '../lib/social';
import { Header } from './Header';
import { Footer } from './Footer';
import { MytoMark } from './MytoMark';
import { useState, useEffect } from 'react';
import { armReveals } from '../lib/reveal';


armReveals();

function when(ms: number): string {
  if (!ms) return 'just now';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Tile({ a, onDelete }: { a: CloudArtifact; onDelete: () => void }) {
  const dataUrl = a.dataBase64 ? `data:${a.mime};base64,${a.dataBase64}` : a.url;
  const isImage = a.kind === 'image' || a.mime.startsWith('image/');
  const isVideo = a.kind === 'video' || a.mime.startsWith('video/');
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e9e6dd] bg-white">
      {isImage && dataUrl ? (
        <img src={dataUrl} alt={a.title} className="h-52 w-full object-cover" />
      ) : isVideo && dataUrl ? (
        <video src={dataUrl} controls className="h-52 w-full bg-[#141413] object-contain" />
      ) : isVideo && a.url ? (
        <video src={a.url} controls className="h-52 w-full bg-[#141413] object-contain" />
      ) : (
        <div className="grid h-28 w-full place-items-center bg-[#f0efe9] text-[13px] text-[#9c988e]">
          {a.kind}
        </div>
      )}
      <div className="p-4">
        <p className="truncate text-[14px] font-semibold text-[#141413]" title={a.title}>
          {a.title}
        </p>
        <p className="mt-0.5 text-[12px] text-[#9c988e]">{when(a.createdAtMs)}</p>
        <div className="mt-3 flex items-center gap-2">
          <a
            href={dataUrl || a.url}
            download={`${a.title.replace(/[^\w.-]+/g, '_')}.${a.mime.split('/')[1] ?? 'bin'}`}
            className="rounded-full border border-[#e3e1d8] px-3.5 py-1.5 text-[12px] font-medium text-[#141413] no-underline transition-colors hover:border-[#c9c4b8]"
          >
            Download
          </a>
          <a
            href={a.url || dataUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full px-2.5 py-1.5 text-[12px] text-[#6b675e] transition-colors hover:text-[#141413]"
          >
            Open
          </a>
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto rounded-full px-2.5 py-1.5 text-[12px] text-[#9c988e] transition-colors hover:text-red-600"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function Vault() {
  const { user, loading } = useAuth();
  const [artifacts, setArtifacts] = useState<CloudArtifact[] | null>(null);

  useEffect(() => {
    if (!user) return;
    return streamArtifacts(user.uid, setArtifacts, () => setArtifacts([]));
  }, [user]);

  if (loading) return <Spinner label="Loading…" />;

  if (!user) {
    return (
      <div className="mx-auto max-w-md py-6">
        <div className="rounded-2xl border border-[#e9e6dd] bg-white p-7 text-center shadow-[0_24px_60px_-40px_rgba(20,20,19,0.35)]">
          <MytoMark size={36} className="mx-auto" />
          <h2 className="mt-4 font-display text-[22px] tracking-[-0.01em] text-[#141413]">
            Your artifact vault
          </h2>
          <p className="mx-auto mt-2 max-w-[40ch] text-[13.5px] leading-relaxed text-[#6b675e]">
            Sign in to see every image, video, and document your models produced — synced
            from the desktop app and the Android app.
          </p>
        </div>
      </div>
    );
  }

  if (artifacts == null) return <Spinner label="Loading the vault…" />;

  if (artifacts.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-[15px] text-[#141413]">The vault is empty.</p>
        <p className="mx-auto mt-2 max-w-[48ch] text-[13.5px] leading-relaxed text-[#9c988e]">
          Generate an image or video in a Myto chat (desktop or browser) and it lands here
          automatically — then downloads and syncs to the Android app.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {artifacts.map((a) => (
        <Tile key={a.id} a={a} onDelete={() => void deleteArtifact(a.id)} />
      ))}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return <p className="py-12 text-center text-[13.5px] text-[#9c988e]">{label}</p>;
}

export function ArtifactsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f5]">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header subpage />
      <main id="content" className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-6 pb-20 pt-14">
        <p className="eyebrow">Artifacts</p>
        <h1 className="mt-4 max-w-[24ch] font-display text-[44px] leading-[1.04] tracking-[-0.025em] text-[#141413] sm:text-[58px]">
          The vault of everything you generated.
        </h1>
        <p className="mt-5 max-w-[58ch] text-[18px] leading-relaxed text-[#544f46]">
          Images, video clips, SVGs, and documents your models produced — synced across the
          desktop app, the Android app, and this site. Download them, or open them in place.
        </p>
        <div className="mt-12">
          <Vault />
        </div>
      </main>
      <Footer subpage />
    </div>
  );
}
