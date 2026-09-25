import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Models } from './components/Models';
import { HowItWorks } from './components/HowItWorks';
import { Features } from './components/Features';
import { Pricing } from './components/Pricing';
import { Docs } from './components/Docs';
import { Footer } from './components/Footer';
import { ScrollCanvas } from './components/ScrollCanvas';
import { useReveals } from './lib/reveal';

export default function App() {
  // One IntersectionObserver for every [data-reveal] on the page.
  useReveals();

  return (
    <div id="top" className="flex min-h-screen flex-col">
      {/* Scroll-scrubbed warm backdrop, pinned behind everything (z-0). */}
      <ScrollCanvas />
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <Header />
      {/* Content rides above the canvas; sections stay transparent so it shows through. */}
      <main id="content" className="relative z-10 flex-1">
        <Hero />
        <Models />
        <HowItWorks />
        <Features />
        <Pricing />
        <Docs />
      </main>
      <div className="relative z-10">
        <Footer />
      </div>
    </div>
  );
}
