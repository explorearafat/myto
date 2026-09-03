import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Showcase } from './components/Showcase';
import { Features } from './components/Features';
import { Workspace } from './components/Workspace';
import { Faq } from './components/Faq';
import { Install } from './components/Install';
import { Footer } from './components/Footer';
import { useReveals } from './lib/reveal';

export default function App() {
  // One IntersectionObserver for every [data-reveal] on the page.
  useReveals();

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header />
      <main id="content" className="flex-1">
        <Hero />
        <Showcase />
        <Features />
        <Workspace />
        <Faq />
        <Install />
      </main>
      <Footer />
    </div>
  );
}
