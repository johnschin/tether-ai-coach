import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Tether — AI Resilience Coaching for Organizational Change",
  description:
    "Tether is a confidential AI resilience coach helping employees navigate AI rollout, layoffs, restructuring, and burnout. Private beta now open for employers.",
  alternates: { canonical: "https://tetheredconsulting.com" },
  openGraph: {
    url: "https://tetheredconsulting.com",
    title: "Tether — AI Resilience Coaching for Organizational Change",
    description:
      "Confidential resilience coaching that helps employees navigate AI rollout, layoffs, restructuring, and burnout without burning out.",
  },
};

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Tether",
  url: "https://tetheredconsulting.com",
  description:
    "Confidential AI resilience coaching for employees navigating organizational change, AI rollout, layoffs, and workplace stress.",
  founder: [
    { "@type": "Person", name: "Dr. John Schinnerer", jobTitle: "Ph.D., Psychologist" },
    { "@type": "Person", name: "Joree Rose", jobTitle: "LMFT" },
  ],
  sameAs: [],
};

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
      />

      <section className="border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
          <div className="max-w-4xl">
            <div className="mb-4 inline-flex rounded-full border border-slate-200 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-600">
              Private beta for employers
            </div>

            <h1 className="text-4xl font-semibold tracking-tight text-slate-950 md:text-6xl">
              Support employees through AI anxiety, burnout, and workplace
              change.
            </h1>

            <p className="mt-6 max-w-3xl text-lg leading-8 text-slate-600 md:text-xl">
              Tether is a confidential resilience coach for employees navigating
              unstable work. It helps people process what they are carrying,
              regain steadiness, and adapt more effectively through AI rollout,
              layoffs, overload, and trust erosion.
            </p>

            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                href="/beta"
                className="inline-flex rounded-2xl bg-slate-900 px-6 py-4 text-sm font-medium text-white shadow-sm transition hover:opacity-90"
              >
                Request Beta Access
              </Link>

              <Link
                href="/how-it-works"
                className="inline-flex rounded-2xl border border-slate-300 px-6 py-4 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
              >
                See How It Works
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              Explore
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              Everything you need to evaluate Tether.
            </h2>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <Link
              href="/how-it-works"
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5"
            >
              <h3 className="text-xl font-semibold tracking-tight text-slate-950">
                How It Works
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                The psychology and frameworks behind Tether.
              </p>
            </Link>

            <Link
              href="/for-employers"
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5"
            >
              <h3 className="text-xl font-semibold tracking-tight text-slate-950">
                For Employers
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                The business case and where Tether fits.
              </p>
            </Link>

            <Link
              href="/privacy"
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5"
            >
              <h3 className="text-xl font-semibold tracking-tight text-slate-950">
                Privacy &amp; Trust
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Confidentiality, boundaries, and aggregated reporting.
              </p>
            </Link>

            <Link
              href="/faq"
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5"
            >
              <h3 className="text-xl font-semibold tracking-tight text-slate-950">
                FAQ
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Clear answers to the obvious questions.
              </p>
            </Link>
          </div>
        </div>
      </section>

      <section id="beta" className="mx-auto max-w-4xl px-6 py-20">
        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-8 shadow-sm md:p-12">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Beta access
          </p>

          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            Interested in piloting Tether at your firm?
          </h2>

          <p className="mt-5 text-lg leading-8 text-slate-600">
            We are inviting a small group of forward-thinking firms to help
            shape the beta.
          </p>

          <div className="mt-10">
            <Link
              href="/beta"
              className="inline-flex rounded-2xl bg-slate-900 px-6 py-4 text-sm font-medium text-white shadow-sm transition hover:opacity-90"
            >
              Request Beta Access
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
