import Link from 'next/link';
import { Plane, ArrowRight } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-ink-950 p-6 relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[640px] h-[640px] rounded-full bg-primary-600/20 blur-[140px]" />

      <div className="relative max-w-2xl text-center space-y-8">
        <div className="flex justify-center">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-500 to-primary-800 flex items-center justify-center shadow-glow">
            <Plane className="w-7 h-7 text-white -rotate-45" strokeWidth={2} />
          </div>
        </div>
        <p className="eyebrow justify-center flex">Enterprise Email Operations</p>
        <h1 className="text-5xl md:text-7xl font-semibold tracking-tight text-white">
          MailPilot <span className="text-primary-400">Admin</span>
        </h1>
        <p className="text-xl text-gray-400 leading-relaxed max-w-xl mx-auto">
          The centralized control deck for enterprise email performance — monitor efficiency, track analytics, and
          keep every department flying on schedule.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
          <Link href="/dashboard" className="btn-primary text-base px-8 py-3 flex items-center gap-2">
            Enter Dashboard
            <ArrowRight className="w-4 h-4" />
          </Link>
          <button className="px-8 py-3 rounded-lg border border-white/10 text-gray-300 font-medium hover:bg-white/5 transition-colors">
            Contact Support
          </button>
        </div>
      </div>
    </div>
  );
}
