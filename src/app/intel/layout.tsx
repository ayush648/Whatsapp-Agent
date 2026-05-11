import Link from "next/link";

export default function IntelLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-zinc-200 bg-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900">
            ← Chats
          </Link>
          <span className="text-zinc-300">|</span>
          <h1 className="font-semibold text-zinc-900">Intel</h1>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/intel/inbox"
              className="text-zinc-700 hover:text-zinc-900 hover:underline"
            >
              Inbox
            </Link>
            <Link
              href="/intel/tasks"
              className="text-zinc-700 hover:text-zinc-900 hover:underline"
            >
              Tasks
            </Link>
            <Link
              href="/intel/approvals"
              className="text-zinc-700 hover:text-zinc-900 hover:underline"
            >
              Approvals
            </Link>
            <Link
              href="/intel/audit"
              className="text-zinc-700 hover:text-zinc-900 hover:underline"
            >
              Audit
            </Link>
            <Link
              href="/intel/settings"
              className="text-zinc-700 hover:text-zinc-900 hover:underline"
            >
              Settings
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">{children}</main>
    </div>
  );
}
