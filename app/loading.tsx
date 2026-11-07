/** What you see while a page gets its data (balances are read from the chain, so it can take a moment): calm shapes and a plain sentence. */
export default function Loading() {
  return (
    <div aria-busy="true" role="status">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton mt-3 h-4 w-full max-w-xl" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-28" style={{ animationDelay: `${i * 120}ms` }} />)}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="skeleton h-56" />
        <div className="skeleton h-56 lg:col-span-2" />
      </div>
      <p className="mt-6 text-center text-sm" style={{ color: "var(--tx-2)" }}>Getting things ready. This usually takes a moment.</p>
    </div>
  );
}
