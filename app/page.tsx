import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8 text-center">
      <div>
        <h1 className="text-4xl font-bold mb-2">Enke POS Documentation</h1>
        <p className="text-lg text-gray-500">
          Everything you need to know about using Enke POS and the Admin Panel.
        </p>
      </div>
      <div className="flex gap-4 flex-wrap justify-center">
        <Link
          href="/docs/pos-app"
          className="rounded-lg border px-6 py-3 font-medium hover:bg-gray-50 transition-colors"
        >
          POS App Guide →
        </Link>
        <Link
          href="/docs/admin-panel"
          className="rounded-lg border px-6 py-3 font-medium hover:bg-gray-50 transition-colors"
        >
          Admin Panel Guide →
        </Link>
      </div>
    </main>
  );
}
